import { canAttackTarget, type ActionRequest, type Snapshot, type SnapshotUnit } from '@ra2c/contracts'
import type { UnitOrderState } from './unit-orders.ts'

/** 编队可共用稳定主目标；不以射程或整队到达作为前置，空地不兼容者另选相容目标。 */
export function directAttackOrders(snap: Snapshot, ids: number[], targets: readonly SnapshotUnit[], motion: UnitOrderState, focus=false,
  eligible: (unit: SnapshotUnit, target: SnapshotUnit) => boolean = () => true): ActionRequest[] {
  const groups = new Map<number, number[]>()
  const units=snap.self.filter(unit=>ids.includes(unit.id))
  const center={rx:units.reduce((n,u)=>n+u.rx,0)/Math.max(1,units.length),ry:units.reduce((n,u)=>n+u.ry,0)/Math.max(1,units.length)}
  const distance=(a:{rx:number;ry:number},b:{rx:number;ry:number})=>Math.hypot(a.rx-b.rx,a.ry-b.ry)
  const compatible=(unit:SnapshotUnit,target:SnapshotUnit)=>canAttackTarget(unit,target)&&eligible(unit,target)
  const candidates=targets.filter(target=>units.some(unit=>compatible(unit,target)))
  const primary=focus?(candidates.find(target=>target.id===motion.focusTargetId)??candidates.slice().sort((a,b)=>units.filter(u=>compatible(u,b)).length-units.filter(u=>compatible(u,a)).length||distance(center,a)-distance(center,b)||a.id-b.id)[0]):undefined
  if(primary)motion.focusTargetId=primary.id
  else delete motion.focusTargetId
  for (const unit of units) {
    const target = primary&&compatible(unit,primary)?primary:targets.filter(target => compatible(unit, target)).slice().sort((a, b) => distance(focus?center:unit,a)-distance(focus?center:unit,b) || a.id - b.id)[0]
    if (!target) continue
    const old = motion.orders[unit.id]
    if (old?.kind === 'attack' && old.targetId === target.id && !unit.isIdle) continue
    groups.set(target.id, [...(groups.get(target.id) ?? []), unit.id])
  }
  return [...groups].map(([targetId, unitIds]) => ({ kind: 'attack', targetId, unitIds }))
}

/** 持续守卫只追击当前匹配目标；离区、消失或无目标时结束旧追击，不去中心集结。 */
export function guardAttackOrders(snap: Snapshot, ids: number[], targets: readonly SnapshotUnit[], motion: UnitOrderState, focus = false): ActionRequest[] {
  const attacks = directAttackOrders(snap, ids, targets, motion, focus)
  const stops = snap.self.filter(unit => ids.includes(unit.id)
    && (!targets.length || ['attack', 'crush'].includes(motion.orders[unit.id]?.kind ?? '') && !targets.some(target => target.id === motion.orders[unit.id]?.targetId))
    && !attacks.some(action => 'unitIds' in action && action.unitIds.includes(unit.id))
    && (motion.orders[unit.id]?.kind === 'attack' || motion.orders[unit.id]?.kind === 'crush' || motion.orders[unit.id]?.kind === 'move' || !unit.isIdle && (motion.orders[unit.id]?.kind !== 'stop' || snap.tick - motion.orders[unit.id]!.tick >= 90))).map(unit => unit.id)
  return [...attacks, ...(stops.length ? [{ kind: 'stop' as const, unitIds: stops }] : [])]
}
