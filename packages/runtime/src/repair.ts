import type { GoalView, RepairGoal, Snapshot, SnapshotUnit } from '@ra2c/contracts'

type Pair = { engineerId: number; vehicleId: number }
interface Job { unitId: number; targetId: number; x: number; y: number; hp: number; progressTick: number }
export interface RepairState { engineerIds: number[]; pairs: Pair[]; jobs: Job[]; avoid: Record<string, number> }
export const emptyRepairState = (): RepairState => ({ engineerIds: [], pairs: [], jobs: [], avoid: {} })

/** 只分配工作；本机处理器或回退脚本按同一分工发令。实际载员、血量与位置是唯一事实来源。 */
export function planRepairs(spec: RepairGoal, snap: Snapshot, memberIds: number[], previous: RepairState, waiting: boolean, followIds?: number[]): { state: RepairState; view: NonNullable<GoalView['repair']> } {
  const state = structuredClone(previous)
  const members = snap.self.filter(unit => memberIds.includes(unit.id))
  const vehicles = members.filter(unit => unit.type === 7 && spec.vehicleNames.includes(unit.name))
  const loadedIds = new Set(snap.self.flatMap(unit => unit.transport?.unitIds ?? []))
  const engineers = members.filter(unit => unit.type === 3 && spec.engineerNames.includes(unit.name) && !loadedIds.has(unit.id))
  state.engineerIds = [...new Set([...state.engineerIds, ...engineers.map(unit => unit.id), ...vehicles.flatMap(unit => unit.transport?.passengers?.filter(p => spec.engineerNames.includes(p.name)).map(p => p.id) ?? [])])]
  const ready = vehicles.filter(unit => unit.transport?.unitIds.some(id => state.engineerIds.includes(id)))
  const empty = vehicles.filter(unit => unit.transport && unit.transport.occupied === 0 && unit.transport.capacity > 0)
  state.pairs = state.pairs.filter(pair => engineers.some(unit => unit.id === pair.engineerId) && empty.some(unit => unit.id === pair.vehicleId))
  const distance = (a: SnapshotUnit, b: SnapshotUnit) => Math.hypot(a.rx - b.rx, a.ry - b.ry)
  for (const vehicle of empty) {
    if (state.pairs.some(pair => pair.vehicleId === vehicle.id)) continue
    const engineer = engineers.filter(unit => !state.pairs.some(pair => pair.engineerId === unit.id)).sort((a, b) => distance(a, vehicle) - distance(b, vehicle) || a.id - b.id)[0]
    if (engineer) state.pairs.push({ engineerId: engineer.id, vehicleId: vehicle.id })
  }
  const damaged = snap.self.filter(unit => unit.type === 7 && spec.tankNames.includes(unit.name) && unit.hitPoints! > 0 && unit.hitPoints! < unit.maxHitPoints! && (spec.targetId === undefined || spec.targetId === unit.id) && (!followIds || followIds.includes(unit.id)))
  state.avoid = Object.fromEntries(Object.entries(state.avoid).filter(([, until]) => until > snap.tick))
  state.jobs = state.jobs.filter(job => {
    const vehicle = ready.find(unit => unit.id === job.unitId), target = damaged.find(unit => unit.id === job.targetId)
    if (!vehicle || !target || vehicle.id === target.id) return false
    if (Math.hypot(vehicle.rx - job.x, vehicle.ry - job.y) >= 0.5 || target.hitPoints! > job.hp) {
      job.x = vehicle.rx; job.y = vehicle.ry; job.hp = target.hitPoints!; job.progressTick = snap.tick
    }
    if (snap.tick - job.progressTick < spec.policy.stallTicks) return true
    state.avoid[`${job.unitId}:${job.targetId}`] = snap.tick + spec.policy.retryTicks
    return false
  })
  // 原先协修的成员在新伤员出现时也应分开；仍有效的独立分工保持稳定。
  const claimed = new Set<number>()
  state.jobs = state.jobs.filter(job => {
    if (claimed.has(job.targetId) && damaged.some(target => !claimed.has(target.id))) return false
    claimed.add(job.targetId); return true
  })
  for (const vehicle of ready) {
    if (state.jobs.some(job => job.unitId === vehicle.id)) continue
    const candidates = damaged.filter(unit => unit.id !== vehicle.id && !state.avoid[`${vehicle.id}:${unit.id}`])
    const free = candidates.filter(target => !state.jobs.some(job => job.targetId === target.id))
    const target = (free.length ? free : candidates).sort((a, b) => distance(vehicle, a) - distance(vehicle, b) || a.hitPoints! / a.maxHitPoints! - b.hitPoints! / b.maxHitPoints! || a.id - b.id)[0]
    if (target) state.jobs.push({ unitId: vehicle.id, targetId: target.id, x: vehicle.rx, y: vehicle.ry, hp: target.hitPoints!, progressTick: snap.tick })
  }
  const follow = followIds && snap.self.filter(unit => followIds.includes(unit.id) && [1, 3, 7].includes(unit.type))
  // 靠近被支援队主体；不对其成员下令。
  const center = follow?.length ? { x: Math.round(follow.reduce((n, unit) => n + unit.rx, 0) / follow.length), y: Math.round(follow.reduce((n, unit) => n + unit.ry, 0) / follow.length) } : undefined
  return { state, view: { readyIds: ready.map(unit => unit.id), assembling: state.pairs, targets: state.jobs.map(({ unitId, targetId }) => ({ unitId, targetId })), damaged: damaged.map(unit => ({ id: unit.id, hitPoints: unit.hitPoints!, maxHitPoints: unit.maxHitPoints! })), waiting, ...(center ? { follow: center } : {}) } }
}
