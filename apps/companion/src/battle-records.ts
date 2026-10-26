import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BattleRecord, BattleRecordInfo, CommandEvent, CommandFeedback, FeedbackRating, CurrentCommands } from '@ra2c/contracts'
import type { TaskRuntime } from '@ra2c/runtime'
import { applyCommandEvent, type CardData } from '../ui/command-card.ts'

type Compilation = BattleRecord['compilations'][number] & { sessionKey: string }
type Entry = { kind: 'event' | 'transcript' | 'compilation' | 'observation' | 'feedback'; at: number; value: unknown }
const RATINGS = { good: '符合预期', partial: '部分达成', bad: '不符合预期' }
const battleId = (key: string) => `battle-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`
const safeId = (id: string) => /^battle-[a-f0-9]{24}$/.test(id)
const canonicalId = (id: string) => id.replace(/^restored-/, '')
const atomicWrite = (path: string, text: string) => { const temp = `${path}.tmp`; writeFileSync(temp, text, { mode: 0o600 }); renameSync(temp, path) }

/** 只读复盘资料，与恢复运行的 state.json 完全分离；不重放动作。 */
export class BattleRecords {
  private readonly folder: string
  private readonly cache = new Map<string, BattleRecord>()
  private readonly fingerprints = new Map<string, string>()
  private readonly dirty = new Set<string>()
  private readonly tails = new Map<string, { offset: number; text: string; valid: boolean }>()
  private timer: NodeJS.Timeout | undefined
  private sessionKey = ''
  warning = ''

  constructor(root: string, private readonly warn = console.error) {
    this.folder = join(root, '.runtime/battles')
  }
  get currentId(): string | null {
    const id = battleId(this.sessionKey || 'unbound')
    return this.sessionKey || existsSync(join(this.folder, id, 'meta.json')) ? id : null
  }
  setSession(key: string): void {
    if (this.sessionKey === key) return
    this.sessionKey = key
    this.guarded(() => { this.ensure(key) })
  }
  currentCommands(): CurrentCommands {
    const record = this.currentId ? this.read(this.currentId) : undefined
    return { battleId: record?.id ?? null, sessionKey: record?.sessionKey ?? null, events: record?.events ?? [], feedback: record?.feedback ?? [], warning: this.warning }
  }
  private guarded(work: () => void): void {
    try { work(); this.warning = '' }
    catch (error) { const warning = `对局记录保存失败：${String(error)}`; if (warning !== this.warning) this.warn(`[companion] ${warning}`); this.warning = warning }
  }
  private ensure(key: string): BattleRecord {
    const id = battleId(key || 'unbound')
    const existing = this.read(id)
    if (existing) return existing
    const record: BattleRecord = { schemaVersion: 1, id, sessionKey: key, startedAt: Date.now(), updatedAt: Date.now(), events: [], transcripts: {}, compilations: [], observations: [], feedback: [] }
    mkdirSync(join(this.folder, id), { recursive: true })
    atomicWrite(join(this.folder, id, 'meta.json'), JSON.stringify(this.info(record)))
    atomicWrite(join(this.folder, id, 'summary.md'), this.markdown(record))
    this.cache.set(id, record)
    return record
  }
  private append(record: BattleRecord, kind: Entry['kind'], value: unknown, durable = false): void {
    const entry: Entry = { kind, at: Date.now(), value: structuredClone(value) }
    const path = join(this.folder, record.id, 'events.jsonl')
    const tail = this.tails.get(record.id)
    if (tail) {
      if (tail.valid) appendFileSync(path, '\n')
      else { writeFileSync(`${path}.incomplete`, tail.text, { mode: 0o600 }); truncateSync(path, tail.offset) }
      this.tails.delete(record.id)
    }
    // 一次追加一行；崩溃后最多忽略最后一条未写完整的记录。
    const fd = openSync(path, 'a', 0o600)
    try { appendFileSync(fd, `${JSON.stringify(entry)}\n`); if (durable) fsyncSync(fd) } finally { closeSync(fd) }
    this.apply(record, entry)
    this.dirty.add(record.id)
    this.timer ??= setTimeout(() => { this.timer = undefined; this.guarded(() => this.flush()) }, 2000)
    this.timer.unref()
  }
  private apply(record: BattleRecord, entry: Entry): void {
    record.updatedAt = Math.max(record.updatedAt, entry.at)
    if (entry.kind === 'event') record.events.push(entry.value as CommandEvent)
    if (entry.kind === 'transcript') {
      const value = entry.value as Record<string, unknown>
      record.transcripts[canonicalId(String(value.requestId))] = value
    }
    if (entry.kind === 'compilation') record.compilations.push(entry.value as Compilation)
    if (entry.kind === 'observation') record.observations.push(entry.value as BattleRecord['observations'][number])
    if (entry.kind === 'feedback') record.feedback.push(entry.value as CommandFeedback)
  }
  event = (event: CommandEvent): void => this.guarded(() => {
    // HTTP 接收事件尚无对局信息；runTranscript 随即用已固定的对局标识补发 received。
    if (event.sessionKey === undefined && event.stage === 'received') return
    const key = event.sessionKey ?? this.sessionKey
    this.append(this.ensure(key), 'event', { ...event, commandId: canonicalId(event.commandId) })
  })
  transcript = (value: Record<string, unknown>): void => this.guarded(() => {
    const record = this.ensure(String(value.sessionKey ?? ''))
    this.append(record, 'transcript', value)
  })
  compilation = (value: Compilation): void => this.guarded(() => { this.append(this.ensure(value.sessionKey), 'compilation', { at: Date.now(), ...value }) })

  /** 沿用宿主已经获取的快照，只在目标、生产、归属或故障事实变化时落盘。 */
  observe(runtime: TaskRuntime): void {
    if (!runtime.snapshot) return
    this.guarded(() => {
      const snap = runtime.snapshot!
      const facts = {
        goals: [...runtime.goals].map(([id, goal]) => ({ id, ...goal, execution: runtime.goalExecution(id) })),
        formations: runtime.formations.list(), production: runtime.production,
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
      if (!facts.goals.length && !facts.programs.length) return
      const fingerprint = JSON.stringify(facts)
      if (this.fingerprints.get(snap.sessionKey) === fingerprint) return
      this.append(this.ensure(snap.sessionKey), 'observation', { at: Date.now(), tick: snap.tick, credits: snap.credits,
        map: { width: snap.mapWidth, height: snap.mapHeight }, power: snap.production?.power, queues: snap.production?.queues,
        self: snap.self.map(unit => ({ id: unit.id, name: unit.name, rx: unit.rx, ry: unit.ry, hitPoints: unit.hitPoints, maxHitPoints: unit.maxHitPoints, ammo: unit.ammo, hasWrenchRepair: unit.hasWrenchRepair, transport: unit.transport })), visibleEnemies: snap.enemies,
        ...facts,
      })
      this.fingerprints.set(snap.sessionKey, fingerprint)
    })
  }
  read(id: string): BattleRecord | undefined {
    if (!safeId(id)) return undefined
    const cached = this.cache.get(id)
    if (cached) return cached
    const path = join(this.folder, id)
    if (!existsSync(join(path, 'meta.json'))) return undefined
    const meta = JSON.parse(readFileSync(join(path, 'meta.json'), 'utf8')) as BattleRecordInfo & { sessionKey: string }
    const record: BattleRecord = { schemaVersion: 1, id, sessionKey: meta.sessionKey, startedAt: meta.startedAt, updatedAt: meta.startedAt, events: [], transcripts: {}, compilations: [], observations: [], feedback: [] }
    if (existsSync(join(path, 'events.jsonl'))) {
      const content = readFileSync(join(path, 'events.jsonl'), 'utf8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]) continue
        try { this.apply(record, JSON.parse(lines[i]!) as Entry) }
        catch (error) {
          if (i < lines.length - 1) throw new Error(`对局记录损坏：${id} 第 ${i + 1} 行；${String(error)}`)
          this.tails.set(id, { offset: Buffer.byteLength(content.slice(0, content.lastIndexOf('\n') + 1)), text: lines[i]!, valid: false })
        }
      }
      if (content && !content.endsWith('\n') && !this.tails.has(id)) this.tails.set(id, { offset: Buffer.byteLength(content), text: '', valid: true })
    }
    this.cache.set(id, record)
    return record
  }
  private info(record: BattleRecord): BattleRecordInfo & { sessionKey: string } {
    const latest = new Map(record.feedback.map(item => [item.commandId, item]))
    return { id: record.id, sessionKey: record.sessionKey, startedAt: record.startedAt, updatedAt: record.updatedAt,
      commands: new Set([...record.events.map(event => event.commandId), ...Object.keys(record.transcripts)]).size,
      feedback: latest.size, issues: [...latest.values()].filter(item => item.rating !== 'good').length }
  }
  list(): BattleRecordInfo[] {
    if (!existsSync(this.folder)) return []
    return readdirSync(this.folder).filter(safeId).flatMap(id => {
      try { return [this.info(this.read(id)!)] } catch (error) { this.warn(`[companion] 无法读取 ${id}：${String(error)}`); return [] }
    }).sort((a, b) => b.startedAt - a.startedAt)
  }
  feedback(id: string, commandId: string, rating: FeedbackRating, note: string): CommandFeedback {
    if (!Object.hasOwn(RATINGS, rating) || typeof note !== 'string' || note.length > 4000) throw new Error('反馈格式错误，备注最多 4000 字')
    const record = this.read(id)
    commandId = canonicalId(commandId)
    if (!record || (!record.transcripts[commandId] && !record.events.some(event => event.commandId === commandId))) throw new Error('找不到这条命令的对局记录')
    const latest = new Map<string, CommandEvent>()
    for (const event of record.events.filter(event => event.commandId === commandId)) latest.set(`${event.goalId ?? ''}:${event.stage === 'execution' ? 'execution' : 'stage'}`, event)
    const value: CommandFeedback = { id: randomUUID(), at: Date.now(), commandId, rating, note: note.trim(), observed: [...latest.values()] }
    // 先持久化，成功后才对界面确认；追加反馈保留历次意见和当时状态。
    this.append(record, 'feedback', value, true)
    this.guarded(() => this.flush())
    return value
  }
  flush(): void {
    for (const id of this.dirty) {
      const record = this.cache.get(id)!
      atomicWrite(join(this.folder, id, 'summary.md'), this.markdown(record))
      atomicWrite(join(this.folder, id, 'meta.json'), JSON.stringify(this.info(record)))
      this.dirty.delete(id)
    }
  }
  close(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.guarded(() => this.flush()) }

  /** 旧转写仅迁入可恢复内容；不能推断已丢失的代码或执行成果。 */
  importTranscripts(root: string): void {
    const folder = join(root, '.runtime/transcripts')
    if (!existsSync(folder)) return
    const files = readdirSync(folder).filter(file => file.endsWith('.json')).sort((a, b) => statSync(join(folder, a)).mtimeMs - statSync(join(folder, b)).mtimeMs)
    for (const file of files) this.guarded(() => {
      const value = JSON.parse(readFileSync(join(folder, file), 'utf8')) as Record<string, unknown>
      if (typeof value.requestId !== 'string' || typeof value.text !== 'string') return
      const record = this.ensure(String(value.sessionKey ?? ''))
      const id = canonicalId(value.requestId)
      if (record.transcripts[id]) return
      this.append(record, 'transcript', { ...value, imported: true })
      if (typeof value.at === 'number') record.startedAt = Math.min(record.startedAt, value.at)
      const base = { commandId: id, source: 'restored' as const, at: Number(value.at) || Date.now(), seq: 0, sessionKey: record.sessionKey }
      this.append(record, 'event', { ...base, stage: 'received', text: value.text })
      const plan = value.plan as { summary?: string } | undefined
      if (plan?.summary) this.append(record, 'event', { ...base, stage: 'understood', summary: plan.summary })
      if (['completed', 'failed', 'cancelled'].includes(String(value.terminalStage))) this.append(record, 'event', { ...base, stage: value.terminalStage, error: value.terminalError })
    })
    this.guarded(() => this.flush())
  }
  markdown(record: BattleRecord): string {
    const fence = (value: string, lang = '') => { const ticks = '`'.repeat(Math.max(3, ...[...value.matchAll(/`+/g)].map(match => match[0].length + 1))); return `${ticks}${lang}\n${value}\n${ticks}` }
    const labels: Record<string, string> = { received: '已收到', understanding: '理解中', understood: '已理解', binding: '绑定中', bound: '待生效', generating: '生成中', merged: '等待合并', effective: '脚本已生效', pending: '等待就绪', completed: '已完成', running: '执行中', continuous: '持续执行', paused: '暂停', faulted: '运行出错', blocked: '执行受阻', cancelled: '已取消', failed: '失败', partial: '部分执行', 'partial-completed': '部分完成' }
    const info = this.info(record)
    const lines = ['# 对局记录', '', `对局：${record.sessionKey || '未进入对局'}`, `开始：${new Date(record.startedAt).toLocaleString('zh-CN')}`, `最后记录：${new Date(record.updatedAt).toLocaleString('zh-CN')}`, `命令 ${info.commands} 条，已反馈 ${info.feedback} 条，其中待改进 ${info.issues} 条。`, '', '执行结果来自最后观察到的游戏事实；游戏关闭后不推断完成或胜负。用户反馈单独保留。', '完整请求、响应、状态变化与反馈在同目录 events.jsonl 中，供开发复盘使用。', '']
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
          lines.push(`- ${goalId}：${state === 'partial' ? '部分完成' : labels[state] ?? state}${execution?.detail ? `，${execution.detail}` : ''}${execution?.progress ? `（${execution.progress.completed}/${execution.progress.total}）` : ''}${goal.error ? `；${goal.error}` : ''}`)
        }
      }
      const errors = new Set(events.filter(event => event.error).map(event => event.error!))
      for (const error of errors) lines.push(`- 过程错误／未执行项：${error}`)
      const goals = new Set(events.flatMap(event => event.goalId ? [event.goalId] : []))
      const compiles = [...new Set(record.compilations.filter(item => item.commandId === id || item.goalIds.some(goal => goals.has(goal))).map(item => item.id))]
      if (compiles.length) lines.push(`关联脚本生成：${compiles.join('、')}（见下方代码）`)
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
      if (typeof code === 'string') lines.push('', fence(code, 'js'), '')
    }
    const observation = record.observations.at(-1)
    if (observation) {
      lines.push('## 最后观察到的成果与态势', '', `游戏 tick：${String(observation.tick)}；资金：${String(observation.credits)}`)
      if (observation.power) lines.push(`电力：${JSON.stringify(observation.power)}`)
      lines.push('', '编队与生产记录（提交和实际产出分别记录）：', '', fence(JSON.stringify({ formations: observation.formations, production: observation.production }, null, 2), 'json'), '')
    }
    return `${lines.join('\n')}\n`
  }
}
