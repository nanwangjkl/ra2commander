import { alive, baseConstraints, blocked, idsValid, movementArrival, point, projection, world } from './common.ts'
import type { GoalContext, GoalHandler } from './types.ts'
const members = (ctx: GoalContext<'rally'>) => alive(ctx, ctx.spec.unitIds).filter(id => !ctx.formations.ownerOf(id) && (ctx.goal.spec.kind !== 'rally' || ctx.goal.spec.unitIds.includes(id)))
export const rally: GoalHandler<'rally'> = {
  validateSpec(spec, map) { if (!point(map, spec.x, spec.y) || !idsValid(spec.unitIds)) throw new Error('集结目标非法') },
  observe(ctx) { if (movementArrival(ctx)?.reached) ctx.goal.status = 'completed' },
  project(ctx) {
    const arrival = movementArrival(ctx)
    return projection(ctx, { ...baseConstraints(ctx), allowedUnitIds: members(ctx), allowedActions: ['move', 'stop'], region: world(ctx, '集结路径'), destination: { x: ctx.spec.x, y: ctx.spec.y } }, { ...(arrival ? { arrival } : {}), ...blocked(ctx) })
  },
  managedMembers: ({ spec }) => spec.unitIds,
  stopMembers: members,
}
