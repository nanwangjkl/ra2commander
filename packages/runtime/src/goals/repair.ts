import { emptyRepairState, planRepairs } from '../repair.ts'
import { alive, baseConstraints, blocked, formationExists, paused, projection, stringsValid, terminal, world } from './common.ts'
import type { GoalContext, GoalHandler } from './types.ts'

function plan(ctx: GoalContext<'repair'>) {
  const { spec, goal, snap, goals, formations, handoffs } = ctx
  const members = formations.membersOf(spec.formationId).filter(id => !ctx.locked(id))
  const waiting = spec.preparationGoalIds.some(id => { const goal = goals.get(id); return goal && !terminal(goal.status) }) || handoffs.some(handoff => handoff.unitIds.some(id => formations.ownerOf(id) === spec.formationId))
  const previous = structuredClone(goal.facts.repair) ?? { ...emptyRepairState(), engineerIds: [...new Set([...goals.values()].flatMap(goal => goal.facts.repair?.engineerIds ?? []))] }
  if (paused(ctx)) for (const job of previous.jobs) job.progressTick = snap.tick
  return planRepairs(spec, snap, members, previous, waiting, spec.followFormationId ? formations.membersOf(spec.followFormationId) : undefined)
}
const members = (ctx: GoalContext<'repair'>) => alive(ctx, ctx.formations.membersOf(ctx.spec.formationId)).filter(id => ctx.snap.self.some(unit => unit.id === id && (ctx.spec.vehicleNames.includes(unit.name) || ctx.spec.engineerNames.includes(unit.name))))
export const repair: GoalHandler<'repair'> = {
  validateSpec(spec) {
    if (!spec.formationId || !stringsValid(spec.vehicleNames, false) || !stringsValid(spec.engineerNames, false) || !stringsValid(spec.tankNames, false) || !stringsValid(spec.preparationGoalIds) || !spec.policy || !Number.isSafeInteger(spec.policy.retryTicks) || spec.policy.retryTicks < 1 || !Number.isSafeInteger(spec.policy.stallTicks) || spec.policy.stallTicks <= spec.policy.retryTicks) throw new Error('维修目标参数非法')
  },
  validateLive(ctx) {
    if (!formationExists(ctx, ctx.spec.formationId, true)) throw new Error('维修编队不存在或尚无准备目标')
    if (ctx.spec.followFormationId === ctx.spec.formationId || ctx.spec.followFormationId && !formationExists(ctx, ctx.spec.followFormationId)) throw new Error('被支援编队不存在或与维修队相同')
  },
  validateFacts({ facts }) {
    const state = facts.repair
    if (state && (!Array.isArray(state.engineerIds) || state.engineerIds.some(id => !Number.isSafeInteger(id)) || !Array.isArray(state.pairs) || state.pairs.some(pair => !Number.isSafeInteger(pair.engineerId) || !Number.isSafeInteger(pair.vehicleId)) || !Array.isArray(state.jobs) || state.jobs.some(job => !Number.isSafeInteger(job.unitId) || !Number.isSafeInteger(job.targetId) || [job.x, job.y, job.hp, job.progressTick].some(value => !Number.isFinite(value))) || !state.avoid || Object.values(state.avoid).some(value => !Number.isFinite(value)))) throw new Error('维修组装或分工进度非法')
  },
  observe(ctx) {
    const planned = plan(ctx)
    if (paused(ctx)) for (const job of planned.state.jobs) job.progressTick = ctx.snap.tick
    ctx.goal.facts.repair = planned.state
    if (!planned.view.waiting && (!ctx.formations.membersOf(ctx.spec.formationId).some(id => ctx.snap.self.some(unit => unit.id === id)) || ctx.spec.skill && !planned.view.readyIds.length && !planned.view.assembling.length)) { ctx.goal.status = 'failed'; ctx.goal.facts.outcomeDetail = '维修成员或可组装组件已损失，未追加生产' }
  },
  project(ctx) {
    const { view } = plan(ctx)
    return projection(ctx, { ...baseConstraints(ctx), allowedUnitIds: members(ctx), allowedActions: ['enterTransport', 'repair', 'move', 'stop'], friendlyTargetIds: [...view.assembling.map(pair => pair.vehicleId), ...view.damaged.map(unit => unit.id)], region: world(ctx, '维修支援') }, { repair: view, ...blocked(ctx) })
  },
  execution({ spec }, { view }) {
    if (view.blocked) return
    const r = view.repair!
    return { state: r.readyIds.length ? 'continuous' : 'running', ...(spec.quantity ? { progress: { completed: r.readyIds.length, total: spec.quantity, label: '已组装维修车' } } : {}), detail: `${r.waiting ? '等待组件生产及交接；' : ''}已组装${r.readyIds.length}辆；${r.assembling.length}组正在上车；${r.targets.length}辆分头维修，受损坦克${r.damaged.length}辆${!r.targets.length && r.readyIds.length ? '，待命中' : ''}` }
  },
  stopMembers: members,
}
