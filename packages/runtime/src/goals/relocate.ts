import { inTargetRegion, validTargetRegion } from '@ra2c/contracts'
import { initialRelocation, observeRelocation, relocationView, recordRelocationResult } from '../relocation.ts'
import { alive, baseConstraints, paused, point, projection, world, blocked } from './common.ts'
import type { GoalHandler } from './types.ts'

export const relocate: GoalHandler<'relocate'> = {
  validateSpec(spec, map) {
    if (spec.targetRegion && !validTargetRegion(spec.targetRegion)) throw new Error('基地搬迁分区非法')
    if (!Number.isSafeInteger(spec.unitId) || !spec.vehicleName || !spec.yardName || !spec.origin || !point(map, spec.origin.x, spec.origin.y) || !spec.destination || !point(map, spec.destination.x, spec.destination.y) || !Array.isArray(spec.candidates) || !spec.candidates.length || spec.candidates.some(candidate => !point(map, candidate.x, candidate.y) || spec.targetRegion && !inTargetRegion(candidate.x, candidate.y, spec.targetRegion))) throw new Error('基地搬迁参数非法')
  },
  validateLive({ spec, goal, snap, formations }) {
    if (!goal.facts.relocation && !snap.self.some(unit => unit.id === spec.unitId && [spec.vehicleName, spec.yardName].includes(unit.name) && !formations.ownerOf(unit.id))) throw new Error('基地搬迁对象不可用')
  },
  validateFacts({ spec, activeSpec, facts }) {
    const state = facts.relocation
    if (state && (spec.kind !== 'relocate' || !Number.isSafeInteger(state.unitId) || !['yard', 'vehicle'].includes(state.form) || !['packing', 'moving', 'deploying', 'confirming', 'completed', 'failed'].includes(state.phase) || !Array.isArray(state.knownIds) || state.knownIds.some(id => !Number.isSafeInteger(id)) || !Number.isFinite(state.position?.x) || !Number.isFinite(state.position?.y) || !Number.isSafeInteger(state.candidate) || state.candidate < 0 || state.candidate >= spec.candidates.length || !Number.isFinite(state.progressTick))) throw new Error('基地搬迁进度非法')
    if (activeSpec && !state) throw new Error('基地搬迁缺少实际进度')
  },
  initialize({ spec, goal, snap }) { goal.facts.relocation ??= initialRelocation(spec, snap); goal.facts.initialized = true },
  track(ctx) {
    if (ctx.goal.status !== 'active' || !ctx.goal.facts.relocation) return []
    const state = ctx.goal.facts.relocation
    const converted = observeRelocation(ctx.spec, state, ctx.snap, paused(ctx))
    if (state.phase === 'completed') ctx.goal.status = 'completed'
    else if (state.phase === 'failed') { ctx.goal.status = 'failed'; ctx.goal.facts.outcomeDetail = state.detail }
    return converted === undefined ? [] : [converted]
  },
  project(ctx) {
    const state = ctx.goal.facts.relocation ?? initialRelocation(ctx.spec, ctx.snap)
    const view = relocationView(ctx.spec, state, ctx.snap)
    return projection(ctx, { ...baseConstraints(ctx), allowedUnitIds: view.action ? alive(ctx, [state.unitId]) : [], allowedActions: view.action ? [view.action.kind] : [], ...(view.action ? { relocationAction: view.action } : {}), region: world(ctx, '基地搬迁路径') }, { relocation: view, ...blocked(ctx) })
  },
  execution(_ctx, { view }) { if (!view.blocked) return { state: 'running', detail: view.relocation!.detail, progress: { completed: ['packing', 'moving', 'deploying', 'confirming', 'completed'].indexOf(view.relocation!.phase), total: 4, label: '基地搬迁阶段' } } },
  managedMembers: ({ goal, spec }) => [goal.facts.relocation?.unitId ?? spec.unitId],
  stopMembers: ({ goal, spec, snap }) => [goal.facts.relocation?.unitId ?? spec.unitId].filter(id => snap.self.some(unit => unit.id === id)),
  afterSubmit({ spec, goal, snap }, request, results) {
    if (!goal.facts.relocation) return
    recordRelocationResult(spec, goal.facts.relocation, request, results, snap.tick)
    return results.some(result => result.reason === 'deploy-rejected')
  },
}
