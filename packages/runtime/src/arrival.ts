import type { ArrivalState, SnapshotUnit } from '@ra2c/contracts'

/** 按阵型占地扩大到达范围；主体已到时不让少量拥堵、掉队成员卡住整条路线。 */
export function assessArrival(
  units: readonly SnapshotUnit[],
  destination: { x: number; y: number },
  unavailable: (id: number) => boolean = () => false,
): ArrivalState {
  const total = units.length
  const radius = Math.max(3, Math.ceil(2.5 * Math.sqrt(total)))
  const required = Math.ceil(total * 0.8)
  const laggingUnitIds = units.filter(unit => {
    const distance = Math.hypot(unit.rx - destination.x, unit.ry - destination.y)
    return unavailable(unit.id) || !Number.isFinite(distance) || distance > radius
  }).map(unit => unit.id)
  const nearby = total - laggingUnitIds.length
  return { reached: total > 0 && nearby >= required, radius, nearby, required, total, laggingUnitIds }
}
