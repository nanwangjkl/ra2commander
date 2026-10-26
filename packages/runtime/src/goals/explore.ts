import { alive, baseConstraints, blocked, formationExists, projection, world, terminal } from './common.ts'
import type { GoalContext, GoalHandler } from './types.ts'

function progress(ctx: GoalContext<'explore'>, projected: import('@ra2c/contracts').GoalView) {
  const view = projected.exploration
  if (!view) return {}
  const unfinished = view.regions.filter(region => !region.satisfied), threshold = Math.round(view.coverageRatio * 100)
  return { progress: { completed: view.regions.length - unfinished.length, total: view.regions.length, label: `分区达标（每区≥${threshold}%）` }, detail: unfinished.length ? `未达标：${unfinished.map(region => `${region.name} ${region.total ? Math.floor(region.seen * 1000 / region.total) / 10 : 0}%`).join('、')}` : `全部目标分区覆盖均已达到${threshold}%` }
}
const members = (ctx: GoalContext<'explore'>) => alive(ctx, ctx.formations.membersOf(ctx.spec.formationId))
export const explore: GoalHandler<'explore'> = {
  validateSpec(spec) {
    if (!spec.formationId || spec.explorationId !== spec.id || !spec.policy || [spec.policy.pointSpacing, spec.policy.stallTicks, spec.policy.maxStallsPerRegion].some(value => !Number.isSafeInteger(value) || value < 1) || spec.policy.coverageRatio !== undefined && (!Number.isFinite(spec.policy.coverageRatio) || spec.policy.coverageRatio <= 0 || spec.policy.coverageRatio > 1)) throw new Error('探索策略非法')
    if ([spec.policy.interiorMargin, spec.policy.retryPasses].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) throw new Error('探索内缩与重试参数非法')
    if (spec.policy.centerFirst !== undefined && typeof spec.policy.centerFirst !== 'boolean') throw new Error('探索中心优先参数非法')
  },
  validateLive(ctx) {
    if (!formationExists(ctx, ctx.spec.formationId, true)) throw new Error('探索编队不存在或尚无准备目标')
    if (!ctx.exploration.progress.has(ctx.spec.explorationId)) throw new Error('探索范围不存在')
  },
  observeLast: true,
  observe(ctx) {
    const { spec, goal, snap, programs, formations, handoffs, exploration } = ctx
    const status = programs.get(goal.ownerId)?.status
    if (status === 'paused') { exploration.suspend(spec.explorationId, snap.tick); return }
    if (status !== 'active') return
    const preparation = spec.preparationGoalId && ctx.goals.get(spec.preparationGoalId)
    const ready = formations.membersOf(spec.formationId).filter(id => !ctx.locked(id))
    const waiting = !!preparation && !terminal(preparation.status) || handoffs.some(handoff => handoff.unitIds.some(id => formations.ownerOf(id) === spec.formationId))
    const result = exploration.advance(spec, snap, ready, waiting)
    if (!result) return
    goal.status = result.state; goal.facts.outcomeDetail = result.detail
    return { stopIds: snap.self.filter(unit => ready.includes(unit.id)).map(unit => unit.id) }
  },
  project(ctx) {
    const unitIds = members(ctx)
    return projection(ctx, { ...baseConstraints(ctx), allowedUnitIds: unitIds, allowedActions: ['move', 'gather', 'stop'], region: world(ctx, '侦察路径') }, { ...(ctx.exploration.progress.has(ctx.spec.explorationId) ? { exploration: ctx.exploration.view(ctx.spec), ...(!unitIds.length ? { blocked: '等待侦察成员实际交接就绪' } : {}) } : {}), ...blocked(ctx) })
  },
  progress,
  stopMembers: members,
  pause(ctx) { ctx.exploration.suspend(ctx.spec.explorationId, ctx.snap.tick) },
}
