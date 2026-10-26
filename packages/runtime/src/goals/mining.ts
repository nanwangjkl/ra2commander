import { inTargetRegion, validTargetRegion } from '@ra2c/contracts'
import { initialMining, planMining, recordMiningResult } from '../mining.ts'
import { baseConstraints, idsValid, paused, point, projection, world, formationExists } from './common.ts'
import type { GoalContext, GoalHandler } from './types.ts'

function members({ spec, goal, snap, formations, locked }: GoalContext<'mining'>) {
  return spec.unitIds.filter(id => snap.self.some(unit => unit.id === id) && !locked(id) && (formations.ownerOf(id) ?? undefined) === spec.formationId && (goal.spec.kind !== 'mining' || goal.spec.unitIds.includes(id)))
}
const plan = (ctx: GoalContext<'mining'>) => planMining(ctx.spec, ctx.snap, members(ctx), ctx.goal.facts.mining ?? initialMining())
export const mining: GoalHandler<'mining'> = {
  validateSpec(spec, map) {
    if (!idsValid(spec.unitIds) || !validTargetRegion(spec.targetRegion) || !spec.destination || !point(map, spec.destination.x, spec.destination.y) || !inTargetRegion(spec.destination.x, spec.destination.y, spec.targetRegion)) throw new Error('采矿目标或分区非法')
  },
  validateLive(ctx) { if (ctx.spec.formationId && !formationExists(ctx, ctx.spec.formationId)) throw new Error('采矿编队不存在') },
  validateFacts({ facts, spec, activeSpec }, map) {
    const state = facts.mining
    const validCell = (cell: number) => Number.isSafeInteger(cell) && cell >= 0 && cell < map.mapWidth * map.mapHeight
    if (state) {
      if (spec.kind !== 'mining') throw new Error('采矿进度与目标不符')
      if (!Number.isSafeInteger(state.cursor) || state.cursor < 0 || !Number.isSafeInteger(state.passes) || state.passes < 0 || !Array.isArray(state.oreCells) || state.oreCells.some(cell => !validCell(cell) || !inTargetRegion(cell % map.mapWidth, Math.floor(cell / map.mapWidth), spec.targetRegion)) || !Array.isArray(state.jobs) || state.jobs.some(job => !Number.isSafeInteger(job.unitId) || job.target !== undefined && !validCell(job.target) || job.lastSentTick !== undefined && !Number.isFinite(job.lastSentTick) || job.idleSince !== undefined && !Number.isFinite(job.idleSince) || job.lastKind !== undefined && !['move', 'gather'].includes(job.lastKind))) throw new Error('采矿观察或发令进度非法')
    }
    if (activeSpec && !state) throw new Error('采矿缺少观察与发令进度')
  },
  initialize({ goal }) { goal.facts.mining ??= initialMining(); goal.facts.initialized = true },
  observe(ctx) {
    const planned = plan(ctx)
    ctx.goal.facts.mining = planned.state
    if (paused(ctx)) for (const job of planned.state.jobs) { if (job.lastSentTick !== undefined) job.lastSentTick = ctx.snap.tick; if (job.idleSince !== undefined) job.idleSince = ctx.snap.tick }
    if (!planned.view.total) {
      ctx.goal.status = ctx.spec.unitIds.some(id => ctx.snap.self.some(unit => unit.id === id)) ? 'cancelled' : 'failed'
      ctx.goal.facts.cancelReason = ctx.goal.facts.outcomeDetail = '矿车已损失或交给其他控制对象，未追加生产'
    }
  },
  project(ctx) {
    const { view } = plan(ctx), unitIds = members(ctx)
    return projection(ctx, { ...baseConstraints(ctx), allowedUnitIds: unitIds, allowedActions: ['move', 'gather'], miningActions: view.actions, region: world(ctx, '采矿及返厂路径') }, { mining: view, ...(!view.knownOre && !view.actions.length && !view.assigned && ctx.snap.self.filter(unit => unitIds.includes(unit.id)).every(unit => unit.isIdle) ? { blocked: view.detail } : {}) })
  },
  execution(_ctx, { view }) { if (!view.blocked) return { state: view.mining!.assigned ? 'continuous' : 'running', detail: view.mining!.detail, progress: { completed: view.mining!.assigned, total: view.mining!.total, label: '已下达采矿指令' } } },
  nativeActions: ctx => plan(ctx).view.actions,
  managedMembers: ({ spec }) => spec.unitIds,
  stopMembers: members,
  afterSubmit({ goal, snap }, request, results) { recordMiningResult(goal.facts.mining ??= initialMining(), request, results, snap) },
}
