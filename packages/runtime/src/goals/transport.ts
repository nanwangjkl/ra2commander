import { alive, baseConstraints, blocked, idsValid, projection } from './common.ts'
import type { GoalContext, GoalHandler } from './types.ts'
const members = (ctx: GoalContext<'transport'>) => alive(ctx, ctx.spec.unitIds).filter(id => !ctx.formations.ownerOf(id))
export const transport: GoalHandler<'transport'> = {
  validateSpec(spec) { if (!idsValid(spec.unitIds) || !Number.isSafeInteger(spec.transportId)) throw new Error('上车目标非法') },
  validateLive({ spec, snap, formations }) { if (spec.unitIds.some(id => !snap.self.some(unit => unit.id === id && unit.type === 3) || formations.ownerOf(id)) || !snap.self.some(unit => unit.id === spec.transportId && unit.transport && unit.transport.capacity > unit.transport.occupied)) throw new Error('上车成员或载具不可用') },
  observe({ spec, goal, snap }) { const transport = snap.self.find(unit => unit.id === spec.transportId); if (spec.unitIds.every(id => transport?.transport?.unitIds.includes(id))) goal.status = 'completed' },
  project(ctx) { return projection(ctx, { ...baseConstraints(ctx), allowedUnitIds: members(ctx), allowedActions: ['enterTransport'], friendlyTargetIds: ctx.snap.self.filter(unit => unit.id === ctx.spec.transportId && unit.transport && unit.transport.occupied < unit.transport.capacity).map(unit => unit.id) }, blocked(ctx)) },
  managedMembers: ({ spec }) => spec.unitIds,
  stopMembers: members,
}
