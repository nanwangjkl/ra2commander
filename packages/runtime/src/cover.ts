import type { ActionRequest, ActionResult, CoverPolicy, GoalView, Region, Snapshot } from '@ra2c/contracts'
import { coverCohort, type CoverCohesion } from './cover-cohesion.ts'

export interface CoverMotion {
  pausedAt?: number
  cohesion?: CoverCohesion
  focusTargetId?: number
  heldIds: number[]
  gathering?: boolean
  orders: Record<string, { kind: 'move' | 'stop' | 'attack'; x?: number; y?: number; targetId?: number; tick: number }>
  detail?: string
  positions?: Record<string, { x: number; y: number; tick: number; stalls: number }>
  prediction?: { guideId: number; x: number; y: number; dx: number; dy: number }
}
export const emptyCoverMotion = (): CoverMotion => ({ heldIds: [], orders: {} })
export function validateCoverMotion(state: CoverMotion | undefined): void {
  if(state?.pausedAt!==undefined&&!Number.isFinite(state.pausedAt))throw new Error('掩护暂停进度非法')
  if(state?.focusTargetId!==undefined&&!Number.isSafeInteger(state.focusTargetId))throw new Error('编队主目标非法')
  if(state?.cohesion) {
    const c=state.cohesion
    if([c.coreIds,c.catchingUpIds,c.regroupIds??[]].some(ids=>!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>!Number.isSafeInteger(id)))||c.coreIds.some(id=>c.catchingUpIds.includes(id))||c.regroupSince!==undefined&&!Number.isFinite(c.regroupSince))throw new Error('掩护追赶进度非法')
  }
  if (state && (!Array.isArray(state.heldIds) || state.heldIds.some(id => !Number.isSafeInteger(id)) || !state.orders || typeof state.orders !== 'object' || Array.isArray(state.orders)
    || Object.values(state.orders).some(order => !order || !['move', 'stop', 'attack'].includes(order.kind) || !Number.isFinite(order.tick) || order.kind === 'move' && (!Number.isFinite(order.x) || !Number.isFinite(order.y)) || order.kind === 'attack' && !Number.isSafeInteger(order.targetId)))) throw new Error('掩护行军事实非法')
  if (state?.positions && (typeof state.positions !== 'object' || Array.isArray(state.positions) || Object.values(state.positions).some(position => !position || ![position.x, position.y, position.tick, position.stalls].every(Number.isFinite) || !Number.isSafeInteger(position.stalls) || position.stalls < 0))) throw new Error('掩护位置事实非法')
  if (state?.prediction && (!Number.isSafeInteger(state.prediction.guideId) || ![state.prediction.x, state.prediction.y, state.prediction.dx, state.prediction.dy].every(Number.isFinite))) throw new Error('掩护预测事实非法')
}
export function validateCover(policy: CoverPolicy): void {
  if (!policy || !policy.runId || !policy.version || !Array.isArray(policy.escortIds) || new Set(policy.escortIds).size !== policy.escortIds.length
    || policy.escortIds.some(id => !Number.isSafeInteger(id)) || !Number.isFinite(policy.gap) || !Number.isFinite(policy.resumeGap) || policy.resumeGap <= 0 || policy.gap <= policy.resumeGap
    || !Number.isSafeInteger(policy.retryTicks) || policy.retryTicks < 1) throw new Error('掩护配置非法')
  if (policy.escortSources && (!Array.isArray(policy.escortSources) || policy.escortSources.some(source => !source.goalId || !Number.isSafeInteger(source.quantity) || source.quantity < 1))) throw new Error('掩护生产来源非法')
  if (policy.protectedSources && (!Array.isArray(policy.protectedSources) || policy.protectedSources.some(id => typeof id !== 'string' || !id))) throw new Error('受护生产来源非法')
  if ([policy.predictionTicks, policy.replanTicks].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 15))) throw new Error('掩护预测周期非法')
}
export function coverMembers(policy: CoverPolicy, snap: Snapshot, ids: number[]) {
  const members = snap.self.filter(unit => ids.includes(unit.id) && [3, 7].includes(unit.type) && unit.zone !== 1 && unit.zone !== 2)
  const escorts = members.filter(unit => policy.escortIds.includes(unit.id)), protectedUnits = members.filter(unit => !policy.escortIds.includes(unit.id))
  const speeds = members.map(unit => unit.speed).filter((speed): speed is number => Number.isFinite(speed) && speed! > 0)
  const minimum = speeds.length ? Math.min(...speeds) : undefined
  const slowest = minimum === undefined ? members : members.filter(unit => unit.speed === minimum || unit.speed === undefined)
  return { members, escorts, protectedUnits, slowest }
}
/** rules.speed 为引擎解析的 leptons/tick；当前游戏每格 256 leptons，不用位移测速推定。 */
export const movementPerTick = (speed: number | undefined) => Number.isFinite(speed) && speed! > 0 ? speed! / 256 : 0

/** 最慢成员直达终点，其余成员追随规则速度推算的前视点；停车仅处理严重脱队。 */
export function coverMoves(policy: CoverPolicy, snap: Snapshot, ids: number[], destination: { x: number; y: number }, previous: CoverMotion,
  options: { region?: Region; threat?: { rx: number; ry: number }; directDestination?: boolean } = {}) {
  const all=coverMembers(policy,snap,ids),cohort=coverCohort(all.members,policy,snap.tick,previous.cohesion)
  const { members, escorts, protectedUnits, slowest } = coverMembers(policy, snap, cohort.core.map(unit=>unit.id))
  const state = structuredClone(previous), actions: ActionRequest[] = []
  state.cohesion=cohort.state
  state.orders = Object.fromEntries(Object.entries(state.orders).filter(([id]) => all.members.some(unit => unit.id === Number(id))))
  const remaining = (unit: { rx: number; ry: number }) => Math.hypot(destination.x - unit.rx, destination.y - unit.ry)
  const span = Math.max(policy.gap, Math.sqrt(members.length))
  const known = slowest.filter(unit => movementPerTick(unit.speed) > 0), drivers = known.length ? known : slowest
  const anchor = drivers.find(unit => unit.id === previous.prediction?.guideId) ?? [...drivers].sort((a, b) => remaining(b) - remaining(a) || a.id - b.id)[0]
  const coordinated = !!escorts.length && !!protectedUnits.length
  const changedDestination = !previous.prediction || previous.prediction.x !== destination.x || previous.prediction.y !== destination.y || previous.prediction.guideId !== anchor?.id
  const goalDistance = anchor ? remaining(anchor) : 0
  let dx = anchor && goalDistance ? (destination.x - anchor.rx) / goalDistance : 0, dy = anchor && goalDistance ? (destination.y - anchor.ry) / goalDistance : 0
  const velocity = anchor?.velocity, length = velocity ? Math.hypot(velocity.x, velocity.z) : 0
  const oldHeading = previous.prediction
  if (!changedDestination && length > 1e-6) {
    const vx = velocity!.x / length, vy = velocity!.z / length
    const recentOrder = snap.tick - (previous.orders[anchor!.id]?.tick ?? -Infinity) < 60
    if (!recentOrder || vx * dx + vy * dy >= -0.2) { dx = vx; dy = vy }
  } else if (!changedDestination && velocity && !anchor?.isIdle && oldHeading) {
    dx = oldHeading.dx; dy = oldHeading.dy
  }
  if (!changedDestination && oldHeading && dx * oldHeading.dx + dy * oldHeading.dy > 0.97) { dx = oldHeading.dx; dy = oldHeading.dy }
  const turned = !!oldHeading && dx * oldHeading.dx + dy * oldHeading.dy < 0.7
  if (anchor) state.prediction = { guideId: anchor.id, x: destination.x, y: destination.y, dx, dy }
  delete state.gathering // 旧停走版本的重聚标记不影响本次预测。
  const stalled = !!anchor && (previous.positions?.[anchor.id]?.stalls ?? 0) >= 2
  const guideSpeed = movementPerTick(anchor?.speed), predictionTicks = policy.predictionTicks ?? 45, replanTicks = policy.replanTicks ?? 30
  const region = options.region ?? { x1: 0, y1: 0, x2: snap.mapWidth - 1, y2: snap.mapHeight - 1 }
  const clip = (x: number, y: number) => ({ x: Math.max(region.x1, Math.min(region.x2, Math.round(x))), y: Math.max(region.y1, Math.min(region.y2, Math.round(y))) })
  let sx = dx, sy = dy
  if (anchor && options.threat) { const length = Math.hypot(options.threat.rx - anchor.rx, options.threat.ry - anchor.ry); if (length) { sx = (options.threat.rx - anchor.rx) / length; sy = (options.threat.ry - anchor.ry) / length } }
  const anchorEscort = !!anchor && policy.escortIds.includes(anchor.id)
  const stop: number[] = [], targets: Record<number, { x: number; y: number }> = {}
  state.heldIds = []
  if (members.length && protectedUnits.length) for (const unit of members) {
    const driver=drivers.some(driver=>driver.id===unit.id)
    const lead=anchor?(unit.rx-anchor.rx)*dx+(unit.ry-anchor.ry)*dy:0
    const held = cohort.regroup.length ? !cohort.regroup.some(lagging=>lagging.id===unit.id) : coordinated&&!driver&&lead>(previous.cohesion&&previous.heldIds.includes(unit.id)?span:span*2)
    if (held) state.heldIds.push(unit.id)
    const order = previous.orders[unit.id]
    if (held) {
      if ((!unit.isIdle && (!order || order.kind !== 'stop' || snap.tick - order.tick >= 15)) || order?.kind === 'move') stop.push(unit.id)
      continue
    }
    const direct = !coordinated || options.directDestination || driver
    let target = cohort.regroup.length&&cohort.point?clip(cohort.point.rx,cohort.point.ry):destination
    if (!direct && anchor && !cohort.regroup.length) {
      const escort = policy.escortIds.includes(unit.id), role = escort ? escorts : protectedUnits
      const offset = (Number(escort) - Number(anchorEscort)) * Math.min(2, span / 2)
      const lane = (role.findIndex(member => member.id === unit.id) - (role.length - 1) / 2) * Math.min(1.2, span / Math.max(1, role.length))
      const forwardGap = Math.max(0, (anchor.rx + sx * offset - unit.rx) * dx + (anchor.ry + sy * offset - unit.ry) * dy)
      const relative = Math.max(movementPerTick(unit.speed) - guideSpeed, guideSpeed / 4)
      const ticks = stalled || !guideSpeed || !movementPerTick(unit.speed) ? 0 : Math.min(predictionTicks * 2, Math.max(predictionTicks / 2, forwardGap / relative))
      const forward = Math.min(goalDistance, guideSpeed * ticks)
      let x = dx * forward + sx * offset - dy * lane, y = dy * forward + sy * offset + dx * lane
      const reach = Math.hypot(x, y), limit = span * 1.5
      if (reach > limit) { x *= limit / reach; y *= limit / reach }
      target = clip(anchor.rx + x, anchor.ry + y)
      // 已领先的成员沿现有路径自然靠拢，不因滚动预测点稍落后便掉头或停车。
      if (order?.kind === 'move' && !changedDestination && !turned && !stalled && goalDistance > 3 && (target.x - unit.rx) * dx + (target.y - unit.ry) * dy < -0.5 && Math.hypot(unit.rx - anchor.rx, unit.ry - anchor.ry) <= span * 2) continue
    }
    const changed = !order || order.kind !== 'move' || changedDestination
    const movedTarget = order?.kind === 'move' && Math.hypot(order.x! - target.x, order.y! - target.y) >= Math.max(2, span / 2)
    const retry = unit.isIdle && Math.hypot(unit.rx - target.x, unit.ry - target.y) > 2 && snap.tick - (order?.tick ?? -Infinity) >= (direct ? policy.retryTicks : 15)
    if (changed || direct && order?.kind === 'move' && (order.x !== target.x || order.y !== target.y) || !direct && movedTarget && (turned || snap.tick - order!.tick >= replanTicks) || retry) targets[unit.id] = target
  }
  const body=anchor??cohort.point
  if(body) for(const unit of cohort.catchingUp) {
    const forward=Math.min(goalDistance,guideSpeed*predictionTicks)
    const target=clip(body.rx+dx*forward,body.ry+dy*forward),old=previous.orders[unit.id]
    if(!old||old.kind!=='move'||Math.hypot(old.x!-target.x,old.y!-target.y)>=2&&snap.tick-old.tick>=replanTicks||unit.isIdle&&Math.hypot(unit.rx-target.x,unit.ry-target.y)>2&&snap.tick-old.tick>=policy.retryTicks)targets[unit.id]=target
  }
  if (stop.length) actions.push({ kind: 'stop', unitIds: stop })
  for (const [id, target] of Object.entries(targets)) {
    const grouped = actions.find(action => action.kind === 'move' && action.x === target.x && action.y === target.y)
    if (grouped && 'unitIds' in grouped) grouped.unitIds.push(Number(id))
    else actions.push({ kind: 'move', unitIds: [Number(id)], ...target })
  }
  const view: NonNullable<GoalView['cover']> = { protectedIds: all.protectedUnits.map(unit => unit.id), escortIds: all.escorts.map(unit => unit.id), slowestIds: slowest.map(unit => unit.id), heldIds: [...state.heldIds],catchingUpIds:cohort.state.catchingUpIds,
    detail: `被掩护${all.protectedUnits.length}、掩护${all.escorts.length}；${state.heldIds.length ? '严重脱队，有限重聚' : stalled ? '领行受阻，近身靠拢' : '最慢成员直达终点，其余按规则速度预测跟随'}${cohort.catchingUp.length?`；${cohort.catchingUp.length}个成员独立追赶主体`:''}${members.some(unit => unit.speed === undefined) ? '（部分速度规则待就绪）' : ''}` }
  return { actions, state, view }
}
export function recordCoverOrder(state: CoverMotion, request: ActionRequest, tick: number, results: ActionResult[]): void {
  if (!results.length || results.some(result => !result.ok) || !results.some(result => (result.submitted ?? 1) > 0) || request.kind !== 'move' && request.kind !== 'stop' && request.kind !== 'attack') return
  for (const id of request.unitIds) state.orders[id] = { kind: request.kind, tick, ...(request.kind === 'move' ? { x: request.x, y: request.y } : request.kind === 'attack' ? { targetId: request.targetId } : {}) }
}
