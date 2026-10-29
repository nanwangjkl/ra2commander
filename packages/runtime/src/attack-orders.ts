import { canAttackTarget, type ActionRequest, type Snapshot, type SnapshotUnit } from '@ra2c/contracts'
import type { CoverMotion } from './cover.ts'

/** 每名就绪成员直接攻击最近的兼容目标；不以射程或整队到达作为前置。 */
export function directAttackOrders(snap: Snapshot, ids: number[], targets: readonly SnapshotUnit[], motion: CoverMotion): ActionRequest[] {
  const groups = new Map<number, number[]>()
  for (const unit of snap.self.filter(unit => ids.includes(unit.id))) {
    const target = targets.filter(target => canAttackTarget(unit, target)).slice().sort((a, b) => Math.hypot(unit.rx - a.rx, unit.ry - a.ry) - Math.hypot(unit.rx - b.rx, unit.ry - b.ry) || a.id - b.id)[0]
    if (!target) continue
    const old = motion.orders[unit.id]
    if (old?.kind === 'attack' && old.targetId === target.id && !unit.isIdle) continue
    groups.set(target.id, [...(groups.get(target.id) ?? []), unit.id])
  }
  return [...groups].map(([targetId, unitIds]) => ({ kind: 'attack', targetId, unitIds }))
}
