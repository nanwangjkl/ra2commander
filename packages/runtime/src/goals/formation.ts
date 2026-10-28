import { alive, baseConstraints, blocked, formationExists, idsValid, projection } from './common.ts'
import type { GoalContext, GoalHandler } from './types.ts'
import { validateCover } from '../cover.ts'
const members = ({ spec, formations }: GoalContext<'formation'>) => spec.request.kind === 'dissolveFormation' ? formations.membersOf(spec.request.formationId) : spec.request.unitIds
export const formation: GoalHandler<'formation'> = {
  validateSpec(spec) {
    if (spec.cover) validateCover(spec.cover)
    const r = spec.request
    if (!r || !r.formationId || !['createFormation', 'transferUnits', 'dissolveFormation'].includes(r.kind) || r.kind !== 'dissolveFormation' && !idsValid(r.unitIds)) throw new Error('编队请求非法')
  },
  validateLive(ctx) {
    const r = ctx.spec.request, exists = formationExists(ctx, r.formationId)
    if (r.kind === 'createFormation' && exists) throw new Error('编队已存在')
    if (r.kind !== 'createFormation' && !exists) throw new Error('目标编队不存在')
    if (r.kind !== 'dissolveFormation') {
      if (r.unitIds.some(id => !ctx.snap.self.some(unit => unit.id === id))) throw new Error('编队成员非法或已消失')
      if (r.kind === 'createFormation' && !r.force && r.unitIds.some(id => ctx.formations.ownerOf(id))) throw new Error('成员已属于其他编队，明确转编或使用 --force')
    }
  },
  observe({ spec, goal, formations, locked }) { const r = spec.request; if (r.kind !== 'dissolveFormation' && r.unitIds.every(id => formations.ownerOf(id) === r.formationId && !locked(id))) goal.status = 'completed' },
  project(ctx) {
    const { spec, formations } = ctx, r = spec.request, ids = members(ctx)
    const needed = r.kind === 'dissolveFormation' ? ids : ids.filter(id => formations.ownerOf(id) !== r.formationId)
    const allowed = alive(ctx, needed).filter(id => !spec.sourceOwners || spec.sourceOwners.some(([unit, from]) => unit === id && (formations.ownerOf(id) ?? null) === from))
    const kind = r.kind === 'createFormation' && formationExists(ctx, r.formationId) ? 'transferUnits' : r.kind
    return projection(ctx, { ...baseConstraints(ctx), management: { kind, formationId: r.formationId, allowedUnitIds: allowed, maxUnits: needed.length, exact: true, ...(kind === 'createFormation' && r.kind === 'createFormation' ? { force: !!r.force } : {}) } }, blocked(ctx))
  },
  managedMembers: members,
  nativeActions(ctx) { return ctx.goal.status === 'active' ? [ctx.spec.request] : [] },
}
