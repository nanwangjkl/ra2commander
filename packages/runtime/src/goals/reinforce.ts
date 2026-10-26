import { baseConstraints, blocked, formationExists, projection } from './common.ts'
import type { GoalHandler } from './types.ts'
export const reinforce: GoalHandler<'reinforce'> = {
  validateSpec(spec) { if (!spec.formationId || !spec.name || !Number.isSafeInteger(spec.targetSize) || spec.targetSize < 1 || spec.source === spec.formationId || spec.source !== null && !spec.source) throw new Error('补员目标或来源非法') },
  validateLive(ctx) { if (!formationExists(ctx, ctx.spec.formationId) || ctx.spec.source !== null && !formationExists(ctx, ctx.spec.source)) throw new Error('补员目标或来源非法') },
  project(ctx) {
    const { spec, snap, formations, production } = ctx
    const target = snap.self.filter(unit => unit.name === spec.name && formations.ownerOf(unit.id) === spec.formationId).length
    const unknown = new Set(production.filter(record => record.state === 'unknown' || record.state === 'reserved').flatMap(record => record.observedIds))
    const ids = snap.self.filter(unit => unit.name === spec.name && (formations.ownerOf(unit.id) ?? null) === spec.source && !ctx.locked(unit.id) && !unknown.has(unit.id)).map(unit => unit.id)
    return projection(ctx, { ...baseConstraints(ctx), management: { kind: 'transferUnits', formationId: spec.formationId, allowedUnitIds: ids, maxUnits: Math.max(0, spec.targetSize - target) } }, blocked(ctx))
  },
  continuous: () => true,
  managedMembers: ({ spec, snap, formations }) => snap.self.filter(unit => unit.name === spec.name && ((formations.ownerOf(unit.id) ?? null) === spec.source || formations.ownerOf(unit.id) === spec.formationId)).map(unit => unit.id),
}
