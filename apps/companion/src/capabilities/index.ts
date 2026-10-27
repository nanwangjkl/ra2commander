import { loadPrompts, type CapabilityCall, type CapabilityId, type CapabilityParameters, type ResolvedCapabilityParameters, type PromptLibrary } from '@ra2c/command'
import { goalExecutionMode, type CommandEvent, type GoalSpec } from '@ra2c/contracts'
import type { CommandContext } from '../commands.ts'
import { bindings, type BindingContext } from './bindings.ts'
import { loadGameCatalog, type GameCatalog } from './selectors.ts'
import { skillGoalIds } from '@ra2c/runtime'
import { randomUUID } from 'node:crypto'
import { relocationKey } from '../base-relocation.ts'
import { retainAttackScope } from './binding-recovery.ts'

export function validateBindings(prompts: PromptLibrary): void { prompts.capabilities.assertBindings(Object.keys(bindings)) }
export function loadCommandPrompts(): PromptLibrary { return loadPrompts({ validate: validateBindings }) }
export interface CapabilityExecution {
  goals: GoalSpec[]
  choices: string[]
  effects: string[]
  skipped: string[]
  results: string[]
  summary: string
}
export interface BindingFailure { operation: unknown; error: string }
export interface BindingCorrection { index: number; operations: unknown[] }
interface ExecuteOptions {
  text: string
  prompts?: PromptLibrary
  catalog?: GameCatalog
  signal?: AbortSignal
  emit?: (event: Partial<CommandEvent> & Pick<CommandEvent, 'stage'>) => void
  onUpdate?: (execution: CapabilityExecution) => void
  onPromptVersion?: (owner: string, version: string) => void
  hasFailure?: (goalId: string) => boolean
  emptyReason?: string
  commandId?: string
  repairBindings?: (failures: BindingFailure[], accepted: CapabilityCall[]) => Promise<BindingCorrection[]>
}

/** 终端、侧栏与后续语音的共同入口：校验、绑定、直接控制或按控制对象合并编译。 */
export async function executeCapabilities(calls: readonly unknown[], ctx: CommandContext, options: ExecuteOptions): Promise<CapabilityExecution> {
  const prompts = options.prompts ?? loadCommandPrompts()
  validateBindings(prompts)
  const key = ctx.runtime.battleKey
  const check = () => { options.signal?.throwIfAborted(); if (!ctx.runtime.snapshot || key !== ctx.runtime.battleKey) throw new Error('对局已变化或尚未进入对局') }
  check()
  const emit = options.emit ?? (() => {})
  const state: CapabilityExecution = { goals: [], choices: [], effects: [], skipped: [], results: [], summary: '' }
  const scriptOwners = new Set<string>()
  const owners = new Set<string>(), suppressed = new Set<string>(), goalOwners = new Map<string, string>()
  const accepted: string[] = []
  const acceptedCalls: CapabilityCall[] = [], failures: BindingFailure[] = []
  let publishedSummary = ''
  const acceptedGoals = new Map<string, number>()
  let catalog = options.catalog ? Promise.resolve(options.catalog) : undefined
  const context: BindingContext = { ctx, text: options.text, check,
    formationGoals: new Map(),
    movementGoals: new Map(),
    relocationIds: new Map(),
    game: prompts.game,
    prompts,
    commandId: options.commandId ?? `cmd-${randomUUID()}`,
    knownCatalog: options.catalog,
    catalog: () => catalog ??= loadGameCatalog(ctx, check, prompts.game),
    cancelUnderstanding: () => { if (ctx.transcriptAbort?.signal !== options.signal) ctx.transcriptAbort?.abort(new Error('被控制命令中止')) },
  }
  const skip = (message: string) => { state.skipped.push(message); emit({ stage: 'skipped', error: message }) }
  emit({ stage: 'binding' })
  const bindCalls = async (values: readonly unknown[], failed: BindingFailure[]) => {
    for (const value of values) {
      try { const call = prompts.capabilities.parse(value); if (call.capability === 'base.relocate' && !context.relocationIds.has(relocationKey(call.params))) context.relocationIds.set(relocationKey(call.params), `command-${randomUUID().slice(0, 8)}`) } catch { /* 正式绑定时反馈 */ }
    }
    values = [...values].sort((a, b) => Number((b as CapabilityCall)?.capability === 'base.relocate') - Number((a as CapabilityCall)?.capability === 'base.relocate'))
    for (const value of values) {
      try {
        check()
        const call = prompts.capabilities.parse(value)
        const definition = prompts.capabilities.definitions().find(definition => definition.id === call.capability)!
        const binder = bindings[definition.binder as CapabilityId] as (params: ResolvedCapabilityParameters[CapabilityId], context: BindingContext) => ReturnType<(typeof bindings)[CapabilityId]>
        const result = await binder(call.params, context)
        check()
        const goalFailures: string[] = []
        let boundGoals = 0
        for (const item of result.goals ?? []) {
          const existing = ctx.runtime.goals.get(item.goal.id)
          const track = !existing
          const tracked = state.goals.findIndex(goal => goal.id === item.goal.id)
          try {
            const owner = ctx.runtime.upsertGoal(item.goal)
            boundGoals++
            if (track) { state.goals.push(item.goal); state.choices.push(item.choice) }
            if (item.goal.kind === 'formation' && item.goal.request.kind !== 'dissolveFormation') context.formationGoals.set(item.goal.request.formationId, item.goal)
            if (item.goal.kind === 'combat') {
              if (call.capability === 'combat.move' && item.goal.destination) context.movementGoals.set(item.goal.formationId, item.goal)
              else context.movementGoals.delete(item.goal.formationId)
            }
            owners.add(owner); suppressed.delete(owner)
            if (goalExecutionMode(item.goal) === 'script') scriptOwners.add(owner)
            if (tracked >= 0) {
              state.goals[tracked] = item.goal; state.choices[tracked] = item.choice
              accepted[acceptedGoals.get(item.goal.id)!] = item.choice
              emit({ stage: 'bound', goalId: item.goal.id, owner, choice: item.choice, executionMode: goalExecutionMode(item.goal) })
            } else if (track) {
              acceptedGoals.set(item.goal.id, accepted.length); accepted.push(item.choice)
              goalOwners.set(item.goal.id, owner); emit({ stage: 'bound', goalId: item.goal.id, owner, choice: item.choice, executionMode: goalExecutionMode(item.goal) })
            }
            else { accepted.push(item.choice); state.effects.push(item.choice) } // 改已有目标不夺走原命令卡片的进度绑定。
          } catch (error) {
            if (item.goal.kind === 'explore' && !ctx.runtime.goals.has(item.goal.id)) ctx.runtime.exploration.progress.delete(item.goal.explorationId)
            goalFailures.push(`目标绑定失败：${String(error)}`)
          }
        }
        if (goalFailures.length && !boundGoals && !result.skillRun && !result.choices?.length && !result.refreshOwners?.length && !result.suppressOwners?.length) {
          failed.push({ operation: value, error: goalFailures.join('；') })
          continue
        }
        for (const message of goalFailures) skip(message)
        if (result.skillRun) {
          const run = result.skillRun
          if (skillGoalIds(run).every(id => ctx.runtime.goals.has(id))) ctx.runtime.skillRuns.set(run.id, run)
          else {
            await Promise.all(skillGoalIds(run).map(id => ctx.runtime.cancelGoal(id, 'Skill 目标绑定不完整，已撤销')))
            skip('Skill 目标绑定不完整，已撤销本次 Skill')
          }
        }
        for (const owner of result.refreshOwners ?? []) { owners.add(owner); scriptOwners.add(owner); suppressed.delete(owner) }
        for (const owner of result.suppressOwners ?? []) { owners.delete(owner); suppressed.add(owner) }
        state.effects.push(...(result.choices ?? [])); accepted.push(...(result.choices ?? []))
        for (const message of result.skipped ?? []) skip(message)
        acceptedCalls.push(call)
      } catch (error) { check(); failed.push({ operation: value, error: String(error) }) }
    }
  }
  const updateSummary = () => {
    state.summary = accepted.length ? accepted.join('；') : options.emptyReason || '没有可执行目标'
    if (state.skipped.length && accepted.length) state.summary += `；另有${state.skipped.length}项未执行`
    if (state.summary !== publishedSummary) { emit({ stage: 'understood', summary: state.summary }); publishedSummary = state.summary }
    options.onUpdate?.(state)
  }
  const compileFailures = new Map<string, string>()
  const compileOwners = async () => {
    // 所有已绑定的固定流程先启用，避免被其他控制对象的云端生成拖住。
    for (const owner of owners) {
      if (suppressed.has(owner)) continue
      check()
      const native = [...ctx.runtime.goals.values()].some(goal => goal.ownerId === owner && ['pending', 'active'].includes(goal.status) && goalExecutionMode(goal.spec) === 'native') ? ctx.controller.activateNative(owner) : undefined
      if (native && !scriptOwners.has(owner)) state.results.push(native)
    }
    options.onUpdate?.(state)
    for (const owner of owners) {
      if (suppressed.has(owner) || !scriptOwners.has(owner)) continue
      check()
      emit({ stage: 'generating', owner, executionMode: 'script' })
      try {
        state.results.push(await ctx.controller.refresh(owner, false, { prompts, ...(options.commandId ? { commandId: options.commandId } : {}), onPromptVersion: version => options.onPromptVersion?.(owner, version) }))
        compileFailures.delete(owner)
      } catch (error) {
        compileFailures.set(owner, String(error))
        state.results.push(String(error))
        const related = [...goalOwners].filter(([, goalOwner]) => goalOwner === owner)
        if (!related.length) emit({ stage: 'failed', error: `脚本生成失败：${String(error)}` })
        for (const [goalId] of related) {
          if (!options.hasFailure?.(goalId) && ctx.runtime.goals.get(goalId)?.status !== 'active') emit({ stage: 'failed', owner, goalId, error: `脚本生成失败：${String(error)}` })
        }
      }
      options.onUpdate?.(state)
    }
    owners.clear(); scriptOwners.clear()
  }
  await bindCalls(calls, failures)
  updateSummary()
  // 已绑定部分先生成并执行；重决策只处理失败项，不重放成功调用。
  await compileOwners()
  if (failures.length && options.repairBindings) {
    try {
      const corrections = await options.repairBindings(failures, acceptedCalls)
      check()
      const handled = new Set<number>()
      for (const correction of corrections) {
        if (!Number.isInteger(correction.index) || !failures[correction.index] || handled.has(correction.index)) continue
        handled.add(correction.index)
        const remaining = correction.operations.map(value => retainAttackScope(failures[correction.index]!.operation, value, prompts)).filter(value => {
          try {
            const identity = (value: CapabilityCall) => {
              const call = prompts.capabilities.parse(value)
              if (call.capability === 'production.produce') call.params.target = options.catalog?.resolve(call.params.target, call.params.formationId ? { mobile: true } : {})?.name ?? call.params.target
              return JSON.stringify(call)
            }
            return !acceptedCalls.some(accepted => identity(accepted) === identity(prompts.capabilities.parse(value)))
          } catch { return true }
        })
        const failed: BindingFailure[] = []
        if (remaining.length) await bindCalls(remaining, failed)
        else failed.push(failures[correction.index]!)
        for (const failure of failed) skip(failure.error)
      }
      for (const [index, failure] of failures.entries()) if (!handled.has(index)) skip(failure.error)
    } catch (error) {
      check()
      for (const failure of failures) skip(failure.error)
      skip(`绑定重试失败：${String(error)}`)
    }
    updateSummary()
    await compileOwners()
  } else for (const failure of failures) skip(failure.error)
  updateSummary()
  if (!accepted.length) { emit({ stage: 'failed', error: `未执行：${state.skipped.join('；') || state.summary}` }); return state }
  if (!state.goals.length) emit(compileFailures.size ? { stage: 'failed', error: `脚本生成失败：${[...compileFailures.values()].join('；')}` } : { stage: 'completed' })
  return state
}

export function executionText(state: CapabilityExecution): string {
  return `理解：${state.summary}${state.choices.length ? `\n执行选择：${state.choices.join('；')}` : ''}${state.results.length ? `\n${state.results.join('\n')}` : ''}${state.skipped.length ? `\n未执行部分：${state.skipped.join('；')}` : ''}`
}
export function executeCapability<Id extends CapabilityId>(capability: Id, params: CapabilityParameters[Id], ctx: CommandContext, text: string): Promise<string> {
  return executeCapabilities([{ capability, params }], ctx, { text }).then(executionText)
}
export type { CapabilityCall }
