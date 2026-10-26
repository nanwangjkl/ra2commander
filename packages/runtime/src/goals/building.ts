import { initialBuilding, planBuilding, reserveBuilding, recordBuilding } from '../building.ts'
import { baseConstraints, idsValid, paused, projection } from './common.ts'
import type { GoalContext, GoalHandler } from './types.ts'

const plan = ({ spec, goal, snap }: GoalContext<'building'>) => planBuilding(spec, snap, goal.facts.building ?? initialBuilding(), goal.spec.kind === 'building' ? goal.spec.unitIds : spec.unitIds)
const execution = (ctx: GoalContext<'building'>, view: NonNullable<import('@ra2c/contracts').GoalView['building']>) => ({ detail: view.detail, progress: { completed: view.completed, total: view.total, label: ctx.spec.operation === 'repair' ? '已修复建筑' : '建筑已离场' } })
export const building: GoalHandler<'building'> = {
  validateSpec(spec) {
    if (!['repair', 'sell'].includes(spec.operation) || !idsValid(spec.unitIds)) throw new Error('建筑操作目标非法')
  },
  validateLive({ spec, goal, snap }) {
    const tracked = goal.spec.kind === 'building' && goal.spec.operation === spec.operation ? goal.facts.building?.jobs ?? [] : []
    if (spec.unitIds.some(id => !snap.self.some(unit => unit.id === id && unit.type === 2) && !tracked.some(job => job.unitId === id))) throw new Error('建筑操作只能选择现有己方建筑')
  },
  validateFacts({ facts, activeSpec }) {
    const state = facts.building
    if (state && (!Array.isArray(state.jobs) || new Set(state.jobs.map(job => job.unitId)).size !== state.jobs.length || state.jobs.some(job => !Number.isSafeInteger(job.unitId) || !Number.isSafeInteger(job.attempts) || job.attempts < 0 || job.sentAt !== undefined && !Number.isFinite(job.sentAt) || job.completed !== undefined && typeof job.completed !== 'boolean' || job.failed !== undefined && typeof job.failed !== 'string'))) throw new Error('建筑操作进度非法')
    if (activeSpec && !state) throw new Error('建筑操作缺少实际进度')
  },
  initialize({ goal }) { goal.facts.building ??= initialBuilding(); goal.facts.initialized = true },
  observe(ctx) {
    const planned = plan(ctx)
    ctx.goal.facts.building = planned.state
    if (paused(ctx)) for (const job of planned.state.jobs) if (job.sentAt !== undefined) job.sentAt = ctx.snap.tick
    if (planned.finished) { ctx.goal.facts.outcomeDetail = planned.view.detail; ctx.goal.status = planned.outcome }
  },
  project(ctx) {
    const { view } = plan(ctx)
    return projection(ctx, { ...baseConstraints(ctx), allowedUnitIds: view.actions.flatMap(action => 'unitIds' in action ? action.unitIds : []), allowedActions: [ctx.spec.operation === 'repair' ? 'repairBuilding' : 'sellBuilding'], buildingActions: view.actions }, { building: view })
  },
  nativeActions: ctx => plan(ctx).view.actions,
  execution(ctx, { view }) { return { state: view.building!.pending ? 'pending' : 'running', ...execution(ctx, view.building!) } },
  terminalExecution(ctx) { return { state: ctx.goal.status as 'completed' | 'partial' | 'failed', ...execution(ctx, plan(ctx).view) } },
  managedMembers: ({ spec }) => spec.unitIds,
  beforeSubmit({ goal, snap }, request) { reserveBuilding(goal.facts.building ??= initialBuilding(), request, snap.tick) },
  afterSubmit({ goal }, request, results) { recordBuilding(goal.facts.building ??= initialBuilding(), request, results) },
}
