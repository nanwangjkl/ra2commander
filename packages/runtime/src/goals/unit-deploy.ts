import { validTargetRegion } from '@ra2c/contracts'
import { deploymentIds, initialUnitDeployment, planUnitDeployment, recordDeployment, reserveDeployment } from '../unit-deployment.ts'
import { baseConstraints, idsValid, paused, point, projection, world } from './common.ts'
import type { GoalHandler } from './types.ts'

export const unitDeploy: GoalHandler<'unitDeploy'> = {
  validateSpec(spec, map) {
    if (spec.excludedIds && !idsValid(spec.excludedIds, true) || spec.transientNames && (!Array.isArray(spec.transientNames) || spec.transientNames.some(name => typeof name !== 'string' || !name))) throw new Error('部署成员范围非法')
    if (typeof spec.deployed !== 'boolean' || !idsValid(spec.unitIds, true) || !Array.isArray(spec.sources) || !spec.unitIds.length && !spec.sources.length || spec.sources.some(source => !source.goalId || !source.name || !Number.isSafeInteger(source.quantity) || source.quantity < 1) || new Set(spec.sources.map(source => source.goalId)).size !== spec.sources.length || spec.destination && !point(map, spec.destination.x, spec.destination.y) || spec.targetRegion && (!spec.destination || !validTargetRegion(spec.targetRegion))) throw new Error('单位部署目标非法')
  },
  validateLive(ctx) {
    if (ctx.spec.sources.some(source => { const goal = ctx.goals.get(source.goalId); return goal?.spec.kind !== 'production' || goal.spec.target !== source.name || source.quantity > goal.spec.quantity })) throw new Error('部署生产来源无效')
    if (ctx.spec.unitIds.some(id => !ctx.snap.self.some(unit => unit.id === id && typeof unit.isDeployed === 'boolean' && unit.canDeploy))) throw new Error('没有匹配的可部署单位；基地车及建筑变形仍使用原入口')
  },
  initialize({ goal }) { goal.facts.unitDeployment ??= initialUnitDeployment(); goal.facts.initialized = true },
  validateFacts({ facts, activeSpec }) {
    const state = facts.unitDeployment
    if (state && Array.isArray(state.jobs) && state.jobs.some(job => job.joined !== undefined && typeof job.joined !== 'boolean')) throw new Error('部署编队交接事实非法')
    if (activeSpec && !state || state && (!Array.isArray(state.jobs) || new Set(state.jobs.map(job => job.unitId)).size !== state.jobs.length || state.jobs.some(job => !Number.isSafeInteger(job.unitId) || !Number.isSafeInteger(job.attempts) || job.attempts < 0 || job.sentAt !== undefined && !Number.isFinite(job.sentAt) || job.progressAt !== undefined && !Number.isFinite(job.progressAt) || job.completed !== undefined && typeof job.completed !== 'boolean' || job.failed !== undefined && typeof job.failed !== 'string' || job.step !== undefined && !['move', 'deploy', 'undeploy'].includes(job.step)))) throw new Error('单位部署进度非法')
  },
  observe(ctx) {
    const plan = planUnitDeployment(ctx)
    ctx.goal.facts.unitDeployment = plan.state
    if (paused(ctx)) for (const job of plan.state.jobs) { if (job.sentAt !== undefined) job.sentAt = ctx.snap.tick; job.progressAt = ctx.snap.tick }
    if (plan.finished) { ctx.goal.status = plan.outcome; ctx.goal.facts.outcomeDetail = plan.view.detail }
  },
  project(ctx) {
    const { view } = planUnitDeployment(ctx)
    return projection(ctx, { ...baseConstraints(ctx), region: world(ctx, '单位部署行军'), allowedUnitIds: view.actions.flatMap(action => 'unitIds' in action ? action.unitIds : []), allowedActions: ['move', 'deploy'] }, { unitDeployment: view })
  },
  nativeActions: ctx => planUnitDeployment(ctx).view.actions,
  execution(ctx, { view }) { const state = view.unitDeployment!; return { state: state.pending ? 'pending' : 'running', detail: state.detail, progress: { completed: state.completed, total: state.total, label: ctx.spec.deployed ? '实际部署' : '实际解除部署' } } },
  terminalExecution(ctx) { const { view } = planUnitDeployment(ctx); return { state: ctx.goal.status as 'completed' | 'partial' | 'failed', detail: ctx.goal.facts.outcomeDetail ?? view.detail, progress: { completed: view.completed, total: view.total } } },
  managedMembers: deploymentIds,
  stopMembers: ctx => deploymentIds(ctx).filter(id => !ctx.locked(id)),
  beforeSubmit({ goal, snap }, action) { reserveDeployment(goal.facts.unitDeployment ??= initialUnitDeployment(), action, snap.tick) },
  afterSubmit({ goal }, action, results) { recordDeployment(goal.facts.unitDeployment ??= initialUnitDeployment(), action, results) },
}
