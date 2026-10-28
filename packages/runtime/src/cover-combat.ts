import type { ActionRequest, CoverPolicy, GoalView, Region, Snapshot, SnapshotUnit } from '@ra2c/contracts'
import { coverMembers, coverMoves, type CoverMotion } from './cover.ts'

export interface CoverRange { unitId: number; targetId: number; canAttack: boolean; inRange: boolean }
export interface CoverIntent {
  destination?: { x: number; y: number } | undefined
  targets: SnapshotUnit[]
  threats: SnapshotUnit[]
  region: Region
  waiting: boolean
}
const distance = (a: { rx: number; ry: number }, b: { rx: number; ry: number }) => Math.hypot(a.rx - b.rx, a.ry - b.ry)
export const airborne = (unit: SnapshotUnit) => unit.zone === 1 || unit.type === 1

/** 只查询本队附近候选；较大编队轮换查询，避免单位×全图敌人的笛卡尔积。 */
export function coverRangePairs(policy: CoverPolicy, snap: Snapshot, ids: number[], intent: CoverIntent, previous: CoverMotion) {
  const { members } = coverMembers(policy, snap, ids)
  const start = members.length ? Math.floor(snap.tick / 15) % members.length : 0
  return [...members.slice(start), ...members.slice(0, start)].flatMap(unit => {
    const byDistance = (a: SnapshotUnit, b: SnapshotUnit) => distance(unit, a) - distance(unit, b) || a.id - b.id
    const escort = policy.escortIds.includes(unit.id)
    const followed = Object.values(previous.orders).flatMap(order => order.kind === 'attack' ? intent.targets.filter(target => target.id === order.targetId) : [])
    const candidates = escort ? [...intent.threats.filter(airborne).sort(byDistance).slice(0, 2), ...followed.sort(byDistance).slice(0, 1)] : intent.targets.slice().sort(byDistance).slice(0, 3)
    return [...new Set(candidates.map(target => target.id))].map(targetId => ({ unitId: unit.id, targetId }))
  }).slice(0, 64)
}

/** 行军、受护成员进攻和近身掩护只有这一处产生最终动作。 */
export function coverCombat(policy: CoverPolicy, snap: Snapshot, ids: number[], intent: CoverIntent, previous: CoverMotion, ranges: readonly CoverRange[]) {
  const { members, escorts, protectedUnits, slowest } = coverMembers(policy, snap, ids)
  const center = protectedUnits.length ? { rx: protectedUnits.reduce((n, u) => n + u.rx, 0) / protectedUnits.length, ry: protectedUnits.reduce((n, u) => n + u.ry, 0) / protectedUnits.length } : { rx: 0, ry: 0 }
  const byCenter = (a: SnapshotUnit, b: SnapshotUnit) => distance(center, a) - distance(center, b) || a.id - b.id
  const nearest = intent.targets.slice().sort(byCenter)[0]
  const threat = intent.threats.slice().sort(byCenter)[0]
  const destination = nearest ? { x: nearest.rx, y: nearest.ry } : intent.destination
  const moving = !!destination && !intent.waiting
  const inRange = (unit: SnapshotUnit, target: SnapshotUnit) => ranges.some(range => range.unitId === unit.id && range.targetId === target.id && range.canAttack && range.inRange)
  const engaged = protectedUnits.some(unit => intent.targets.some(target => inRange(unit, target)))
  const nearbyThreat = !!threat && distance(center, threat) <= Math.max(0, ...members.map(unit => Math.max(unit.primaryWeapon?.maxRange ?? 0, unit.secondaryWeapon?.maxRange ?? 0))) + policy.gap
  const marching = moving && !engaged && !nearbyThreat
  const plan = coverMoves(policy, snap, ids, destination ?? { x: Math.round(center.rx), y: Math.round(center.ry) }, previous, { region: intent.region, ...(threat ? { threat } : {}) })
  const state = plan.state, desired = new Map<number, ActionRequest>(), held = new Set(state.heldIds)
  state.positions = Object.fromEntries(members.map(unit => {
    const last = previous.positions?.[unit.id], order = previous.orders[unit.id]
    if (!last || distance(unit, { rx: last.x, ry: last.y }) >= 0.5) return [unit.id, { x: unit.rx, y: unit.ry, tick: snap.tick, stalls: 0 }]
    if (order?.kind !== 'move' || held.has(unit.id) || Math.hypot(unit.rx - order.x!, unit.ry - order.y!) <= 2) return [unit.id, last.stalls ? { ...last, tick: snap.tick, stalls: 0 } : last]
    return [unit.id, snap.tick - last.tick >= policy.retryTicks ? { ...last, tick: snap.tick, stalls: Math.min(4, last.stalls + 1) } : last]
  }))
  const changed = (unit: SnapshotUnit, request: ActionRequest) => {
    const old = previous.orders[unit.id]
    if (!old || old.kind !== request.kind) return true
    if (request.kind === 'attack') return old.targetId !== request.targetId || unit.isIdle
    if (request.kind === 'move') return Math.hypot((old.x ?? -1000) - request.x, (old.y ?? -1000) - request.y) >= 1.5 || unit.isIdle && distance(unit, { rx: request.x, ry: request.y }) > 2 && snap.tick - old.tick >= policy.retryTicks
    return !unit.isIdle && snap.tick - old.tick >= 15
  }
  const offer = (unit: SnapshotUnit, request: ActionRequest) => { if (changed(unit, request)) desired.set(unit.id, request) }
  const stop = (unit: SnapshotUnit) => { if (!unit.isIdle || previous.orders[unit.id]?.kind === 'attack' || previous.orders[unit.id]?.kind === 'move') offer(unit, { kind: 'stop', unitIds: [unit.id] }) }
  const clip = (x: number, y: number) => ({ x: Math.max(intent.region.x1, Math.min(intent.region.x2, Math.round(x))), y: Math.max(intent.region.y1, Math.min(intent.region.y2, Math.round(y))) })
  if (!protectedUnits.length || intent.waiting) {
    for (const unit of members) stop(unit)
    state.heldIds = members.map(unit => unit.id)
  } else {
    for (const unit of protectedUnits) {
      if (unit.rx < intent.region.x1 || unit.rx > intent.region.x2 || unit.ry < intent.region.y1 || unit.ry > intent.region.y2) { offer(unit, { kind: 'move', unitIds: [unit.id], ...clip(unit.rx, unit.ry) }); continue }
      const target = intent.targets.filter(enemy => inRange(unit, enemy)).sort((a, b) => distance(unit, a) - distance(unit, b) || a.id - b.id)[0]
      if (target) offer(unit, { kind: 'attack', unitIds: [unit.id], targetId: target.id, holdPosition: true })
      else if (moving) {
        const action = plan.actions.find(action => 'unitIds' in action && action.unitIds.includes(unit.id))
        if (action && 'unitIds' in action) offer(unit, { ...action, unitIds: [unit.id] })
      } else stop(unit)
    }
    for (const [index, unit] of escorts.entries()) {
      if (unit.rx < intent.region.x1 || unit.rx > intent.region.x2 || unit.ry < intent.region.y1 || unit.ry > intent.region.y2) { offer(unit, { kind: 'move', unitIds: [unit.id], ...clip(unit.rx, unit.ry) }); continue }
      const near = protectedUnits.slice().sort((a, b) => distance(unit, a) - distance(unit, b) || a.id - b.id)[0]!
      const separation = distance(unit, near)
      const followedIds = new Set(protectedUnits.flatMap(body => {
        const order = previous.orders[body.id]
        return order?.kind === 'attack' ? [order.targetId!] : []
      }))
      const air = intent.threats.filter(enemy => airborne(enemy) && inRange(unit, enemy)).sort((a, b) => distance(unit, a) - distance(unit, b) || a.id - b.id)[0]
      const support = intent.targets.filter(enemy => followedIds.has(enemy.id) && inRange(unit, enemy)).sort((a, b) => distance(unit, a) - distance(unit, b) || a.id - b.id)[0]
      const target = separation <= policy.gap ? air ?? support : undefined
      if (target) { offer(unit, { kind: 'attack', unitIds: [unit.id], targetId: target.id, holdPosition: true }); continue }
      if (marching) {
        const action = plan.actions.find(action => 'unitIds' in action && action.unitIds.includes(unit.id))
        if (action && 'unitIds' in action) offer(unit, { ...action, unitIds: [unit.id] })
        continue
      }
      if (held.has(unit.id) && moving && separation <= policy.gap * 2) { stop(unit); continue }
      const assigned = protectedUnits[index % protectedUnits.length]!
      const body = distance(unit, assigned) <= policy.gap * 2 ? assigned : near
      const toward = threat ?? (destination ? { rx: destination.x, ry: destination.y } : center)
      const dx = toward.rx - body.rx, dy = toward.ry - body.ry, length = Math.hypot(dx, dy) || 1
      const forward = Math.min(2, policy.gap / 2, threat ? Math.max(0, length - 1) : Infinity), side = ((Math.floor(index / protectedUnits.length) % 3) - 1) * 0.75
      const point = separation > policy.gap * 2 || (state.positions[unit.id]?.stalls ?? 0) >= 2 ? clip(near.rx, near.ry) : clip(body.rx + dx / length * forward - dy / length * side, body.ry + dy / length * forward + dx / length * side)
      if (distance(unit, { rx: point.x, ry: point.y }) > 1.5) offer(unit, { kind: 'move', unitIds: [unit.id], ...point })
      else stop(unit)
    }
  }
  const actions: ActionRequest[] = []
  for (const request of desired.values()) {
    const same = actions.find(action => action.kind === request.kind && (action.kind === 'move' && request.kind === 'move' ? action.x === request.x && action.y === request.y : action.kind === 'attack' && request.kind === 'attack' ? action.targetId === request.targetId : action.kind === 'stop'))
    if (same && 'unitIds' in same && 'unitIds' in request) same.unitIds.push(...request.unitIds)
    else actions.push(request)
  }
  state.detail = intent.waiting ? '等待本次掩护成员生产和交接' : !protectedUnits.length ? '已失去受护成员，掩护成员就近停止，等待新命令' : `${protectedUnits.length}个受护、${escorts.length}个掩护；${held.size ? '严重脱队，临时重聚；' : ''}${marching ? '最慢成员直达终点，其余按规则速度预测跟随' : intent.targets.length ? '协同进攻，掩护近身支援／优先对空' : moving ? '接近威胁，保持近身掩护' : '近身掩护待命'}`
  if (Object.values(state.positions).some(position => position.stalls >= 4)) state.detail += '；队形受阻，已回靠重试，可下达新命令调整路线'
  const view: NonNullable<GoalView['cover']> = { protectedIds: protectedUnits.map(u => u.id), escortIds: escorts.map(u => u.id), slowestIds: slowest.map(u => u.id), heldIds: state.heldIds, detail: state.detail }
  return { actions, state, view }
}
