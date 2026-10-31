import { matchesPlacement, inTargetRegion, type GoalView, type ProductionGoal, type Snapshot } from '@ra2c/contracts'
import type { GoalState, ProductionRecord } from './state.ts'
import { effectiveQuantity, pendingProduction } from './production-cancellation.ts'

export function submitted(records: readonly ProductionRecord[], goalId: string, name: string): number {
  return records.filter(r => r.goalId === goalId && r.name === name && r.state !== 'rejected').reduce((n, r) => n + r.quantity, 0)
}

export function productionProgress(goal: ProductionGoal, records: readonly ProductionRecord[], snap: Snapshot, goals?: ReadonlyMap<string, GoalState>) {
  const remaining: Record<string, number> = Object.create(null)
  const sent: Record<string, number> = Object.create(null)
  const observed: Record<string, number[]> = Object.create(null)
  const uncertain: string[] = []
  let powerPlan: NonNullable<GoalView['productionPlan']>['power']
  let quantity = goal.quantity
  if (goal.maintainPower && snap.production) {
    const own = records.filter(r => r.goalId === goal.id && r.name === goal.target && r.state !== 'rejected')
    const count = own.reduce((n, r) => n + effectiveQuantity(r), 0)
    // 共享前置可能先归到尚未准备完的显式建设目标，仍可复用其他已准备来源的规则。
    const powerCosts: Record<string, number> = { [goal.target]: goal.maintainPower.output, ...goal.powerCosts }
    for (const other of goals?.values() ?? []) {
      const spec = other.activeSpec ?? other.spec
      if (spec.kind === 'production') Object.assign(powerCosts, spec.powerCosts)
      if (spec.kind === 'production' && spec.maintainPower) powerCosts[spec.target] ??= spec.maintainPower.output
    }
    const future = records.reduce((sum, record) => {
      if (!record.building || record.state === 'rejected') return sum
      // 使用该提交来源的规则，覆盖本机与脚本；已落地的建筑不再次计入。
      const owner = goals?.get(record.goalId), spec = owner?.activeSpec ?? owner?.spec
      const cost = spec?.kind === 'production' ? spec.powerCosts?.[record.name] ?? (spec.maintainPower && spec.target === record.name ? spec.maintainPower.output : undefined) ?? powerCosts[record.name] ?? 0 : powerCosts[record.name] ?? 0
      const pending = pendingProduction(record)
      sum.drain += Math.max(0, -cost) * pending
      sum.output += Math.max(0, cost) * pending
      sum.uncertain ||= pending > 0 && cost !== 0 && (record.state === 'reserved' || record.state === 'unknown')
      return sum
    }, { drain: 0, output: 0, uncertain: false })
    const power = snap.production.power
    const needed = Math.max(0, Math.ceil((power.drain + future.drain + goal.maintainPower.reserve - power.total - future.output) / goal.maintainPower.output))
    quantity = count + needed
    powerPlan = { additional: needed, futureDrain: future.drain, futureOutput: future.output, margin: power.total - power.drain, reserve: goal.maintainPower.reserve, uncertain: future.uncertain }
  }
  for (const name of [...new Set([...goal.prerequisites, goal.target])]) {
    const own = records.filter(r => r.name === name && r.state !== 'rejected' && (name !== goal.target || r.goalId === goal.id))
    sent[name] = own.reduce((n, r) => n + effectiveQuantity(r), 0)
    observed[name] = [...new Set(own.flatMap(r => r.observedIds))]
    if (name !== goal.target && snap.self.some(u => u.type === 2 && u.name === name)) observed[name] = snap.self.filter(u => u.type === 2 && u.name === name).map(u => u.id)
    remaining[name] = name === goal.target ? Math.max(0, quantity - sent[name]!) : sent[name] || observed[name]!.length || snap.production?.available.includes(goal.target) ? 0 : 1
    if (own.some(r => pendingProduction(r) > 0 && (r.state === 'reserved' || r.state === 'unknown'))) uncertain.push(name)
  }
  // 同名产物缺少可靠出生事件，前一个提交尚未观察完成时不再提交同名目标。
  const earlier = (remaining[goal.target] ?? 0) > 0 ? records.find(r => r.name === goal.target && r.goalId !== goal.id && pendingProduction(r) > 0) : undefined
  const blocked = earlier ? `等待同名目标 ${earlier.goalId} 的产出确认` : undefined
  if (blocked) remaining[goal.target] = 0
  const positions = goal.placement || goal.placementRegion ? records.filter(r => r.goalId === goal.id && r.name === goal.target && r.state !== 'rejected').flatMap(record => record.placementResults ?? []).slice(0, quantity) : []
  const placement = goal.placement || goal.placementRegion ? { completed: positions.filter(result => result.matched).length, total: quantity, mismatchedIds: positions.filter(result => !result.matched).map(result => result.unitId) } : undefined
  return { remaining, sent, observed, uncertain, blocked, placement, ...(powerPlan ? { power: powerPlan } : {}) }
}

/** 只累计首次出现的身份，损失和换代码都不会减少累计产出。 */
export function observeProduction(records: ProductionRecord[], seen: Set<number>, snap: Snapshot, converted: Set<number>): void {
  for (const unit of snap.self) {
    if (seen.has(unit.id)) continue
    seen.add(unit.id)
    if (converted.has(unit.id)) continue
    const candidates = records.filter(r => r.name === unit.name && pendingProduction(r) > 0)
    // 有多个可能来源时保持未确认；不凭猜测完成目标或自动追加生产。
    if (candidates.length && new Set(candidates.map(r => r.goalId)).size === 1) {
      const record = candidates[0]!, index = record.observedIds.length
      record.observedIds.push(unit.id)
      if (unit.type === 2) {
        record.placed = record.observedIds.length >= record.quantity
        const direction = record.placement?.directions[index]
        if (record.placement && direction || record.placementRegion) {
          const point = { x: unit.rx, y: unit.ry, ...(unit.elevation !== undefined ? { elevation: unit.elevation } : {}) }
          record.placementResults ??= []
          record.placementResults.push({ unitId: unit.id, ...point, matched: (!record.placement || !!direction && matchesPlacement({ anchor: record.placement.anchor, direction }, point)) && (!record.placementRegion || inTargetRegion(point.x, point.y, record.placementRegion)) })
        }
      }
    }
  }
}
