import type { GoalState, ProductionRecord } from './state.ts'
import type { Snapshot } from '@ra2c/contracts'

/** 保留原始提交量；只有实际撤队列确认后才关闭其未完成额度。 */
export const effectiveQuantity = (record: ProductionRecord): number => record.quantity - (record.cancelledQuantity ?? 0)
export const pendingProduction = (record: ProductionRecord): number => record.state === 'rejected' ? 0 : Math.max(0, effectiveQuantity(record) - record.observedIds.length)
export const queueQuantity = (snap: Snapshot, name: string, queueType: number): number | undefined => snap.production?.queues.find(queue => queue.type === queueType)?.items.filter(item => item.name === name).reduce((n, item) => n + item.quantity, 0)

/** 先观察新产物，再从队列减少量中扣除正常完工，不能把完工当作撤销。 */
export function observeCancellations(records: ProductionRecord[], snap: Snapshot): void {
  for (const record of records) {
    const ticket = record.cancellation
    if (!ticket || ticket.state === 'confirmed' || snap.seq <= ticket.seq) continue
    const queued = queueQuantity(snap, record.name, ticket.queueType)
    if (queued === undefined) continue
    for (const unit of snap.self) if (unit.name === record.name && !ticket.knownIds.includes(unit.id)) { ticket.knownIds.push(unit.id); ticket.born++ }
    const removed = Math.max(0, ticket.before - queued - ticket.born)
    if (removed + record.observedIds.length - ticket.observed >= ticket.quantity || queued === 0 && removed > 0) {
      ticket.removed = Math.min(ticket.quantity, removed, pendingProduction(record))
      record.cancelledQuantity = (record.cancelledQuantity ?? 0) + ticket.removed
      ticket.state = 'confirmed'
    }
  }
}

export function prepareCancellation(record: ProductionRecord, records: ProductionRecord[], snap: Snapshot): boolean {
  if (record.state === 'reserved' || record.cancellation && record.cancellation.state !== 'confirmed' || !pendingProduction(record)) return false
  // 同名撤销串行确认，避免用同一次队列减少量冲销多个提交。
  if (records.some(other => other.name === record.name && other.cancellation && other.cancellation.state !== 'confirmed')) return false
  const queue = snap.production?.queues.find(queue => (record.queueType === undefined || queue.type === record.queueType) && queue.items.some(item => item.name === record.name))
  if (!queue) return false
  const before = queueQuantity(snap, record.name, queue.type)!, quantity = Math.min(before, pendingProduction(record))
  if (!quantity) return false
  record.cancellation = { state: 'prepared', quantity, before, queueType: queue.type, seq: snap.seq, tick: snap.tick, observed: record.observedIds.length,
    knownIds: snap.self.filter(unit => unit.name === record.name).map(unit => unit.id), born: 0 }
  return true
}

export function cancellationDetail(goal: GoalState, records: ProductionRecord[]): string {
  const own = records.filter(record => record.goalId === goal.spec.id && record.state !== 'rejected')
  const removed = own.reduce((n, record) => n + (record.cancelledQuantity ?? 0), 0)
  const pending = own.reduce((n, record) => n + pendingProduction(record), 0)
  return `${goal.facts.cancelReason ?? '目标已取消'}；已停止追加${removed ? `；已确认撤销排队${removed}个` : ''}${pending ? `；剩余提交${pending}个等待队列撤销确认${goal.facts.blocked ? `（${goal.facts.blocked}）` : ''}` : removed ? '' : '；没有待撤销的已入队项目'}`
}

export function validateCancellation(record: ProductionRecord): void {
  const integer = (value: number) => Number.isSafeInteger(value) && value >= 0
  if (record.cancelledQuantity !== undefined && (!integer(record.cancelledQuantity) || record.cancelledQuantity + record.observedIds.length > record.quantity)) throw new Error('生产撤销量非法')
  const ticket = record.cancellation
  if (!ticket) return
  if (!['prepared', 'sent', 'unknown', 'confirmed'].includes(ticket.state) || !integer(ticket.quantity) || ticket.quantity < 1 || !integer(ticket.before) || ticket.before < ticket.quantity
    || !integer(ticket.queueType) || ticket.queueType > 5 || !integer(ticket.seq) || !Number.isFinite(ticket.tick) || !integer(ticket.observed) || ticket.observed > record.quantity
    || !Array.isArray(ticket.knownIds) || ticket.knownIds.some(id => !integer(id)) || !integer(ticket.born)
    || ticket.removed !== undefined && (!integer(ticket.removed) || ticket.removed > ticket.quantity || ticket.removed > (record.cancelledQuantity ?? 0)) || ticket.state === 'confirmed' && ticket.removed === undefined) throw new Error('生产撤销记录非法')
}
