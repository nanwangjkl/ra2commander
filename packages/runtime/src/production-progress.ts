import type { ProductionGoal, Snapshot } from '@ra2c/contracts'
import type { ProductionRecord } from './state.ts'

export function submitted(records: ProductionRecord[], goalId: string, name: string): number {
  return records.filter(r => r.goalId === goalId && r.name === name && r.state !== 'rejected').reduce((n, r) => n + r.quantity, 0)
}

export function productionProgress(goal: ProductionGoal, records: ProductionRecord[], snap: Snapshot) {
  const remaining: Record<string, number> = Object.create(null)
  const sent: Record<string, number> = Object.create(null)
  const observed: Record<string, number[]> = Object.create(null)
  const uncertain: string[] = []
  for (const name of [...new Set([...goal.prerequisites, goal.target])]) {
    const own = records.filter(r => r.name === name && r.state !== 'rejected' && (name !== goal.target || r.goalId === goal.id))
    sent[name] = own.reduce((n, r) => n + r.quantity, 0)
    observed[name] = [...new Set(own.flatMap(r => r.observedIds))]
    if (name !== goal.target && snap.self.some(u => u.type === 2 && u.name === name)) observed[name] = snap.self.filter(u => u.type === 2 && u.name === name).map(u => u.id)
    remaining[name] = name === goal.target ? Math.max(0, goal.quantity - sent[name]!) : sent[name] || observed[name]!.length ? 0 : 1
    if (own.some(r => r.state === 'reserved' || r.state === 'unknown')) uncertain.push(name)
  }
  // 同名产物缺少可靠出生事件，前一个提交尚未观察完成时不再提交同名目标。
  const earlier = records.find(r => r.name === goal.target && r.goalId !== goal.id && r.state !== 'rejected' && r.observedIds.length < r.quantity)
  const blocked = earlier ? `等待同名目标 ${earlier.goalId} 的产出确认` : undefined
  if (blocked) remaining[goal.target] = 0
  return { remaining, sent, observed, uncertain, blocked }
}

/** 只累计首次出现的身份，损失和换代码都不会减少累计产出。 */
export function observeProduction(records: ProductionRecord[], seen: Set<number>, snap: Snapshot, converted: Set<number>): void {
  for (const unit of snap.self) {
    if (seen.has(unit.id)) continue
    seen.add(unit.id)
    if (converted.has(unit.id)) continue
    const candidates = records.filter(r => r.name === unit.name && r.state !== 'rejected' && r.observedIds.length < r.quantity)
    // 有多个可能来源时保持未确认；不凭猜测完成目标或自动追加生产。
    if (candidates.length && new Set(candidates.map(r => r.goalId)).size === 1) {
      candidates[0]!.observedIds.push(unit.id)
      if (unit.type === 2) candidates[0]!.placed = true
    }
  }
}
