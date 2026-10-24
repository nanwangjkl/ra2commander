import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadPrompts } from '@ra2c/command'
import type { GoalSpec, ProductionGoal } from '@ra2c/contracts'
import type { CommandContext } from './commands.ts'
import { newCommandId, type CommandEvent, type TraceOptions } from './command-log.ts'
import { bindDefaultMap } from './map-binding.ts'
import { normalizeOperations, type Operation } from './transcript-plan.ts'

// 当前支持目录中的同类项目；用于将模型选错的阵营名称落到本局可用项目。
const PRODUCTION_FAMILIES = [
  ['AMCV', 'SMCV', 'PCV'], ['GACNST', 'NACNST', 'YACNST'], ['GAPOWR', 'NAPOWR', 'YAPOWR'],
  ['GAREFN', 'NAREFN', 'YAREFN'], ['GAPILE', 'NAPILE', 'YAPILE'], ['GAWEAP', 'NAWEAP', 'YAWEAP'],
  ['GAAIRC', 'NARADR', 'YAPSY'], ['GATECH', 'NATECH', 'YATECH'], ['GASPYSAT'], ['MTNK', 'HTNK', 'LTNK'],
]

export async function runTranscript(text: string, ctx: CommandContext, root: string, trace?: TraceOptions): Promise<string> {
  // 终端/TCP 与界面走同一条事件流；未显式提供记录时（CLI 入口）也纳入侧栏。
  const active = trace ?? (ctx.commandLog ? { commandId: newCommandId(), source: 'cli' as const, log: ctx.commandLog } : undefined)
  const key = ctx.runtime.battleKey
  const emit = (stage: Partial<CommandEvent> & { stage: CommandEvent['stage'] }) => {
    if (active) active.log.emit({ commandId: active.commandId, source: active.source, sessionKey: key, ...stage })
  }
  const requestId = active?.commandId ?? randomUUID()
  const goals: GoalSpec[] = []
  const choices = new Map<string, string>()
  const folder = join(root, '.runtime/transcripts')
  const record = { requestId, text, at: Date.now(), source: active?.source ?? 'cli', model: '', durationMs: 0, sessionKey: key,
    promptVersions: { interpret: undefined as string | undefined, compile: {} as Record<string, string> },
    plan: undefined as { summary: string; operations: Operation[] } | undefined, goals,
    modelPlan: undefined as { summary: string; operations: Operation[] } | undefined,
    choices: [] as string[], skipped: [] as string[], results: [] as string[], error: '' }
  const save = () => {
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `${requestId}.json`), JSON.stringify(record, null, 2))
  }
  const addGoal = (goal: GoalSpec, choice: string) => { goals.push(goal); choices.set(goal.id, choice); record.choices.push(choice) }
  let signal: AbortSignal | undefined
  const check = () => { signal?.throwIfAborted(); if (key !== ctx.runtime.battleKey) throw new Error('对局已变化，转写结果作废') }
  emit({ stage: 'received', text })
  try {
    if (!text.trim()) throw new Error('缺少模拟语音转写文本')
    const prompts = loadPrompts({ onFallback: error => console.error(`[companion] ${String(error)}；沿用上一份可用提示词`) })
    const snap = ctx.runtime.snapshot
    if (!snap) throw new Error('请先进入对局')
    active?.log.follow(ctx.controller, ctx.runtime)
    ctx.transcriptAbort?.abort(new Error('理解过程被后续命令取代'))
    const abort = new AbortController()
    ctx.transcriptAbort = abort
    signal = abort.signal
    emit({ stage: 'understanding' })
    let mapError = ''
    try { await bindDefaultMap(ctx) } catch (error) { check(); mapError = `分区读取失败：${String(error)}` }
    check()
    const ids = [...new Set([...PRODUCTION_FAMILIES.flat(), ...snap.self.map(unit => unit.name)])]
    const prefix = snap.self.find(u => /^(GA|NA|YA)CNST$/.test(u.name))?.name.slice(0, 2)
      ?? (snap.self.some(u => u.name === 'AMCV') ? 'GA' : snap.self.some(u => u.name === 'SMCV') ? 'NA' : snap.self.some(u => u.name === 'PCV') ? 'YA' : undefined)
    const available = new Set(snap.production?.available ?? [])
    const owned = new Set(snap.self.map(u => u.name))
    const factionOf = (name: string) => /^(GA|NA|YA)/.exec(name)?.[1]
      ?? (['AMCV', 'MTNK'].includes(name) ? 'GA' : ['SMCV', 'HTNK'].includes(name) ? 'NA' : 'YA')
    const allCatalog = (await Promise.all(ids.map(async name => {
      for (const type of [2, 7]) {
        const r = await ctx.bridge.rules(name, type) as { label?: string; power?: number; deploysInto?: string } | undefined
        check()
        if (r) return { name, type, label: r.label, power: r.power ?? 0, deploysInto: r.deploysInto,
          available: available.has(name), faction: factionOf(name) }
      }
      return undefined
    }))).filter(r => !!r)
    const rank = (r: typeof allCatalog[number]) => Number(r.available) * 4 + Number(r.faction === prefix) * 2 + Number(owned.has(r.name))
    const catalog = allCatalog.filter(r => !prefix || r.faction === prefix || r.available).sort((a, b) => rank(b) - rank(a))
    const resolveProduction = (target: string) => {
      const normalized = target.trim().toLowerCase()
      const exact = catalog.find(r => r.name.toLowerCase() === normalized)
      if (exact) return exact
      const matches = allCatalog.filter(r => r.name.toLowerCase() === normalized || r.label?.toLowerCase() === normalized)
      const names = new Set(matches.flatMap(r => PRODUCTION_FAMILIES.find(f => f.includes(r.name)) ?? [r.name]))
      return catalog.find(r => names.has(r.name))
    }
    check()
    record.promptVersions.interpret = prompts.version
    const result = await ctx.currentProvider().generate({ messages: [
      { role: 'system', content: prompts.render('interpret') },
      { role: 'user', content: JSON.stringify({ text, faction: prefix === 'GA' ? 'Allied 盟军' : prefix === 'NA' ? 'Soviet 苏军' : prefix === 'YA' ? 'Yuri 尤里' : null, self: snap.self.map(u => ({ id: u.id, name: u.name, type: u.type, formationId: ctx.formations.ownerOf(u.id) ?? null, canDeploy: u.canDeploy })), formations: ctx.formations.list(), catalog, map: ctx.mapRegions && ctx.mapSessionKey === key ? { name: ctx.mapRegions.scheme.map.name, regions: ctx.mapRegions.scheme.regions.map(r => r.name) } : null }) },
    ], maxTokens: 2048, thinking: 'disabled', signal })
    check()
    record.model = result.model
    record.durationMs = result.durationMs
    const raw = result.text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim()
    let plan: { summary: string; operations: Operation[] }
    try {
      plan = JSON.parse(raw) as { summary: string; operations: Operation[] }
      if (!plan || typeof plan.summary !== 'string' || !Array.isArray(plan.operations) || plan.operations.length > 8) throw new Error('转写解析格式非法')
    } catch (error) {
      throw new Error(`理解失败：${String(error)}`)
    }
    record.modelPlan = structuredClone(plan)
    plan = { ...plan, operations: normalizeOperations(text, plan.operations, ctx.mapSessionKey === key ? ctx.mapRegions : undefined) }
    record.plan = plan
    save()
    const makeId = () => `voice-${randomUUID().slice(0, 8)}`
    const fullMap = { name: '沿途与全图作战', x1: 0, y1: 0, x2: snap.mapWidth - 1, y2: snap.mapHeight - 1 }
    const noOps: string[] = []
    emit({ stage: 'binding' })
    for (const operation of plan.operations) {
      try {
        if (operation.kind === 'deploy') {
          const vehicle = snap.self.filter(u => u.canDeploy && allCatalog.some(r => r.name === u.name && r.deploysInto?.endsWith('CNST')))
            .sort((a, b) => Number(b.isIdle) - Number(a.isIdle) || a.id - b.id)[0]
          if (!vehicle) throw new Error('没有可展开的基地车')
          addGoal({ id: makeId(), kind: 'deploy', rawText: text, unitIds: [vehicle.id], target: allCatalog.find(r => r.name === vehicle.name)!.deploysInto! }, `展开基地车 #${vehicle.id}`)
        } else if (operation.kind === 'produce' || operation.kind === 'power') {
          const target = operation.kind === 'power' ? 'Power Plant' : operation.target
          const rule = operation.kind === 'power' ? catalog.find(r => PRODUCTION_FAMILIES[2]!.includes(r.name) && r.power > 0) : resolveProduction(target)
          if (!rule) throw new Error(`未找到可用生产项目：${target}`)
          const quantity = operation.kind === 'produce' ? operation.quantity : 1
          if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) throw new Error('生产数量非法')
          const goal: ProductionGoal = { id: makeId(), kind: 'production', rawText: text, target: rule.name, quantity, prerequisites: [], queues: [] }
          if (operation.kind === 'power') {
            if (!Number.isFinite(operation.reserve) || operation.reserve < 0 || rule.power <= 0) throw new Error('补电目标非法')
            goal.maintainPower = { reserve: operation.reserve, output: rule.power }
          } else if (operation.formationId) {
            if (typeof operation.formationId !== 'string' || rule.type === 2) throw new Error('编队生产目标非法')
            goal.formationId = operation.formationId
          }
          addGoal(goal, `${operation.kind === 'power' ? '持续补电' : `生产${quantity}个`} ${rule.label ?? rule.name}（${rule.name}）${goal.formationId ? `，编入${goal.formationId}` : ''}`)
        } else if (operation.kind === 'assign') {
          const quantity = operation.quantity
          if (quantity !== 'all' && (!Number.isSafeInteger(quantity) || quantity < 1)) throw new Error('编队数量非法')
          const generic = /^(tanks|坦克|所有坦克)$/i.test(operation.target)
          const rule = generic ? undefined : resolveProduction(operation.target)
          const matched = snap.self.filter(unit => unit.type === 7 && (generic
            ? /^(MTNK|HTNK|LTNK|GTNK|TTNK|APOC|MGTK|TNKD|DMTK|YTNK)$/.test(unit.name) || /tank|坦克/i.test(allCatalog.find(rule => rule.name === unit.name)?.label ?? '')
            : unit.name === rule?.name))
          const available = matched.filter(unit => ctx.formations.ownerOf(unit.id) !== operation.formationId && (quantity === 'all' || !ctx.formations.ownerOf(unit.id)))
            .sort((a, b) => Number(!!ctx.formations.ownerOf(a.id)) - Number(!!ctx.formations.ownerOf(b.id)) || a.id - b.id)
          const selected = quantity === 'all' ? available : available.slice(0, quantity)
          if (!selected.length) {
            if (matched.length && matched.every(unit => ctx.formations.ownerOf(unit.id) === operation.formationId)) { noOps.push(`现有${matched.length}辆坦克已在${operation.formationId}`); continue }
            throw new Error('没有可编入的现有坦克，未追加生产')
          }
          if (quantity !== 'all' && selected.length < quantity) record.skipped.push(`现有未编队坦克仅${selected.length}辆，仍缺${quantity - selected.length}辆；未追加生产`)
          const exists = ctx.formations.list().some(formation => formation.id === operation.formationId)
          const force = selected.some(unit => !!ctx.formations.ownerOf(unit.id))
          addGoal({ id: makeId(), kind: 'formation', rawText: text, request: exists
            ? { kind: 'transferUnits', formationId: operation.formationId, unitIds: selected.map(unit => unit.id) }
            : { kind: 'createFormation', formationId: operation.formationId, unitIds: selected.map(unit => unit.id), force } }, `将现有${selected.length}辆坦克编入${operation.formationId}（不新增生产）`)
        } else if (operation.kind === 'move' || operation.kind === 'assaultRegion') {
          if (!ctx.formations.list().some(f => f.id === operation.formationId)) throw new Error(`编队不存在：${operation.formationId}`)
          const index = ctx.mapSessionKey === key ? ctx.mapRegions : undefined
          const region = index?.resolve(operation.regionName)
          if (!index || !region) throw new Error(mapError || `冰天雪地分区中未找到地名：${operation.regionName}`)
          const [lx, ly] = region.labelPosition
          let destination: { x: number; y: number; name: string } | undefined
          // 选区域内部且相邻格也属于本区的整数格；是否可达由实机后续位置确认。
          for (let radius = 0; radius <= 20 && !destination; radius++) {
            for (let dx = -radius; dx <= radius && !destination; dx++) for (let dy = -radius; dy <= radius && !destination; dy++) {
              const x = Math.round(lx) + dx, y = Math.round(ly) + dy
              if ([-1, 0, 1].every(a => [-1, 0, 1].every(b => index.regionsAt(x + a, y + b).some(r => r.id === region.id)))) destination = { x, y, name: region.name }
            }
          }
          if (!destination) throw new Error('未找到分区内部的候选目的地')
          if (operation.kind === 'assaultRegion') addGoal({ id: makeId(), kind: 'combat', rawText: text, formationId: operation.formationId, region: fullMap, destination,
            attackRegion: { id: region.id, name: region.name, polygons: region.polygons }, allowedActions: ['move', 'attackMove', 'attack', 'stop'] }, `${operation.formationId} 前往并清理${region.name}区域内的敌人`)
          else addGoal({ id: makeId(), kind: 'combat', rawText: text, formationId: operation.formationId, region: fullMap, destination, allowedActions: ['move', 'stop'] }, `${operation.formationId} 前往${region.name}（${destination.x}, ${destination.y}）`)
        } else if (operation.kind === 'attackAll') {
          const formations = ctx.formations.list().filter(f => (!operation.formationId || f.id === operation.formationId) && snap.self.some(u => f.memberIds.includes(u.id) && u.primaryWeapon))
          if (!formations.length) throw new Error('没有可用作战编队')
          for (const formation of formations) {
            addGoal({ id: makeId(), kind: 'combat', rawText: text, formationId: formation.id, region: fullMap, allowedActions: ['move', 'attackMove', 'attack', 'stop'] }, `编队 ${formation.id} 全图进攻`)
          }
        } else throw new Error('不支持的转写操作')
      } catch (error) {
        check()
        record.skipped.push(String(error))
        emit({ stage: 'skipped', error: String(error).slice(0, 200) })
      }
    }
    check()
    save()
    const skipped = () => record.skipped.length ? `\n未执行部分：${record.skipped.join('；')}` : ''
    if (!goals.length && noOps.length) {
      plan.summary = noOps.join('；')
      emit({ stage: 'understood', summary: plan.summary })
      emit({ stage: 'completed' })
      save()
      return `理解：${plan.summary}\n记录：${requestId}`
    }
    if (!goals.length) {
      record.error = record.skipped.join('；') || plan.summary || '没有可执行目标'
      emit({ stage: 'failed', error: `未执行：${record.error}` })
      save()
      return `理解：${plan.summary}；未执行${skipped()}\n记录：${requestId}`
    }
    const owners = new Set<string>()
    const goalOwners = new Map<string, string>()
    const accepted: string[] = [...noOps]
    for (const goal of goals) {
      const choice = choices.get(goal.id)!
      try {
        const owner = ctx.runtime.upsertGoal(goal)
        owners.add(owner)
        goalOwners.set(goal.id, owner)
        accepted.push(choice)
        emit({ stage: 'bound', goalId: goal.id, owner, choice })
      } catch (error) {
        record.skipped.push(String(error))
        emit({ stage: 'failed', goalId: goal.id, choice, error: `目标绑定失败：${String(error)}` })
      }
    }
    plan.summary = accepted.length ? accepted.join('；') : '没有可执行目标'
    if (record.skipped.length) plan.summary += `；另有${record.skipped.length}项未执行`
    emit({ stage: 'understood', summary: plan.summary })
    for (const error of record.skipped) emit({ stage: 'skipped', error })
    for (const owner of owners) {
      check()
      emit({ stage: 'generating', owner })
      try {
        record.results.push(await ctx.controller.refresh(owner, false, {
          prompts,
          onPromptVersion: version => { record.promptVersions.compile[owner] = version },
        }))
      } catch (error) {
        record.results.push(String(error))
        for (const [goalId, goalOwner] of goalOwners) {
          const reported = active?.log.since(0).reverse().find(event => event.goalId === goalId)?.stage === 'failed'
          if (!reported && goalOwner === owner && ctx.runtime.goals.get(goalId)?.status !== 'active') emit({ stage: 'failed', owner, goalId, error: `脚本生成失败：${String(error)}` })
        }
      }
      save()
    }
    return `理解：${plan.summary}${record.choices.length ? `\n执行选择：${record.choices.join('；')}` : ''}\n${record.results.join('\n')}${skipped()}\n记录：${requestId}`
  } catch (error) {
    record.error = String(error)
    const cancelled = signal?.aborted || key !== ctx.runtime.battleKey
    emit({ stage: cancelled ? 'cancelled' : 'failed', error: String(error) })
    try { save() } catch (saveError) { console.error(`[companion] 转写记录保存失败：${String(saveError).slice(0, 160)}`) }
    throw new Error(`${String(error)}；记录：${requestId}`)
  } finally {
    active?.log.syncRuntime(ctx.runtime)
    if (ctx.transcriptAbort?.signal === signal) delete ctx.transcriptAbort
  }
}
