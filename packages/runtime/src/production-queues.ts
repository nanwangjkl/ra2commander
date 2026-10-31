import type { ActionRequest, ActionResult, GoalView, Snapshot } from '@ra2c/contracts'
import type { GoalState } from './state.ts'
import type { GoalContext } from './goals/types.ts'
import { pendingProduction } from './production-cancellation.ts'

export type QueueRequest = Extract<ActionRequest, { kind: 'pauseQueue' | 'resumeQueue' }>
interface QueueOrder { kind: QueueRequest['kind']; state: 'prepared' | 'sent' | 'unknown'; seq: number }
export interface QueueControlState { orders: Record<string, QueueOrder> }
const labels = ['建筑', '防御建筑', '步兵', '战车', '飞机', '舰船']

export function queueControlDetail(goal: GoalState, owners: ReadonlyMap<number, string>, restoring = true): string | undefined {
  const awaiting = Object.entries(goal.facts.queueControl?.orders ?? {})
  return awaiting.length ? `等待${awaiting.map(([type, order]) => `${order.kind === 'pauseQueue' ? '暂停' : '恢复'}${labels[Number(type)]}队列${order.state === 'unknown' ? '（回执待确认）' : ''}`).join('、')}`
    : restoring && [...owners.values()].includes(goal.spec.id) ? '生产已结束，等待恢复本目标暂停的队列' : undefined
}

export function validateQueueControl(state: QueueControlState | undefined): void {
  if (state === undefined) return
  if (!state || !state.orders || typeof state.orders !== 'object' || Array.isArray(state.orders)
    || Object.entries(state.orders).some(([type, order]) => !/^[0-5]$/.test(type) || !order || !['pauseQueue', 'resumeQueue'].includes(order.kind) || !['prepared', 'sent', 'unknown'].includes(order.state) || !Number.isSafeInteger(order.seq) || order.seq < 0)) throw new Error('生产队列控制进度非法')
}

/** 只规划玩家指定的其他队列；本目标的剩余项目和在建共享前置不能被自己暂停。 */
export function planQueueControl(ctx: GoalContext<'production'>, remaining: Record<string, number>): NonNullable<NonNullable<GoalView['productionPlan']>['queueControl']> {
  const { spec, snap, goal, production, pausedQueues } = ctx
  const prerequisites = new Set(spec.prerequisites.filter(name => !snap.production?.available.includes(spec.target) && !snap.self.some(unit => unit.type === 2 && unit.name === name)))
  const pending = production.filter(record => (record.name === spec.target ? record.goalId === spec.id : prerequisites.has(record.name)) && record.state !== 'rejected' && pendingProduction(record) > 0)
  const needed = new Set([...Object.keys(remaining).filter(name => remaining[name]! > 0).map(name => spec.queueTypes?.[name] ?? (name === spec.target ? spec.targetType === 2 ? 0 : spec.targetType === 3 ? 2 : spec.targetType === 1 ? 4 : 3 : 0)), ...pending.map(record => record.queueType ?? (record.building ? 0 : 3))])
  const working = Object.values(remaining).some(quantity => quantity > 0) || pending.length > 0
  const actions: QueueRequest[] = []
  const orders = goal.facts.queueControl?.orders ?? {}
  for (const type of spec.queues) {
    const queue = snap.production?.queues.find(queue => queue.type === type), owner = pausedQueues.get(type)
    if (!queue || orders[type]) continue
    if (owner === spec.id && (!working || needed.has(type)) && queue.status === 2) actions.push({ kind: 'resumeQueue', queueType: type })
    else if (!owner && working && !needed.has(type) && queue.status === 1 && queue.size > 0) actions.push({ kind: 'pauseQueue', queueType: type })
  }
  const restoring = !working && [...pausedQueues.values()].includes(spec.id)
  const awaiting = Object.entries(orders)
  const detail = queueControlDetail(goal, pausedQueues, restoring)
  return { actions, pending: awaiting.length > 0 || restoring, ...(detail ? { detail } : {}) }
}

export function reserveQueueOrder(goal: GoalState, request: QueueRequest, snap: Snapshot, owners: ReadonlyMap<number, string>, goals: ReadonlyMap<string, GoalState>): QueueOrder | undefined {
  const spec = goal.activeSpec ?? goal.spec, queue = snap.production?.queues.find(queue => queue.type === request.queueType)
  if (spec.kind !== 'production' || !spec.queues.includes(request.queueType) || !queue || goal.facts.queueControl?.orders[request.queueType]) return
  if ([...goals.values()].some(other => other !== goal && other.facts.queueControl?.orders[request.queueType])) return
  if (request.kind === 'pauseQueue' && (goal.status !== 'active' || queue.status !== 1 || queue.size === 0 || owners.has(request.queueType))) return
  if (request.kind === 'resumeQueue' && (owners.get(request.queueType) !== spec.id || queue.status !== 2)) return
  const order: QueueOrder = { kind: request.kind, state: 'prepared', seq: snap.seq }
  goal.facts.queueControl ??= { orders: {} }
  goal.facts.queueControl.orders[request.queueType] = order
  return order
}

export function recordQueueOrder(goal: GoalState, type: number, order: QueueOrder, results: ActionResult[], owners: Map<number, string>): void {
  if (goal.facts.queueControl?.orders[type] !== order) return
  const notSent = !results.length || results.every(result => result.submitted === 0 && (result.ok || ['stale-session', 'stale-snapshot', 'revoked-or-no-snapshot', 'no-api'].includes(result.reason ?? '')))
  if (notSent) { delete goal.facts.queueControl.orders[type]; return }
  order.state = results.every(result => result.ok) && results.some(result => result.submitted > 0) ? 'sent' : 'unknown'
  if (order.state === 'sent' && order.kind === 'pauseQueue') owners.set(type, goal.spec.id)
}

/** 观察确认与下单回执分开。未知暂停不据此认领，不能拿玩家的暂停当作自己的。 */
export function observeQueueControl(goals: ReadonlyMap<string, GoalState>, owners: Map<number, string>, snap: Snapshot): void {
  for (const goal of goals.values()) {
    const orders = goal.facts.queueControl?.orders
    if (!orders) continue
    for (const [key, order] of Object.entries(orders)) {
      const type = Number(key), queue = snap.production?.queues.find(queue => queue.type === type)
      if (!queue) continue
      if (order.state === 'prepared') order.state = 'unknown'
      if (order.kind === 'resumeQueue' && queue.status !== 2) {
        if (owners.get(type) === goal.spec.id) owners.delete(type)
        delete orders[key]
      } else if (order.kind === 'pauseQueue' && order.state === 'sent' && (queue.status === 2 || queue.size === 0 || queue.status === 3)) delete orders[key]
    }
  }
  for (const [type, id] of owners) {
    const queue = snap.production?.queues.find(queue => queue.type === type)
    const order = goals.get(id)?.facts.queueControl?.orders[type]
    if (queue && queue.status !== 2 && order?.kind !== 'pauseQueue') owners.delete(type)
  }
}
