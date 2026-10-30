import { canAttackTarget, crushCompatible, type ActionRequest, type ActionResult, type CrushingRules, type Snapshot, type SnapshotUnit } from '@ra2c/contracts'
import type { UnitOrderState } from './unit-orders.ts'
import { directAttackOrders } from './attack-orders.ts'

type Point = { x: number; y: number; onBridge: boolean }
export interface CrushPair {
  unitId: number; name: string; targetId: number; targetName: string
  phase: 'crushing' | 'fire'; point: Point; position: { x: number; y: number }
  progressAt: number; attempts: number; sentAt?: number; sentPoint?: Point; lastFailed?: boolean
  lastResult?: { ok: boolean; submitted: number; reason?: string }
}
export interface CrushingState { pairs: Record<string, CrushPair>; fireTargetId?: number; pausedAt?: number; detail?: string }
export const emptyCrushing = (): CrushingState => ({ pairs: {} })
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)
const point = (unit: SnapshotUnit): Point => ({ x: unit.rx, y: unit.ry, onBridge: !!unit.onBridge })
export const crushCell = (p: Point) => `${p.x},${p.y},${Number(p.onBridge)}`

interface Input {
  snap: Snapshot; rules: CrushingRules | undefined; state: CrushingState
  unitIds: readonly number[]; targets: readonly SnapshotUnit[]; requests: ActionRequest[]
  orders: UnitOrderState['orders']; claims: readonly CrushPair[]
  focus?: boolean
  escort(id: number): boolean
  canPursue(unit: SnapshotUnit, target: SnapshotUnit): boolean
  follow(unit: SnapshotUnit): ActionRequest | undefined
}

/** 只处理已提出／已确认的攻击意图；不自行拓宽目标类型或选择新的己方成员。 */
export function planCrushing(input: Input): ActionRequest[] {
  const { snap, rules, state, requests, orders } = input
  const units = snap.self.filter(unit => input.unitIds.includes(unit.id)), targets = input.targets
  const desired = new Map<number, Extract<ActionRequest, { kind: 'attack' }>>()
  const overridden = new Set<number>()
  for (const request of requests) if ('unitIds' in request) for (const id of request.unitIds) {
    if (request.kind === 'attack') { desired.set(id, { ...request, unitIds: [id] }); overridden.delete(id) }
    else { desired.delete(id); overridden.add(id) }
  }
  for (const unit of units) {
    if (desired.has(unit.id) || overridden.has(unit.id)) continue
    const previous = state.pairs[unit.id], order = orders[unit.id]
    const targetId = previous?.targetId ?? (order?.kind === 'attack' || order?.kind === 'crush' ? order.targetId : undefined)
    if (targetId !== undefined) desired.set(unit.id, { kind: 'attack', unitIds: [unit.id], targetId })
  }
  const actions: ActionRequest[] = [], handled = new Set<number>(), spare: SnapshotUnit[] = []
  const stop = (unit: SnapshotUnit) => {
    if (!unit.isIdle || orders[unit.id]?.kind === 'crush' || orders[unit.id]?.kind === 'attack') actions.push({ kind: 'stop', unitIds: [unit.id] })
  }
  if (state.pausedAt !== undefined) {
    for (const pair of Object.values(state.pairs)) {
      pair.progressAt = snap.time; delete pair.sentAt
      const unit = units.find(unit => unit.id === pair.unitId)
      if (unit) pair.position = { x: unit.rx, y: unit.ry }
    }
    delete state.pausedAt
  }
  // 新指令优先；转编成员不从旧目标旁路停车。
  for (const pair of Object.values(state.pairs)) {
    const unit = units.find(unit => unit.id === pair.unitId), target = targets.find(target => target.id === pair.targetId)
    const intent = desired.get(pair.unitId), proposed = intent && targets.find(target => target.id === intent.targetId)
    if (!unit || overridden.has(pair.unitId) || !target || pair.name !== unit.name || pair.targetName !== target.name || !crushCompatible(unit, target, rules) || proposed && !crushCompatible(unit, proposed, rules)) {
      delete state.pairs[pair.unitId]
      if (unit && pair.phase === 'crushing' && !overridden.has(unit.id) && (!proposed || intent?.targetId === pair.targetId)) { handled.add(unit.id); stop(unit) }
    }
  }
  const candidates = units.filter(unit => {
    if (handled.has(unit.id) || overridden.has(unit.id)) return false
    const intent = desired.get(unit.id), target = intent && targets.find(target => target.id === intent.targetId)
    return !!target && crushCompatible(unit, target, rules)
  })
  const claimedIds = new Set(input.claims.map(pair => pair.targetId)), claimedCells = new Set(input.claims.map(pair => crushCell(pair.point)))
  const claim = (pair: CrushPair) => { claimedIds.add(pair.targetId); claimedCells.add(crushCell(pair.point)) }
  for (const escort of [false, true]) {
    const group = candidates.filter(unit => input.escort(unit.id) === escort)
    for (const unit of group) {
      handled.add(unit.id)
      const previous = state.pairs[unit.id], target = previous && targets.find(target => target.id === previous.targetId)
      if (!previous || !target) continue
      if (previous.phase === 'fire' && distance(previous.point, point(target)) >= 2) { delete state.pairs[unit.id]; continue }
      if (!input.canPursue(unit, target)) { delete state.pairs[unit.id]; continue }
      if (previous.phase === 'crushing') {
        if (claimedIds.has(target.id) || claimedCells.has(crushCell(point(target)))) { delete state.pairs[unit.id]; continue }
        previous.point = point(target)
        if (snap.time < previous.progressAt || distance(previous.position, point(unit)) >= 1) {
          previous.position = { x: unit.rx, y: unit.ry }; previous.progressAt = snap.time
        }
        if (previous.attempts >= 3) previous.phase = 'fire'
        else if (snap.time - previous.progressAt >= 3) {
          if (!previous.lastFailed) previous.attempts++
          previous.progressAt = snap.time
          if (previous.attempts >= 3) previous.phase = 'fire'
          else delete previous.sentAt
        }
        if (previous.phase === 'crushing') claim(previous)
      }
    }
    const edges = group.filter(unit => !state.pairs[unit.id]).flatMap(unit => targets
      .filter(target => crushCompatible(unit, target, rules) && input.canPursue(unit, target))
      .map(target => ({ unit, target, cost: distance(point(unit), point(target)) })))
      .sort((a, b) => a.cost - b.cost || a.unit.id - b.unit.id || a.target.id - b.target.id)
    for (const { unit, target } of edges) {
      if (state.pairs[unit.id] || claimedIds.has(target.id) || claimedCells.has(crushCell(point(target)))) continue
      const pair: CrushPair = { unitId: unit.id, name: unit.name, targetId: target.id, targetName: target.name, phase: 'crushing', point: point(target), position: { x: unit.rx, y: unit.ry }, progressAt: snap.time, attempts: 0 }
      state.pairs[unit.id] = pair; claim(pair)
    }
    for (const unit of group) {
      const pair = state.pairs[unit.id], intent = desired.get(unit.id)!
      if (!pair) { spare.push(unit); continue }
      if (pair.phase === 'fire') {
        const old = orders[unit.id]
        // 掩护回退也不能凭普通攻击追出队形；射程在最终桥复查。
        if (input.escort(unit.id) && old?.kind === 'crush') actions.push({ kind: 'stop', unitIds: [unit.id] })
        if (!old || old.kind !== 'attack' || old.targetId !== pair.targetId || unit.isIdle) actions.push({ ...intent, targetId: pair.targetId, ...(input.escort(unit.id) ? { holdPosition: true } : {}) })
        continue
      }
      if (pair.sentAt === undefined || snap.tick - pair.sentAt >= 15 && (!pair.sentPoint || crushCell(pair.sentPoint) !== crushCell(pair.point))) actions.push({ kind: 'crush', unitIds: [unit.id], targetId: pair.targetId })
    }
  }
  // 未分到接触点的车辆继续打其他合法敌人，不能因一个步兵占用了主目标就整队停车。
  const canFire = (unit: SnapshotUnit, target: SnapshotUnit) => !claimedIds.has(target.id) && !crushCompatible(unit, target, rules) && input.canPursue(unit, target)
  const fireMotion: UnitOrderState = { orders, ...(state.fireTargetId !== undefined ? { focusTargetId: state.fireTargetId } : {}) }
  const fire = directAttackOrders(snap, spare.map(unit => unit.id), targets, fireMotion, input.focus, canFire)
  if (fireMotion.focusTargetId !== undefined) state.fireTargetId = fireMotion.focusTargetId
  else delete state.fireTargetId
  for (const request of fire) if (request.kind === 'attack') for (const escort of [false, true]) {
    const unitIds = request.unitIds.filter(id => input.escort(id) === escort)
    if (!unitIds.length) continue
    const stopping = escort ? unitIds.filter(id => orders[id]?.kind === 'crush') : []
    if (stopping.length) actions.push({ kind: 'stop', unitIds: stopping })
    actions.push({ ...request, unitIds, ...(escort ? { holdPosition: true } : {}) })
  }
  for (const unit of spare) {
    // 既有火力令仍有效时保持，避免每步去重后又被停车覆盖。
    if (targets.some(target => canFire(unit, target) && canAttackTarget(unit, target))) continue
    const follow = input.follow(unit)
    if (follow) actions.push(follow)
    else stop(unit)
  }
  const keep = requests.flatMap(request => {
    if (!('unitIds' in request)) return [request]
    const unitIds = request.unitIds.filter(id => !handled.has(id))
    return unitIds.length ? [{ ...request, unitIds } as ActionRequest] : []
  })
  const pairs = Object.values(state.pairs), crushing = pairs.filter(pair => pair.phase === 'crushing').length, fallback = pairs.filter(pair => pair.phase === 'fire').length
  const retrying = pairs.filter(pair => pair.phase === 'crushing' && pair.attempts > 0).length
  if (crushing || fallback) state.detail = [crushing ? `${crushing} 辆分头碾压，按公开位置追踪` : '', retrying ? `${retrying} 辆受阻，有限重试强移` : '', fallback ? `${fallback} 辆碾压受阻，改用火力` : ''].filter(Boolean).join('；')
  else delete state.detail
  return [...actions, ...keep]
}

export function recordCrushing(state: CrushingState | undefined, request: ActionRequest, results: ActionResult[], snap: Snapshot, failure?: string): void {
  if (!state || request.kind !== 'crush') return
  for (const id of request.unitIds) {
    const pair = state.pairs[id]
    if (!pair || pair.targetId !== request.targetId) continue
    pair.sentAt = snap.tick; pair.sentPoint = results[0]?.targetPosition ?? { ...pair.point }
    const failed = results.find(result => !result.ok || result.submitted === 0)
    pair.lastResult = { ok: !!results.length && !failed, submitted: results.reduce((count, result) => count + (result.submitted ?? (result.ok ? 1 : 0)), 0), ...(!results.length ? { reason: failure?.slice(0, 200) ?? 'empty-receipt' } : failed?.reason ? { reason: failed.reason } : {}) }
    if (!pair.lastResult.ok) {
      pair.attempts++; pair.lastFailed = true; pair.progressAt = snap.time
    } else delete pair.lastFailed
  }
}

export function validateCrushing(state: CrushingState | undefined): void {
  if (!state) return
  if (state.fireTargetId !== undefined && !Number.isSafeInteger(state.fireTargetId)) throw new Error('碾压剩余车辆火力主目标非法')
  const position = (p: { x: number; y: number }) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y)
  const cell = (p: Point) => position(p) && Number.isSafeInteger(p.x) && Number.isSafeInteger(p.y) && typeof p.onBridge === 'boolean'
  if (!state.pairs || typeof state.pairs !== 'object' || Array.isArray(state.pairs) || state.pausedAt !== undefined && !Number.isFinite(state.pausedAt) || Object.entries(state.pairs).some(([id, pair]) => !pair || String(pair.unitId) !== id || !Number.isSafeInteger(pair.unitId) || !pair.name || !Number.isSafeInteger(pair.targetId) || !pair.targetName || !['crushing', 'fire'].includes(pair.phase) || !cell(pair.point) || !position(pair.position) || !Number.isFinite(pair.progressAt) || !Number.isSafeInteger(pair.attempts) || pair.attempts < 0 || pair.sentAt !== undefined && !Number.isFinite(pair.sentAt) || pair.sentPoint && !cell(pair.sentPoint) || pair.lastFailed !== undefined && typeof pair.lastFailed !== 'boolean')) throw new Error('碾压配对状态非法')
  if (Object.values(state.pairs).some(({ lastResult: result }) => result && (typeof result.ok !== 'boolean' || !Number.isSafeInteger(result.submitted) || result.submitted < 0 || result.reason !== undefined && typeof result.reason !== 'string'))) throw new Error('碾压回执非法')
}
