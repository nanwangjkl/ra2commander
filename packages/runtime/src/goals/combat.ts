import { attackObjective, matchingAttackTargets, validTargetRegion } from '@ra2c/contracts'
import { alive, baseConstraints, blocked, formationExists, formationPreparing, movementArrival, point, presentUnitIds, projection } from './common.ts'
import type { GoalContext, GoalHandler } from './types.ts'
import { coverMoves, emptyCoverMotion, validateCoverMotion } from '../cover.ts'
import { directAttackOrders } from '../attack-orders.ts'
import { defenseOrders, defenseState, defenseTargets, observeBaseDefense, validDefenseState } from '../base-defense.ts'

const members = (ctx: GoalContext<'combat'>) => alive(ctx, ctx.formations.membersOf(ctx.spec.formationId))
function initialize(ctx: GoalContext<'combat'>) {
  if (ctx.spec.baseDefense) ctx.goal.facts.baseDefense ??= structuredClone(defenseState(ctx))
  if (!ctx.goal.facts.initialized) {
    const ids = ctx.formations.membersOf(ctx.spec.formationId)
    ctx.goal.facts.members = ctx.snap.self.filter(unit => ids.includes(unit.id)).map(unit => ({ id: unit.id, name: unit.name, rx: unit.rx, ry: unit.ry }))
    ctx.goal.facts.initialized = ctx.goal.facts.members.length > 0
  }
}
export const combat: GoalHandler<'combat'> = {
  validateSpec(spec, map) {
    const r = spec.region
    if (!spec.formationId || !r || !point(map, r.x1, r.y1) || !point(map, r.x2, r.y2) || r.x1 > r.x2 || r.y1 > r.y2 || !Array.isArray(spec.allowedActions)) throw new Error('授权地域非法')
    if (spec.destination && !point(map, spec.destination.x, spec.destination.y) || spec.route && (!Array.isArray(spec.route) || !spec.route.length || spec.route.some(stop => !point(map, stop.x, stop.y)))) throw new Error('路线目的地非法')
    if (spec.attackRegion && !validTargetRegion(spec.attackRegion)) throw new Error('攻击范围非法')
    if (spec.baseDefense && (!validDefenseState(spec.baseDefense) || spec.mode !== 'hold' || spec.executionMode !== 'native' || !Array.isArray(spec.baseDefense.anchorNames) || !spec.baseDefense.anchorNames.length || spec.baseDefense.anchorNames.some(name=>typeof name!=='string'||!name) || spec.destination || spec.route || spec.objective || spec.attackRegion)) throw new Error('基地防守要求非法')
    if (spec.retreat && (!point(map, spec.retreat.x, spec.retreat.y) || !Number.isFinite(spec.retreat.lossAbove) || spec.retreat.lossAbove < 0 || spec.retreat.lossAbove >= 1)) throw new Error('回撤条件非法')
  },
  validateLive(ctx) { if (!formationExists(ctx, ctx.spec.formationId, true)) throw new Error('编队不存在，请先建队') },
  initialize,
  validateFacts(goal) {
    validateCoverMotion(goal.facts.coverMotion)
    if (goal.facts.baseDefense && (goal.spec.kind !== 'combat' || !goal.spec.baseDefense || !validDefenseState(goal.facts.baseDefense))) throw new Error('基地防守进度非法')
  },
  nativeActions(ctx) {
    const retreat = ctx.goal.facts.retreatTriggered ? ctx.spec.retreat : undefined
    if (!retreat && ctx.spec.baseDefense) return defenseOrders(ctx)
    const destination = retreat ?? ctx.spec.route?.[ctx.goal.facts.routeIndex ?? 0] ?? ctx.spec.destination
    if (!retreat && !ctx.formations.coverOf(ctx.spec.formationId) && ctx.spec.allowedActions.includes('attack')) {
      const targets = matchingAttackTargets(ctx.spec, ctx.snap.enemies).filter(target => ctx.spec.mode !== 'hold' && ctx.spec.mode !== 'assault' || target.rx >= ctx.spec.region.x1 && target.rx <= ctx.spec.region.x2 && target.ry >= ctx.spec.region.y1 && target.ry <= ctx.spec.region.y2)
      const selected = targets.filter(target => !ctx.spec.patrol || ctx.snap.self.some(unit => members(ctx).includes(unit.id) && Math.hypot(unit.rx - target.rx, unit.ry - target.ry) <= Math.max(unit.primaryWeapon?.maxRange ?? 0, unit.secondaryWeapon?.maxRange ?? 0)))
      if (selected.length) {
        const motion = ctx.goal.facts.coverMotion ??= emptyCoverMotion()
        return directAttackOrders(ctx.snap, members(ctx), selected, motion)
      }
    }
    if (!destination) return []
    const ids = members(ctx)
    if (ctx.formations.membersOf(ctx.spec.formationId).some(id => ctx.locked(id))) return []
    const policy = ctx.formations.coverOf(ctx.spec.formationId)
    const result = coverMoves(policy ?? { runId: 'ordinary', version: '1', escortIds: [], gap: Number.MAX_SAFE_INTEGER, resumeGap: 1, retryTicks: 90 }, ctx.snap, ids, destination, ctx.goal.facts.coverMotion ?? emptyCoverMotion())
    ctx.goal.facts.coverMotion = result.state
    return result.actions
  },
  track(ctx) {
    initialize(ctx)
    if (ctx.spec.baseDefense) observeBaseDefense(ctx)
    const { spec, goal: { facts }, snap } = ctx, converted: number[] = [], occupied = new Set(facts.members.map(member => member.id))
    let dead = 0
    for (const member of facts.members) {
      let unit = snap.self.find(unit => unit.id === member.id)
      if (!unit) {
        const form = spec.transforms?.[member.name]
        unit = form ? snap.self.find(unit => unit.name === form && !occupied.has(unit.id) && Math.hypot(unit.rx - member.rx, unit.ry - member.ry) <= 2) : undefined
        if (unit) { occupied.add(unit.id); converted.push(unit.id); member.id = unit.id }
      }
      if (unit) { member.name = unit.name; member.rx = unit.rx; member.ry = unit.ry } else dead++
    }
    facts.lossRatio = facts.members.length ? dead / facts.members.length : 0
    if (spec.retreat && facts.lossRatio > spec.retreat.lossAbove) facts.retreatTriggered = true
    return converted
  },
  observe(ctx) {
    const { spec, goal } = ctx
    const present = presentUnitIds(ctx.snap)
    const trackedAlive = goal.facts.members.some(member => present.has(member.id) && (!ctx.formations.ownerOf(member.id) || ctx.formations.ownerOf(member.id) === spec.formationId))
    if (!trackedAlive && !ctx.formations.membersOf(spec.formationId).some(id => present.has(id)) && !formationPreparing(ctx, spec.formationId)) {
      goal.status = (goal.facts.routeIndex ?? 0) > 0 ? 'partial' : 'failed'
      goal.facts.outcomeDetail = `${spec.formationId} 已无存活成员，本次任务结束，保留队名；未自动补兵`
      return
    }
    if (spec.destination && !attackObjective(spec)?.target.region && spec.mode !== 'hold' && spec.mode !== 'assault' && movementArrival(ctx)?.reached) {
      if (spec.route) { goal.facts.routeIndex = (goal.facts.routeIndex ?? 0) + 1; if (goal.facts.routeIndex >= spec.route.length) goal.status = 'completed' }
      else goal.status = 'completed'
    }
  },
  project(ctx) {
    const { spec, goal: { facts }, snap } = ctx
    const objective = attackObjective(spec)
    const defense = spec.baseDefense ? defenseState(ctx) : undefined
    const constraints = { ...baseConstraints(ctx), allowedUnitIds: members(ctx), allowedActions: spec.allowedActions, region: spec.region,
      ...(objective ? { enemyIds: matchingAttackTargets(spec, snap.enemies).map(enemy => enemy.id), ...(objective.target.region ? { targetRegion: objective.target.region } : {}) } : {}),
      ...(defense ? {enemyIds:defenseTargets(ctx).map(enemy=>enemy.id),targetRegion:defense.region} : {}),
      ...(spec.retreat ? { retreat: { x: spec.retreat.x, y: spec.retreat.y, active: facts.retreatTriggered } } : {}) }

    const arrival = movementArrival(ctx)
    const policy = ctx.formations.coverOf(spec.formationId), destination = spec.route?.[facts.routeIndex ?? 0] ?? spec.destination
    const cover = policy && destination && !spec.patrol && !spec.allowedActions.includes('attack') ? coverMoves(policy, snap, members(ctx), destination, facts.coverMotion ?? emptyCoverMotion()).view : undefined
    return projection(ctx, constraints, { spec: spec.route ? { ...spec, destination: spec.route[Math.min(facts.routeIndex ?? 0, spec.route.length - 1)]! } : spec, ...(arrival ? { arrival } : {}), ...(cover ? { cover } : {}), ...blocked(ctx), ...(!formationExists(ctx, spec.formationId) ? { blocked: `等待 ${spec.formationId} 编队完成` } : {}) })
  },
  progress({ spec, goal }, view) {
    if (['partial', 'failed'].includes(goal.status)) return {}
    return spec.route ? { progress: { completed: goal.status === 'completed' ? spec.route.length : goal.facts.routeIndex ?? 0, total: spec.route.length, label: '已到达路点' }, ...(view.spec.kind === 'combat' && goal.status !== 'completed' ? { detail: `当前目的地：${view.spec.destination?.name ?? `${view.spec.destination?.x},${view.spec.destination?.y}`}；${view.cover?.detail ?? ''}` } : {}) } : view.cover ? { detail: view.cover.detail } : {}
  },
  execution(ctx) {
    if (!ctx.spec.baseDefense) return
    if (!members(ctx).length && formationPreparing(ctx,ctx.spec.formationId)) return {state:'pending',detail:`等待${ctx.spec.formationId}本次生产和成员交接，防守基地要求已保留`}
    const area=defenseState(ctx).region, count=defenseTargets(ctx).length
    return {state:'continuous',detail:ctx.goal.facts.retreatTriggered?'已触发明确的战损回撤':`防守基地所在${area.name}分区；${count?`发现${count}个区内敌人，攻击进入防区的目标`:'无区内敌人，原地待命'}`}
  },
  continuous: ({ spec }) => spec.mode === 'hold' || spec.mode === 'assault' || (!spec.destination && !spec.attackRegion),
  stopMembers: members,
}
