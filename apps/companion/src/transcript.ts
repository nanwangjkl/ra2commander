import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CapabilityCall } from '@ra2c/command'
import type { GoalSpec } from '@ra2c/contracts'
import type { CommandContext } from './commands.ts'
import { newCommandId, type CommandEvent, type TraceOptions } from './command-log.ts'
import { bindDefaultMap } from './map-binding.ts'
import { normalizeOperations } from './transcript-plan.ts'
import { executeCapabilities, executionText, loadCommandPrompts, type CapabilityExecution } from './capabilities/index.ts'
import { isCombatUnit, loadGameCatalog } from './capabilities/selectors.ts'

export async function runTranscript(text: string, ctx: CommandContext, root: string, trace?: TraceOptions): Promise<string> {
  const active = trace ?? (ctx.commandLog ? { commandId: newCommandId(), source: 'cli' as const, log: ctx.commandLog } : undefined)
  const key = ctx.runtime.battleKey
  const emit = (event: Partial<CommandEvent> & Pick<CommandEvent, 'stage'>) => {
    if (['completed', 'failed', 'cancelled'].includes(event.stage) && !event.goalId) {
      record.terminalStage = event.stage as 'completed' | 'failed' | 'cancelled'
      record.terminalError = event.error ?? ''
    }
    if (active) active.log.emit({ commandId: active.commandId, source: active.source, sessionKey: key, ...event })
  }
  const requestId = active?.commandId ?? randomUUID()
  const folder = join(root, '.runtime/transcripts')
  const record = { requestId, text, at: Date.now(), source: active?.source ?? 'cli', model: '', durationMs: 0, sessionKey: key,
    messages: [] as Array<{ role: 'system' | 'user'; content: string }>, rawResponse: '', usage: undefined as unknown,
    promptVersions: { interpret: undefined as string | undefined, compile: {} as Record<string, string> },
    plan: undefined as { summary: string; operations: unknown[] } | undefined,
    modelPlan: undefined as { summary: string; operations: unknown[] } | undefined,
    goals: [] as GoalSpec[], choices: [] as string[], effects: [] as string[], skipped: [] as string[], results: [] as string[], error: '',
    terminalStage: undefined as 'completed' | 'failed' | 'cancelled' | undefined, terminalError: '' }
  let storageWarning = ''
  const save = () => {
    try {
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, `${requestId}.json`), JSON.stringify(record, null, 2))
    } catch (error) {
      const warning = String(error)
      if (storageWarning !== warning) console.error(`[companion] 转写记录保存失败：${warning.slice(0, 160)}`)
      storageWarning = warning
    }
    active?.log.recordTranscript(record)
  }
  let signal: AbortSignal | undefined
  const check = () => { signal?.throwIfAborted(); if (key !== ctx.runtime.battleKey) throw new Error('对局已变化，转写结果作废') }
  emit({ stage: 'received', text })
  try {
    save()
    if (!text.trim()) throw new Error('缺少模拟语音转写文本')
    const prompts = loadCommandPrompts()
    const snap = ctx.runtime.snapshot
    if (!snap) throw new Error('请先进入对局')
    active?.log.follow(ctx.controller, ctx.runtime)
    ctx.transcriptAbort?.abort(new Error('理解过程被后续命令取代'))
    const abort = new AbortController()
    ctx.transcriptAbort = abort
    signal = abort.signal
    emit({ stage: 'understanding' })
    try { await bindDefaultMap(ctx) } catch { check() } // 其他能力可继续；具体地域绑定会报告文件错误。
    const catalog = await loadGameCatalog(ctx, check, prompts.game)
    check()
    record.promptVersions.interpret = prompts.version
    record.messages = [
      { role: 'system', content: prompts.render('interpret') },
      { role: 'user', content: JSON.stringify({ text, faction: prompts.game.factions().find(faction => faction.id === catalog.faction)?.label ?? null,
        game: { id: prompts.game.id, version: prompts.game.version }, roles: prompts.game.roles().map(role => ({ id: role.id, aliases: role.aliases })),
        self: snap.self.map(unit => ({ id: unit.id, name: unit.name, type: unit.type, formationId: ctx.formations.ownerOf(unit.id) ?? null, canDeploy: unit.canDeploy, isCombat: isCombatUnit(unit, catalog) })),
        formations: ctx.formations.list(), catalog: catalog.items,
        skillRuns: [...ctx.runtime.skillRuns.values()].filter(run => ['preparing', 'exploring'].includes(run.status)).map(run => ({ id: run.id, skillId: run.skillId, version: run.version, formationId: run.formationId, status: run.status })),
        goals: [...ctx.runtime.goals.values()].filter(goal => goal.status !== 'cancelled').slice(-30).map(goal => ({ id: goal.spec.id, kind: goal.spec.kind, text: goal.spec.rawText, label: goal.spec.label, status: goal.status, owner: goal.ownerId, ...(goal.spec.kind === 'production' ? { target: goal.spec.target, quantity: goal.spec.quantity } : {}) })),
        map: ctx.mapRegions && ctx.mapSessionKey === key ? { name: ctx.mapRegions.scheme.map.name, regions: ctx.mapRegions.scheme.regions.map(region => region.name) } : null }) },
    ]
    save()
    const result = await ctx.currentProvider().generate({ messages: record.messages, maxTokens: 2048, thinking: 'disabled', signal })
    record.rawResponse = result.text
    record.model = result.model
    record.durationMs = result.durationMs
    record.usage = result.usage
    save()
    check()
    const raw = result.text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim()
    let plan: { summary: string; operations: unknown[] }
    try {
      plan = JSON.parse(raw)
      if (!plan || typeof plan.summary !== 'string' || !Array.isArray(plan.operations) || plan.operations.length > 8) throw new Error('转写解析格式非法')
    } catch (error) { throw new Error(`理解失败：${String(error)}`) }
    record.modelPlan = structuredClone(plan)
    const valid: CapabilityCall[] = [], invalid: unknown[] = []
    for (const call of plan.operations) { try { valid.push(prompts.capabilities.parse(call)) } catch { invalid.push(call) } }
    plan = { ...plan, operations: [...normalizeOperations(text, valid, ctx.mapSessionKey === key ? ctx.mapRegions : undefined, catalog), ...invalid] }
    record.plan = plan
    save()
    const update = (execution: CapabilityExecution) => { Object.assign(record, execution); plan.summary = execution.summary; save() }
    const execution = await executeCapabilities(plan.operations, ctx, { text, prompts, catalog, signal, emit, onUpdate: update, commandId: requestId,
      ...(!plan.operations.length ? { emptyReason: plan.summary } : {}),
      onPromptVersion: (owner, version) => { record.promptVersions.compile[owner] = version },
      hasFailure: goalId => active?.log.since(0).reverse().find(event => event.goalId === goalId)?.stage === 'failed',
    })
    update(execution)
    if (!execution.goals.length && !execution.effects.length) record.error = execution.skipped.join('；') || record.modelPlan.summary || '没有可执行目标'
    save()
    return `${executionText(execution)}\n记录：${requestId}`
  } catch (error) {
    record.error = String(error)
    emit({ stage: signal?.aborted || key !== ctx.runtime.battleKey ? 'cancelled' : 'failed', error: String(error) })
    try { save() } catch (saveError) { console.error(`[companion] 转写记录保存失败：${String(saveError).slice(0, 160)}`) }
    throw new Error(`${String(error)}；记录：${requestId}`)
  } finally {
    active?.log.syncRuntime(ctx.runtime)
    if (ctx.transcriptAbort?.signal === signal) delete ctx.transcriptAbort
  }
}
