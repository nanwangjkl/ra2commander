import { loadPrompts, type CapabilityCall, type CapabilityId, type CapabilityParameters, type ResolvedCapabilityParameters, type PromptLibrary } from '@ra2c/command'
import type { CommandEvent, GoalSpec } from '@ra2c/contracts'
import type { CommandContext } from '../commands.ts'
import { bindings, type BindingContext } from './bindings.ts'
import { loadGameCatalog, type GameCatalog } from './selectors.ts'

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
  const owners = new Set<string>(), suppressed = new Set<string>(), goalOwners = new Map<string, string>()
  const accepted: string[] = []
  const acceptedGoals = new Map<string, number>()
  let catalog = options.catalog ? Promise.resolve(options.catalog) : undefined
  const context: BindingContext = { ctx, text: options.text, check,
    formationGoals: new Map(),
    movementGoals: new Map(),
    game: prompts.game,
    knownCatalog: options.catalog,
    catalog: () => catalog ??= loadGameCatalog(ctx, check, prompts.game),
    cancelUnderstanding: () => { if (ctx.transcriptAbort?.signal !== options.signal) ctx.transcriptAbort?.abort(new Error('被控制命令中止')) },
  }
  const skip = (message: string) => { state.skipped.push(message); emit({ stage: 'skipped', error: message }) }
  emit({ stage: 'binding' })
  for (const value of calls) {
    try {
      check()
      const call = prompts.capabilities.parse(value)
      const definition = prompts.capabilities.definitions().find(definition => definition.id === call.capability)!
      const binder = bindings[definition.binder as CapabilityId] as (params: ResolvedCapabilityParameters[CapabilityId], context: BindingContext) => ReturnType<(typeof bindings)[CapabilityId]>
      const result = await binder(call.params, context)
      check()
      for (const item of result.goals ?? []) {
        const existing = ctx.runtime.goals.get(item.goal.id)
        const track = !existing
        const tracked = state.goals.findIndex(goal => goal.id === item.goal.id)
        if (track) { state.goals.push(item.goal); state.choices.push(item.choice) }
        try {
          const owner = ctx.runtime.upsertGoal(item.goal)
          if (item.goal.kind === 'formation' && item.goal.request.kind !== 'dissolveFormation') context.formationGoals.set(item.goal.request.formationId, item.goal)
          if (item.goal.kind === 'combat') {
            if (call.capability === 'combat.move' && item.goal.destination) context.movementGoals.set(item.goal.formationId, item.goal)
            else context.movementGoals.delete(item.goal.formationId)
          }
          owners.add(owner); suppressed.delete(owner)
          if (tracked >= 0) {
            state.goals[tracked] = item.goal; state.choices[tracked] = item.choice
            accepted[acceptedGoals.get(item.goal.id)!] = item.choice
            emit({ stage: 'bound', goalId: item.goal.id, owner, choice: item.choice })
          } else if (track) {
            acceptedGoals.set(item.goal.id, accepted.length); accepted.push(item.choice)
            goalOwners.set(item.goal.id, owner); emit({ stage: 'bound', goalId: item.goal.id, owner, choice: item.choice })
          }
          else { accepted.push(item.choice); state.effects.push(item.choice) } // 改已有目标不夺走原命令卡片的进度绑定。
        } catch (error) { state.skipped.push(String(error)); emit({ stage: 'failed', goalId: item.goal.id, choice: item.choice, error: `目标绑定失败：${String(error)}` }) }
      }
      for (const owner of result.refreshOwners ?? []) { owners.add(owner); suppressed.delete(owner) }
      for (const owner of result.suppressOwners ?? []) { owners.delete(owner); suppressed.add(owner) }
      state.effects.push(...(result.choices ?? [])); accepted.push(...(result.choices ?? []))
      for (const message of result.skipped ?? []) skip(message)
    } catch (error) { check(); skip(String(error)) }
  }
  state.summary = accepted.length ? accepted.join('；') : options.emptyReason || '没有可执行目标'
  if (state.skipped.length && accepted.length) state.summary += `；另有${state.skipped.length}项未执行`
  emit({ stage: 'understood', summary: state.summary })
  options.onUpdate?.(state)
  if (!accepted.length) { emit({ stage: 'failed', error: `未执行：${state.skipped.join('；') || state.summary}` }); return state }
  let compileFailed = false
  for (const owner of owners) {
    if (suppressed.has(owner)) continue
    check()
    emit({ stage: 'generating', owner })
    try {
      state.results.push(await ctx.controller.refresh(owner, false, { prompts, ...(options.commandId ? { commandId: options.commandId } : {}), onPromptVersion: version => options.onPromptVersion?.(owner, version) }))
    } catch (error) {
      compileFailed = true
      state.results.push(String(error))
      const related = [...goalOwners].filter(([, goalOwner]) => goalOwner === owner)
      if (!related.length) emit({ stage: 'failed', error: `脚本生成失败：${String(error)}` })
      for (const [goalId] of related) {
        if (!options.hasFailure?.(goalId) && ctx.runtime.goals.get(goalId)?.status !== 'active') emit({ stage: 'failed', owner, goalId, error: `脚本生成失败：${String(error)}` })
      }
    }
    options.onUpdate?.(state)
  }
  if (!state.goals.length && !compileFailed) emit({ stage: 'completed' })
  return state
}

export function executionText(state: CapabilityExecution): string {
  return `理解：${state.summary}${state.choices.length ? `\n执行选择：${state.choices.join('；')}` : ''}${state.results.length ? `\n${state.results.join('\n')}` : ''}${state.skipped.length ? `\n未执行部分：${state.skipped.join('；')}` : ''}`
}
export function executeCapability<Id extends CapabilityId>(capability: Id, params: CapabilityParameters[Id], ctx: CommandContext, text: string): Promise<string> {
  return executeCapabilities([{ capability, params }], ctx, { text }).then(executionText)
}
export type { CapabilityCall }
