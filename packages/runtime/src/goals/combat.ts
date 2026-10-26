import { inTargetRegion, validTargetRegion } from '@ra2c/contracts'
import { alive, baseConstraints, blocked, formationExists, movementArrival, point, projection } from './common.ts'
import type { GoalContext, GoalHandler } from './types.ts'

const members = (ctx: GoalContext<'combat'>) => alive(ctx, ctx.formations.membersOf(ctx.spec.formationId))
function initialize(ctx: GoalContext<'combat'>) {
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
    if (spec.retreat && (!point(map, spec.retreat.x, spec.retreat.y) || !Number.isFinite(spec.retreat.lossAbove) || spec.retreat.lossAbove < 0 || spec.retreat.lossAbove >= 1)) throw new Error('回撤条件非法')
  },
  validateLive(ctx) { if (!formationExists(ctx, ctx.spec.formationId, true)) throw new Error('编队不存在，请先建队') },
  initialize,
  track(ctx) {
    initialize(ctx)
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
    if (spec.destination && !spec.attackRegion && spec.mode !== 'hold' && spec.mode !== 'assault' && movementArrival(ctx)?.reached) {
      if (spec.route) { goal.facts.routeIndex = (goal.facts.routeIndex ?? 0) + 1; if (goal.facts.routeIndex >= spec.route.length) goal.status = 'completed' }
      else goal.status = 'completed'
    }
  },
  project(ctx) {
    const { spec, goal: { facts }, snap } = ctx
    const constraints = { ...baseConstraints(ctx), allowedUnitIds: members(ctx), allowedActions: spec.allowedActions, region: spec.region, ...(spec.attackRegion ? { targetRegion: spec.attackRegion, enemyIds: snap.enemies.filter(enemy => inTargetRegion(enemy.rx, enemy.ry, spec.attackRegion!)).map(enemy => enemy.id) } : {}), ...(spec.retreat ? { retreat: { x: spec.retreat.x, y: spec.retreat.y, active: facts.retreatTriggered } } : {}) }
    const arrival = movementArrival(ctx)
    return projection(ctx, constraints, { spec: spec.route ? { ...spec, destination: spec.route[Math.min(facts.routeIndex ?? 0, spec.route.length - 1)]! } : spec, ...(arrival ? { arrival } : {}), ...blocked(ctx), ...(!formationExists(ctx, spec.formationId) ? { blocked: `等待 ${spec.formationId} 编队完成` } : {}) })
  },
  progress({ spec, goal }, view) {
    if (['partial', 'failed'].includes(goal.status)) return {}
    return spec.route ? { progress: { completed: goal.status === 'completed' ? spec.route.length : goal.facts.routeIndex ?? 0, total: spec.route.length, label: '已到达路点' }, ...(view.spec.kind === 'combat' && goal.status !== 'completed' ? { detail: `当前目的地：${view.spec.destination?.name ?? `${view.spec.destination?.x},${view.spec.destination?.y}`}` } : {}) } : {}
  },
  continuous: ({ spec }) => spec.mode === 'hold' || spec.mode === 'assault' || (!spec.destination && !spec.attackRegion),
  stopMembers: members,
}
