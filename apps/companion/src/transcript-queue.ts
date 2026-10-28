import type { CapabilityCall, PromptLibrary } from '@ra2c/command'
import type { CommandContext } from './commands.ts'
import { formationAlias, resolveOwner, selectUnitSet, type GameCatalog } from './capabilities/selectors.ts'

export class InterruptedOperation extends Error {}
export const priorityCall = (call: CapabilityCall) => ['control.stop', 'control.pause', 'goal.cancel', 'skill.cancel'].includes(call?.capability)

/** 模型请求各自运行；普通绑定按收到顺序，优先控制可越过尚未返回的理解。 */
export class TranscriptQueue {
  private order = 0
  private session = ''
  private readonly pending = new Set<TranscriptTurn>()
  register(session: string): TranscriptTurn {
    this.setSession(session)
    const turn = new TranscriptTurn(++this.order, this)
    this.pending.add(turn)
    return turn
  }
  setSession(session: string): void {
    if (this.session !== session) this.cancelAll(new Error('对局已变化，旧理解结果作废'))
    this.session = session
  }
  cancelAll(reason = new Error('理解请求已取消')): void {
    for (const turn of this.pending) turn.abort.abort(reason)
  }
  interrupt(matches: (call: CapabilityCall) => boolean, reason: string, signal?: AbortSignal, all = false): void {
    const order = [...this.pending].find(turn => turn.signal === signal)?.order ?? this.order + 1
    for (const turn of this.pending) if (turn.order < order && turn.signal !== signal) {
      turn.blocks.push({ matches, reason })
      if (all) turn.abort.abort(new Error(reason))
    }
  }
  async wait(turn: TranscriptTurn, priority: boolean, waiting: () => void): Promise<void> {
    turn.priority = priority
    for (;;) {
      turn.signal.throwIfAborted()
      const blockers = priority ? [] : [...this.pending].filter(other => other !== turn && !other.bound && (other.order < turn.order || other.priority))
      if (!blockers.length) return
      waiting()
      await Promise.race([Promise.all(blockers.map(other => other.priority ? other.priorityDone : other.done)), turn.done])
    }
  }
  remove(turn: TranscriptTurn): void { this.pending.delete(turn) }
}

export class TranscriptTurn {
  readonly abort = new AbortController()
  readonly done: Promise<void>
  readonly priorityDone: Promise<void>
  readonly blocks: Array<{ matches: (call: CapabilityCall) => boolean; reason: string }> = []
  bound = false
  priority = false
  private resolve!: () => void
  private resolvePriority!: () => void
  constructor(readonly order: number, private readonly queue: TranscriptQueue) {
    this.done = new Promise(resolve => { this.resolve = resolve })
    this.priorityDone = new Promise(resolve => { this.resolvePriority = resolve })
    this.signal.addEventListener('abort', () => this.release(), { once: true })
  }
  get signal(): AbortSignal { return this.abort.signal }
  wait(priority: boolean, waiting: () => void): Promise<void> { return this.queue.wait(this, priority, waiting) }
  check(call: CapabilityCall): void {
    this.signal.throwIfAborted()
    const blocked = this.blocks.find(block => block.matches(call))
    if (blocked) throw new InterruptedOperation(blocked.reason)
  }
  endPriority(): void { this.priority = false; this.resolvePriority() }
  release(): void { if (!this.bound) { this.bound = true; this.endPriority(); this.resolve() } }
  finish(): void { this.release(); this.queue.remove(this) }
}

/** 停止只使更早、同范围的操作失效；无关建设或其他编队的理解继续。 */
export function interruptTranscripts(ctx: CommandContext, call: CapabilityCall, prompts: PromptLibrary, catalog?: GameCatalog, signal?: AbortSignal): void {
  const queue = ctx.transcripts
  if (!queue || !priorityCall(call)) return
  const sameFormation = (a: string, b: string) => formationAlias(a) === formationAlias(b)
  const ownersOf = (operation: CapabilityCall): string[] => {
    const params = operation.params as Record<string, unknown>
    const formation = typeof params.formationId === 'string' ? `formation:${formationAlias(params.formationId)}` : undefined
    const kind = prompts.capabilities.definitions().find(definition => definition.id === operation.capability)?.owner
    if (kind === 'global') return ['global']
    if (formation) return [formation]
    if (operation.capability === 'skill.run') return ['global']
    if (operation.capability === 'combat.attack' || operation.capability === 'economy.gather') {
      try { return [...new Set(selectUnitSet(ctx, operation.params, catalog, prompts.game).selected.map(unit => ctx.formations.ownerOf(unit.id) ? `formation:${formationAlias(ctx.formations.ownerOf(unit.id)!)}` : 'global'))] }
      catch { return ['global'] }
    }
    return ['global']
  }
  const reason = '已被后续停止、暂停或取消指令中止，未应用迟到操作'
  if (call.capability === 'control.stop' || call.capability === 'control.pause') {
    const params = call.params
    if (params.scope === 'all') { queue.interrupt(() => true, reason, signal, true); return }
    if (params.scope === 'units') {
      const selected = selectUnitSet(ctx, params, catalog, prompts.game).selected
      const ids = new Set(selected.map(unit => unit.id)), formations = selected.flatMap(unit => ctx.formations.ownerOf(unit.id) ? [ctx.formations.ownerOf(unit.id)!] : [])
      queue.interrupt(operation => {
        const value = operation.params as { formationId?: string; unitIds?: number[]; selector?: string }
        if (value.formationId && prompts.capabilities.definitions().find(item => item.id === operation.capability)?.owner !== 'global') return formations.some(id => sameFormation(id, value.formationId!))
        if (value.unitIds) return value.unitIds.some(id => ids.has(id))
        if (!['combat.attack', 'economy.gather', 'management.rally', 'building.repair', 'building.sell', 'production.rally'].includes(operation.capability)) return false
        return selectUnitSet(ctx, value, catalog, prompts.game).selected.some(unit => ids.has(unit.id) && (!operation.capability.startsWith('building.') || unit.type === 2))
      }, reason, signal)
      return
    }
    const owners = params.scope === 'global' ? ['global'] : [(() => { try { return resolveOwner(ctx, params.formationId ?? '') } catch { return `formation:${formationAlias(params.formationId ?? '')}` } })()]
    queue.interrupt(operation => ownersOf(operation).some(owner => owners.some(target => owner === 'global' ? target === owner : target.startsWith('formation:') && sameFormation(target.slice(10), owner.slice(10)))), reason, signal)
  } else if (call.capability === 'goal.cancel') {
    const token = call.params.goalId
    const goal = [...ctx.runtime.goals.values()].reverse().find(goal => goal.spec.id === token || goal.spec.label === token || goal.spec.rawText.includes(token) || goal.spec.kind === 'production' && goal.spec.target === token)
    const target = goal?.spec.kind === 'production' ? goal.spec.target : catalog?.resolve(token)?.name ?? token
    queue.interrupt(operation => operation.capability === 'goal.edit' && operation.params.goalId === (goal?.spec.id ?? token)
      || operation.capability === 'production.produce' && (catalog?.resolve(operation.params.target)?.name ?? operation.params.target) === target, reason, signal)
  } else if (call.capability === 'skill.cancel') {
    const run = call.params.runId ? ctx.runtime.skillRuns.get(call.params.runId) : undefined
    const skillId = run?.skillId ?? (call.params.skillId ? prompts.skills.get(call.params.skillId)?.definition.id ?? call.params.skillId : undefined)
    queue.interrupt(operation => operation.capability === 'skill.run' && (!skillId || prompts.skills.get(operation.params.skillId)?.definition.id === skillId)
      && (!run || operation.params.formationId !== undefined && sameFormation(operation.params.formationId, run.formationId)), reason, signal)
  }
}
