import type { ActionRequest, ActionResult, Snapshot } from '@ra2c/contracts'
import type { GoalFacts, ProgramState } from './state.ts'

export interface UnitOrderState {
  orders: Record<string, { kind: 'move' | 'stop' | 'attack' | 'crush' | 'enterTransport' | 'repair'; x?: number; y?: number; targetId?: number; tick: number }>
  focusTargetId?: number
}
export const emptyUnitOrders = (): UnitOrderState => ({ orders: {} })

export function pruneUnitOrders(state: UnitOrderState | undefined, present: ReadonlySet<number>): void {
  if (state) for (const id of Object.keys(state.orders)) if (!present.has(Number(id))) delete state.orders[id]
}

export function validateUnitOrders(state: UnitOrderState | undefined): void {
  if (state === undefined) return
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('单位发令记录非法')
  if (state.focusTargetId !== undefined && !Number.isSafeInteger(state.focusTargetId)) throw new Error('编队主目标非法')
  if (!state.orders || typeof state.orders !== 'object' || Array.isArray(state.orders)
    || Object.values(state.orders).some(order => !order || !['move', 'stop', 'attack', 'crush', 'enterTransport', 'repair'].includes(order.kind) || !Number.isFinite(order.tick)
      || order.kind === 'move' && (!Number.isFinite(order.x) || !Number.isFinite(order.y))
      || ['attack', 'crush', 'enterTransport', 'repair'].includes(order.kind) && !Number.isSafeInteger(order.targetId))) throw new Error('单位发令记录非法')
}

/** 只有实际成功的回执才能更新去重记录；计划中的动作不算已发送。 */
export function recordUnitOrder(state: UnitOrderState, request: ActionRequest, tick: number, results: ActionResult[]): void {
  if (!results.length || results.some(result => !result.ok) || !results.some(result => (result.submitted ?? 1) > 0)
    || request.kind !== 'move' && request.kind !== 'stop' && request.kind !== 'attack' && request.kind !== 'crush' && request.kind !== 'enterTransport' && request.kind !== 'repair') return
  for (const id of request.unitIds) state.orders[id] = { kind: request.kind, tick,
    ...(request.kind === 'move' ? { x: request.x, y: request.y } : request.kind !== 'stop' ? { targetId: request.targetId } : {}) }
}

/** 普通行军直接发往目的地，空闲且尚未抵达时有限频率重发。 */
export function moveOrders(snap: Snapshot, ids: number[], destination: { x: number; y: number }, state: UnitOrderState, retryTicks = 90): ActionRequest[] {
  const moving = snap.self.filter(unit => ids.includes(unit.id)).filter(unit => {
    const old = state.orders[unit.id]
    return !old || old.kind !== 'move' || old.x !== destination.x || old.y !== destination.y
      || unit.isIdle && Math.hypot(unit.rx - destination.x, unit.ry - destination.y) > 2 && snap.tick - old.tick >= retryTicks
  }).map(unit => unit.id)
  return moving.length ? [{ kind: 'move', unitIds: moving, x: destination.x, y: destination.y }] : []
}

interface AcceptedOrder { goalId: string; request: ActionRequest; owner: string; revision: number; generation: number }
/** 同一回执更新目标去重记录及让路恢复索引；后者只在当前进程内有效。 */
export class UnitOrderBook {
  private readonly accepted = new Map<number, AcceptedOrder>()
  clear(): void { this.accepted.clear() }
  get(id: number): AcceptedOrder | undefined { return this.accepted.get(id) }
  record(goalId: string, program: ProgramState, request: ActionRequest, snap: Snapshot, results: ActionResult[], state?: UnitOrderState): void {
    if (state) recordUnitOrder(state, request, snap.tick, results)
    if (!results.length || results.some(result => !result.ok)) return
    // 强移完成后重新按当前目标规划，不从出口让路旁路恢复旧强移。
    if (request.kind === 'crush') for (const id of request.unitIds) this.accepted.delete(id)
    if ('unitIds' in request && ['move', 'attackMove', 'attack', 'guard'].includes(request.kind)) {
      for (const id of request.unitIds) this.accepted.set(id, { goalId, request: { ...request, unitIds: [id] }, owner: program.id, revision: program.revision, generation: program.generation })
    }
  }
}

/** 仅用于旧 v3/v4 检查点读入；新运行不在掩护状态里保存发令事实。 */
export function migrateLegacyUnitOrders(facts: GoalFacts): void {
  const legacy = facts.coverMotion as (NonNullable<GoalFacts['coverMotion']> & Partial<UnitOrderState>) | undefined
  if (!legacy || !Object.hasOwn(legacy, 'orders')) return
  const { orders, focusTargetId, ...motion } = legacy
  facts.unitOrders ??= { orders: orders!, ...(focusTargetId !== undefined ? { focusTargetId } : {}) }
  facts.coverMotion = motion
}
