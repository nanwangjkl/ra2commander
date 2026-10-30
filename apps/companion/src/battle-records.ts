import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { goalOwner, ownerId, type BattleRecord, type BattleRecordInfo, type CommandEvent, type CommandFeedback, type FeedbackRating, type CurrentCommands, type GoalSpec } from '@ra2c/contracts'
import type { TaskRuntime } from '@ra2c/runtime'
import { applyCommandEvent, type CardData } from '../ui/command-card.ts'
import { BattleJournal, atomicWrite, jsonValue, syncDirectory, type ArchiveEntry } from './battle-storage.ts'
import { decodeObservation, encodeObservation, fieldDelta } from './battle-codec.ts'

type Compilation = BattleRecord['compilations'][number] & { sessionKey: string }
type SummaryRecord = Omit<BattleRecord, 'observations'> & { observations: Array<Record<string, unknown>> }
type StoredRecord = SummaryRecord & { observationCount: number }
const RATINGS = { good: '符合预期', partial: '部分达成', bad: '不符合预期' }
const battleId = (key: string) => `battle-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`
const safeId = (id: string) => /^battle-[a-f0-9]{24}$/.test(id)
const canonicalId = (id: string) => id.replace(/^restored-/, '')
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** 本机复盘资料；内部保留轻量引用，完整读取时才展开正文，不进入任务恢复。 */
export class BattleRecords {
  private readonly folder: string
  private readonly cache = new Map<string, StoredRecord>()
  private readonly journals = new Map<string, BattleJournal>()
  private readonly fingerprints = new Map<string, { value: string; stages: string; tick: number }>()
  private readonly dirty = new Set<string>()
  private timer: NodeJS.Timeout | undefined
  private writer: NodeJS.Immediate | undefined
  private sessionKey = ''
  /** 未进局的命令只展示本次进程收到的，历史失败仍保留在归档里。 */
  private readonly unboundCommands = new Set<string>()
  private runtime: TaskRuntime | undefined
  warning = ''

  constructor(root: string, private readonly warn = console.error) { this.folder = join(root, '.runtime/battles') }
  get currentId(): string | null {
    const id = battleId(this.sessionKey || 'unbound')
    return this.sessionKey || this.unboundCommands.size ? id : null
  }
  setSession(key: string): void {
    if (this.sessionKey === key) return
    this.guarded(() => { if (this.runtime?.battleKey === this.sessionKey) this.capture(this.runtime, true); this.flush() })
    this.sessionKey = key
    this.unboundCommands.clear()
    this.guarded(() => { this.ensure(key); this.trimCache() })
  }
  private journal(id: string): BattleJournal {
    let journal = this.journals.get(id)
    if (!journal) { journal = new BattleJournal(join(this.folder, id)); this.journals.set(id, journal) }
    return journal
  }
  currentCommands(): CurrentCommands {
    const record = this.currentId ? this.readStored(this.currentId) : undefined
    const current = (commandId: string) => !!this.sessionKey || this.unboundCommands.has(commandId)
    return { battleId: record?.id ?? null, sessionKey: record?.sessionKey ?? null, events: record?.events.filter(event => current(event.commandId)) ?? [], feedback: record?.feedback.filter(item => current(item.commandId)) ?? [], warning: this.warning }
  }
  /** 卡片只恢复同局记录；旧转写缺少阶段事件时才用其目标/终态补足展示。 */
  commandHistory(key: string): { events: CommandEvent[]; transcripts: Array<Record<string, any>> } {
    const record = this.readStored(battleId(key || 'unbound'))
    if (!record) return { events: [], transcripts: [] }
    const objects = this.journal(record.id).objects
    const fields = ['requestId', 'text', 'at', 'sessionKey', 'source', 'plan', 'goals', 'choices', 'skipped', 'terminalStage', 'terminalError']
    return { events: record.events, transcripts: Object.values(record.transcripts).map(value => Object.fromEntries(fields.filter(key => key in value).map(key => [key, objects.unpack(value[key])]))) }
  }
  private guarded(work: () => void): void {
    try { work(); this.warning = '' }
    catch (error) { const warning = `对局记录保存失败：${String(error)}`; if (warning !== this.warning) this.warn(`[companion] ${warning}`); this.warning = warning }
  }
  private ensure(key: string): StoredRecord {
    const id = battleId(key || 'unbound'), existing = this.readStored(id)
    if (existing) return existing
    const record: StoredRecord = { schemaVersion: 3, id, sessionKey: key, startedAt: Date.now(), updatedAt: Date.now(), events: [], transcripts: {}, compilations: [], observations: [], observationCount: 0, feedback: [] }
    const firstFolder = !existsSync(this.folder)
    mkdirSync(join(this.folder, id), { recursive: true })
    if (firstFolder) { syncDirectory(this.folder); syncDirectory(join(this.folder, '..')); syncDirectory(join(this.folder, '../..')) }
    atomicWrite(join(this.folder, id, 'meta.json'), JSON.stringify({ ...this.info(record), schemaVersion: 3 }), true)
    this.cache.set(id, record)
    this.dirty.add(id)
    return record
  }
  private packFields(id: string, value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, this.journal(id).objects.pack(value, key)]))
  }
  private append(record: StoredRecord, kind: ArchiveEntry['kind'], value: unknown, durable = false, full = false): void {
    const plain = jsonValue(value) as Record<string, unknown>
    let encoded: unknown = plain
    if (kind === 'transcript' || kind === 'observation') {
      const packed = this.packFields(record.id, plain)
      const previous = kind === 'transcript' ? record.transcripts[canonicalId(String(plain.requestId))] ?? {} : record.observations.at(-1) ?? {}
      if (kind === 'transcript') {
        const delta = fieldDelta(previous, packed)
        if (!Object.keys(delta.patch).length && !delta.removed.length) return
        encoded = { requestId: plain.requestId, ...delta }
      } else encoded = encodeObservation(previous, packed, full, record.observationCount)
    } else if (kind === 'compilation') encoded = this.packFields(record.id, plain)
    const entry: ArchiveEntry = { schemaVersion: 3, kind, at: Date.now(), value: encoded }
    const journal = this.journal(record.id)
    journal.append(entry)
    if (durable) { try { journal.flush(true) } catch (error) { journal.discard(entry); throw error } }
    this.apply(record, entry)
    this.dirty.add(record.id)
    this.writer ??= setImmediate(() => { this.writer = undefined; this.flushEvents() })
    this.writer.unref()
    this.timer ??= setTimeout(() => { this.timer = undefined; this.guarded(() => this.flush()) }, 2000)
    this.timer.unref()
    if (journal.full) journal.flush()
  }
  private apply(record: StoredRecord, entry: ArchiveEntry, observation?: (value: Record<string, unknown>) => void): void {
    record.updatedAt = Math.max(record.updatedAt, entry.at)
    const raw = entry.value as Record<string, unknown>
    const value = (entry.schemaVersion ?? 1) >= 2 || entry.kind === 'event' || entry.kind === 'feedback' ? raw : Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value && typeof value === 'object' ? { $ra2cArchive: { raw: value } } : value]))
    if (entry.kind === 'event') record.events.push(value as unknown as CommandEvent)
    if (entry.kind === 'feedback') record.feedback.push(value as unknown as CommandFeedback)
    if (entry.kind === 'transcript') {
      if (typeof value.requestId !== 'string') throw new Error('转写记录缺少命令 ID')
      const id = canonicalId(value.requestId)
      if ((entry.schemaVersion ?? 1) >= 2) {
        const next = { ...record.transcripts[id], ...(value.patch as object) }
        for (const key of value.removed as string[]) delete next[key]
        record.transcripts[id] = next
      } else record.transcripts[id] = value
    }
    if (entry.kind === 'compilation') record.compilations.push(value as Compilation)
    if (entry.kind === 'observation') {
      if ((entry.schemaVersion ?? 1) >= 2) record.observations = [decodeObservation(record.observations.at(-1) ?? {}, value, record.observationCount, entry.schemaVersion)]
      else record.observations = [value]
      record.observationCount++
      const last = record.observations[0]!, battle = this.journal(record.id).objects.unpack(last.battle) as import('@ra2c/contracts').BattleStatus | undefined
      if (battle?.phase === 'ended' && battle.outcome) record.result = { outcome: battle.outcome, tick: Number(last.tick), evidence: battle.evidence }
      observation?.(record.observations[0]!)
    }
    record.schemaVersion = Math.max(record.schemaVersion, entry.schemaVersion ?? 1) as BattleRecord['schemaVersion']
  }
  event = (event: CommandEvent): void => this.guarded(() => {
    if (event.sessionKey === undefined && event.stage === 'received') return
    const key = event.sessionKey ?? this.sessionKey
    const commandId = canonicalId(event.commandId)
    this.append(this.ensure(key), 'event', { ...event, commandId })
    if (!key) this.unboundCommands.add(commandId)
    if (event.error || ['completed', 'failed', 'cancelled'].includes(event.stage) || event.execution && ['completed', 'failed', 'partial', 'faulted', 'cancelled'].includes(event.execution.state)) {
      if (this.runtime?.battleKey === key) this.capture(this.runtime, true)
      this.writeEvents()
    }
  })
  transcript = (value: Record<string, unknown>): void => this.guarded(() => { this.append(this.ensure(String(value.sessionKey ?? '')), 'transcript', value) })
  compilation = (value: Compilation): void => this.guarded(() => { this.append(this.ensure(value.sessionKey), 'compilation', { at: Date.now(), ...value }) })

  /** 日常观察合并到至少 60 游戏 tick；状态、错误、反馈与结束强制保留完整上下文。 */
  observe(runtime: TaskRuntime): void {
    this.runtime = runtime
    this.guarded(() => this.capture(runtime))
  }
  private capture(runtime: TaskRuntime, force = false): void {
    const snap = runtime.snapshot
    if (!snap) return
    const previous = this.fingerprints.get(snap.sessionKey)
    const stages = JSON.stringify([[...runtime.goals].map(([id, goal]) => [id, goal.status]), [...runtime.programs].map(([id, program]) => [id, program.status, program.compileError, program.stats.errors, program.stats.lastError]), runtime.factoryRallies.state.settings, snap.battle?.phase, snap.battle?.outcome])
    const full = force || !previous || previous.stages !== stages
    if (!full && snap.tick - previous.tick < 60) return
    const facts = {
      goals: [...runtime.goals].map(([id, goal]) => ({ id, ...goal, execution: runtime.goalExecution(id) })),
      formations: runtime.formations.list(), production: runtime.production,
      factoryRallies: runtime.factoryRallies.state,
      productionExits: runtime.productionExits.state.units,
      factoryBlockages: runtime.productionExits.state.blockages,
      exitYields: runtime.productionExits.state.yields,
      skillRuns: [...runtime.skillRuns.values()].map(({ source, ...run }) => run),
      exploration: [...runtime.exploration.progress.values()].map(progress => {
        const goal = runtime.goals.get(progress.goalId)?.spec, map = runtime.exploration.maps.get(progress.mapId)
        return { goalId: progress.goalId, mapId: map?.mapId, schemeId: map?.schemeId, schemeVersion: map?.schemeVersion,
          stalls: progress.stalls, failureStreak: progress.failureStreak, retryRounds: progress.retryRounds, rejected: progress.rejected,
          ...(goal?.kind === 'explore' ? { coverage: runtime.exploration.view(goal) } : {}) }
      }),
      programs: [...runtime.programs.values()].map(program => ({ id: program.id, status: program.status, goalIds: program.goalIds, activeGoalIds: program.activeGoalIds,
        script: program.script, compileError: program.compileError, errors: program.stats.errors, rejected: program.stats.rejected, lastError: program.stats.lastError })),
    }
    if (!full && !facts.goals.length && !facts.programs.length && !facts.factoryRallies.settings.length && snap.battle?.phase !== 'ended') return
    const observation = { credits: snap.credits, battle: snap.battle,
      map: { width: snap.mapWidth, height: snap.mapHeight }, power: snap.production?.power, queues: snap.production?.queues,
      self: snap.self.map(unit => ({ id: unit.id, name: unit.name, type: unit.type, rx: unit.rx, ry: unit.ry, elevation: unit.elevation, isIdle: unit.isIdle, canDeploy: unit.canDeploy, isDeployed: unit.isDeployed, harvester: unit.harvester, naval: unit.naval, speed: unit.speed, velocity: unit.velocity, zone: unit.zone, onBridge: unit.onBridge, hitPoints: unit.hitPoints, maxHitPoints: unit.maxHitPoints, ammo: unit.ammo, hasWrenchRepair: unit.hasWrenchRepair, transport: unit.transport })), visibleEnemies: snap.enemies,
      ...facts,
    }
    // 比较实际保存的战场内容；时间戳和采样序号不产生重复观察。
    const fingerprint = hash(observation)
    if (previous?.value === fingerprint) return
    this.append(this.ensure(snap.sessionKey), 'observation', { at: Date.now(), tick: snap.tick, ...observation }, false, full)
    this.fingerprints.set(snap.sessionKey, { value: fingerprint, stages, tick: snap.tick })
  }
  private readStored(id: string): StoredRecord | undefined {
    if (!safeId(id)) return undefined
    const cached = this.cache.get(id)
    if (cached) return cached
    const path = join(this.folder, id)
    if (!existsSync(join(path, 'meta.json'))) return undefined
    const meta = JSON.parse(readFileSync(join(path, 'meta.json'), 'utf8')) as BattleRecordInfo & { sessionKey: string; schemaVersion?: 1 | 2 | 3 }
    const record: StoredRecord = { schemaVersion: meta.schemaVersion ?? 1, id, sessionKey: meta.sessionKey, startedAt: meta.startedAt, updatedAt: meta.startedAt, events: [], transcripts: {}, compilations: [], observations: [], observationCount: 0, feedback: [] }
    for (const entry of this.journal(id).entries()) this.apply(record, entry)
    this.cache.set(id, record)
    this.trimCache(id)
    return record
  }
  read(id: string): BattleRecord | undefined {
    const stored = this.readStored(id)
    if (!stored) return undefined
    const journal = this.journal(id)
    journal.flush()
    // 历史观察只在显式完整读取时重建；写入缓存始终只留最新一份观察。
    const record: StoredRecord = { ...stored, events: [], feedback: [], transcripts: {}, compilations: [], observations: [], observationCount: 0, updatedAt: stored.startedAt }
    const observations: BattleRecord['observations'] = []
    for (const entry of journal.entries()) this.apply(record, entry, value => observations.push(journal.objects.unpack(value) as BattleRecord['observations'][number]))
    const { observationCount: _count, ...value } = record
    return { ...value, events: structuredClone(record.events), feedback: structuredClone(record.feedback),
      transcripts: Object.fromEntries(Object.entries(record.transcripts).map(([id, value]) => [id, journal.objects.unpack(value)])), compilations: journal.objects.unpack(record.compilations), observations } as BattleRecord
  }
  private summaryRecord(record: StoredRecord): SummaryRecord {
    const objects = this.journal(record.id).objects
    const pick = (value: Record<string, unknown>, fields: string[]) => Object.fromEntries(fields.filter(key => key in value).map(key => [key, objects.unpack(value[key])]))
    return { ...record,
      transcripts: Object.fromEntries(Object.entries(record.transcripts).map(([id, value]) => [id, pick(value, ['requestId', 'text', 'at', 'imported', 'error', 'plan'])])),
      compilations: record.compilations.map(value => {
        const fields = pick(value, ['id', 'goalIds', 'commandId', 'owner', 'stage', 'version', 'repair', 'attempt', 'errors', 'error', 'reason', 'code'])
        return { ...fields, id: String(fields.id), goalIds: fields.goalIds as string[] }
      }),
      observations: record.observations.length ? [pick(record.observations.at(-1)!, ['at', 'tick', 'credits', 'battle', 'power', 'formations', 'production'])] : [],
    }
  }
  private info(record: Pick<StoredRecord, 'id' | 'sessionKey' | 'startedAt' | 'updatedAt' | 'feedback' | 'events' | 'transcripts' | 'result'>): BattleRecordInfo & { sessionKey: string } {
    const latest = new Map(record.feedback.map(item => [item.commandId, item]))
    return { id: record.id, sessionKey: record.sessionKey, startedAt: record.startedAt, updatedAt: record.updatedAt,
      commands: new Set([...record.events.map(event => event.commandId), ...Object.keys(record.transcripts)]).size,
      feedback: latest.size, issues: [...latest.values()].filter(item => item.rating !== 'good').length, ...(record.result ? { result: record.result } : {}) }
  }
  list(): BattleRecordInfo[] {
    if (!existsSync(this.folder)) return []
    return readdirSync(this.folder).filter(safeId).flatMap(id => {
      try { const cached = this.cache.get(id); return [cached ? this.info(cached) : JSON.parse(readFileSync(join(this.folder, id, 'meta.json'), 'utf8')) as BattleRecordInfo] }
      catch (error) { this.warn(`[companion] 无法读取 ${id}：${String(error)}`); return [] }
    }).sort((a, b) => b.startedAt - a.startedAt)
  }
  feedback(id: string, commandId: string, rating: FeedbackRating, note: string): CommandFeedback {
    if (!Object.hasOwn(RATINGS, rating) || typeof note !== 'string' || note.length > 4000) throw new Error('反馈格式错误，备注最多 4000 字')
    const record = this.readStored(id)
    commandId = canonicalId(commandId)
    if (!record || (!record.transcripts[commandId] && !record.events.some(event => event.commandId === commandId))) throw new Error('找不到这条命令的对局记录')
    if (this.runtime?.battleKey === record.sessionKey) this.capture(this.runtime, true)
    const latest = new Map<string, CommandEvent>()
    for (const event of record.events.filter(event => event.commandId === commandId)) latest.set(`${event.goalId ?? ''}:${event.stage === 'execution' ? 'execution' : 'stage'}`, event)
    const value: CommandFeedback = { id: randomUUID(), at: Date.now(), commandId, rating, note: note.trim(), observed: [...latest.values()] }
    try { this.append(record, 'feedback', value, true) }
    catch (error) { this.guarded(() => { throw error }); throw error }
    this.guarded(() => this.flush())
    return value
  }
  private writeEvents(): void { for (const journal of this.journals.values()) journal.flush() }
  flushEvents(): void { this.guarded(() => this.writeEvents()) }
  flush(): void {
    this.writeEvents()
    for (const id of this.dirty) {
      const record = this.cache.get(id)!
      atomicWrite(join(this.folder, id, 'summary.md'), this.markdown(this.summaryRecord(record)))
      atomicWrite(join(this.folder, id, 'meta.json'), JSON.stringify({ ...this.info(record), schemaVersion: record.schemaVersion }), true)
      this.dirty.delete(id)
    }
  }
  private trimCache(keep?: string): void {
    for (const id of this.cache.keys()) {
      if (this.cache.size <= 2) break
      if (id === keep || id === this.currentId || this.dirty.has(id)) continue
      this.journals.get(id)?.flush(true)
      this.cache.delete(id); this.journals.delete(id)
    }
  }
  close(): void {
    if (this.writer) clearImmediate(this.writer); this.writer = undefined
    if (this.timer) clearTimeout(this.timer); this.timer = undefined
    this.guarded(() => { if (this.runtime) this.capture(this.runtime, true); this.flush(); for (const journal of this.journals.values()) journal.flush(true) })
    if (this.writer) clearImmediate(this.writer); this.writer = undefined
    if (this.timer) clearTimeout(this.timer); this.timer = undefined
  }

  /** 旧转写仅导入已保存内容，不覆盖已有记录，也不再作为新命令的写入路径。 */
  importTranscripts(root: string): void {
    const folder = join(root, '.runtime/transcripts')
    if (!existsSync(folder)) return
    const imported = new Map<string, Set<string>>()
    const files = readdirSync(folder).filter(file => file.endsWith('.json')).sort((a, b) => statSync(join(folder, a)).mtimeMs - statSync(join(folder, b)).mtimeMs)
    for (const file of files) this.guarded(() => {
      const value = JSON.parse(readFileSync(join(folder, file), 'utf8')) as Record<string, unknown>
      if (typeof value.requestId !== 'string' || typeof value.text !== 'string') return
      const key = String(value.sessionKey ?? ''), target = battleId(key || 'unbound'), id = canonicalId(value.requestId)
      let known = imported.get(target)
      if (!known) {
        known = new Set(Object.keys(this.cache.get(target)?.transcripts ?? {}))
        if (!this.cache.has(target)) for (const entry of new BattleJournal(join(this.folder, target)).entries('transcript')) {
          const value = entry.value as { requestId?: string }
          if (typeof value.requestId === 'string') known.add(canonicalId(value.requestId))
        }
        imported.set(target, known)
      }
      if (known.has(id)) return
      const record = this.ensure(key)
      known.add(id)
      this.append(record, 'transcript', { ...value, imported: true })
      if (typeof value.at === 'number') record.startedAt = Math.min(record.startedAt, value.at)
      const base = { commandId: id, source: 'restored' as const, at: Number(value.at) || Date.now(), seq: 0, sessionKey: record.sessionKey }
      this.append(record, 'event', { ...base, stage: 'received', text: value.text })
      const plan = value.plan as { summary?: string } | undefined
      if (plan?.summary) this.append(record, 'event', { ...base, stage: 'understood', summary: plan.summary })
      for (const goal of (value.goals ?? []) as GoalSpec[]) this.append(record, 'event', { ...base, stage: 'bound', goalId: goal.id, owner: ownerId(goalOwner(goal)), choice: goal.rawText })
      if (['completed', 'failed', 'cancelled'].includes(String(value.terminalStage))) this.append(record, 'event', { ...base, stage: value.terminalStage, error: value.terminalError })
      if (this.cache.size > 2) { this.flush(); this.trimCache(record.id) }
    })
    this.guarded(() => this.flush())
  }
  summary(id: string, inlineCode = false): string | undefined {
    const record = this.readStored(id)
    return record ? this.markdown(this.summaryRecord(record), { inlineCode }) : undefined
  }
  markdown(record: SummaryRecord, { inlineCode = false }: { inlineCode?: boolean } = {}): string {
    const fence = (value: string, lang = '') => { const ticks = '`'.repeat(Math.max(3, ...[...value.matchAll(/`+/g)].map(match => match[0].length + 1))); return `${ticks}${lang}\n${value}\n${ticks}` }
    const labels: Record<string, string> = { received: '已收到', understanding: '理解中', queued: '等待前序指令', understood: '已理解', binding: '绑定中', bound: '待生效', generating: '生成中', merged: '等待合并', effective: '脚本已生效', pending: '等待就绪', completed: '已完成', running: '执行中', continuous: '持续执行', paused: '暂停', faulted: '运行出错', blocked: '执行受阻', cancelled: '已取消', failed: '失败', partial: '部分执行', 'partial-completed': '部分完成' }
    const info = this.info(record)
    const resultLine = record.result ? `对局结果：${record.result.outcome === 'victory' ? '胜利' : '失败'}（公开玩家状态确认，tick ${record.result.tick}）` : '对局结果：未记录；不根据最后敌人消失或断连猜测胜负'
    const lines = ['# 对局记录', '', `对局：${record.sessionKey || '未进入对局'}`, `开始：${new Date(record.startedAt).toLocaleString('zh-CN')}`, `最后记录：${new Date(record.updatedAt).toLocaleString('zh-CN')}`, `命令 ${info.commands} 条，已反馈 ${info.feedback} 条，其中待改进 ${info.issues} 条。`, '', '执行结果来自最后观察到的游戏事实；游戏关闭后不推断完成或胜负。用户反馈单独保留。', '完整请求、响应、状态变化与反馈在同目录 events.jsonl 中，供开发复盘使用。', '']
    lines.splice(6, 0, resultLine)
    const ids = new Set([...record.events.map(event => event.commandId), ...Object.keys(record.transcripts)])
    const commandAt = (id: string) => Number(record.transcripts[id]?.at ?? record.events.find(event => event.commandId === id)?.at ?? 0)
    for (const id of [...ids].sort((a, b) => commandAt(a) - commandAt(b))) {
      const events = record.events.filter(event => event.commandId === id)
      const transcript = record.transcripts[id]
      lines.push(`## ${String(transcript?.text ?? events.find(event => event.text)?.text ?? id).replace(/\n/g, ' ')}`, '', `命令 ID：${id}`)
      const summary = events.filter(event => event.summary).at(-1)?.summary ?? (transcript?.plan as { summary?: string } | undefined)?.summary
      if (summary) lines.push(`理解与实际选择：${summary}`)
      if (transcript?.imported) lines.push('此命令由旧转写迁入；缺失的代码与执行成果无法补回。')
      if (transcript?.error) lines.push(`错误：${String(transcript.error)}`)
      let card: CardData | undefined
      // 原 seq 在重启后可能从头计数；归档按追加顺序回放，和侧栏本地序号一致。
      events.forEach((event, index) => { card = applyCommandEvent({ ...event, seq: index + 1 }, card) })
      if (card) {
        lines.push(`- 命令：${labels[card.stage] ?? card.stage}${card.error ? `；${card.error}` : ''}`)
        for (const [goalId, goal] of card.goals) {
          const execution = goal.execution, state = execution?.state ?? goal.stage
          lines.push(`- ${goalId}${goal.executionMode === 'native' ? '（本机执行）' : ''}：${state === 'partial' ? '部分完成' : labels[state] ?? state}${execution?.detail ? `，${execution.detail}` : ''}${execution?.progress ? `（${execution.progress.completed}/${execution.progress.total}）` : ''}${goal.error ? `；${goal.error}` : ''}`)
        }
      }
      const errors = new Set(events.filter(event => event.error && event.stage !== 'merged').map(event => event.error!))
      for (const error of errors) lines.push(`- 过程错误／未执行项：${error}`)
      const goals = new Set(events.flatMap(event => event.goalId ? [event.goalId] : []))
      const compiles = [...new Set(record.compilations.filter(item => item.commandId === id || item.goalIds.some(goal => goals.has(goal))).map(item => item.id))]
      if (compiles.length) lines.push(`关联脚本生成：${compiles.join('、')}（见下方脚本引用）`)
      for (const feedback of record.feedback.filter(item => item.commandId === id)) lines.push(`用户反馈（${new Date(feedback.at).toLocaleString('zh-CN')}）：${RATINGS[feedback.rating]}${feedback.note ? `；${feedback.note}` : ''}`)
      lines.push('')
    }
    lines.push('## 脚本与生成过程', '')
    for (const id of new Set(record.compilations.map(item => item.id))) {
      const events = record.compilations.filter(item => item.id === id)
      const last = events.at(-1)!
      lines.push(`### ${id}`, '', `控制对象：${String(last.owner)}；目标：${last.goalIds.join('、')}；结果：${String(last.stage)}${last.version ? ` v${last.version}` : ''}${last.repair ? '；自动修复' : ''}`, '')
      for (const event of events.filter(item => item.stage === 'validation' || item.stage === 'failed' || item.stage === 'discarded')) lines.push(`尝试 ${String(event.attempt ?? '')}：${JSON.stringify(event.errors ?? event.error ?? event.reason ?? '校验通过')}`)
      const code = [...events].reverse().find(item => typeof item.code === 'string')?.code
      if (typeof code === 'string') {
        const path = this.journal(record.id).objects.textPath(code)
        if (path && !inlineCode) lines.push('', `[脚本正文](${path})`, '')
        else lines.push('', fence(code, 'js'), '')
      }
    }
    const observation = record.observations.at(-1)
    if (observation) {
      lines.push('## 最后观察到的成果与态势', '', `游戏 tick：${String(observation.tick)}；资金：${String(observation.credits)}`)
      if (observation.power) lines.push(`电力：${JSON.stringify(observation.power)}`)
      const production = Array.isArray(observation.production) ? observation.production.map(record => {
        const region = record.placementRegion
        return { ...record, ...(region ? { placementRegion: { id: region.id, name: region.name } } : {}) }
      }) : observation.production
      lines.push('', '编队与生产记录（提交和实际产出分别记录，分区边界保存在完整归档中）：', '', fence(JSON.stringify({ formations: observation.formations, production }, null, 2), 'json'), '')
    }
    return `${lines.join('\n')}\n`
  }
}
