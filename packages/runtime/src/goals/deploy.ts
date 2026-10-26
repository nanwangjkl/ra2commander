import { alive, baseConstraints, blocked, idsValid, projection } from './common.ts'
import type { GoalHandler } from './types.ts'
export const deploy: GoalHandler<'deploy'> = {
  validateSpec(spec) { if (!idsValid(spec.unitIds) || !spec.target) throw new Error('展开目标非法') },
  validateLive({ spec, snap }) { if (spec.unitIds.some(id => !snap.self.some(unit => unit.id === id && unit.canDeploy))) throw new Error('没有可展开的基地车') },
  initialize({ spec, goal, snap }) {
    if (!goal.facts.initialized) goal.facts.members = snap.self.filter(unit => spec.unitIds.includes(unit.id)).map(unit => ({ id: unit.id, name: unit.name, rx: unit.rx, ry: unit.ry }))
    goal.facts.initialized = true
  },
  observe({ spec, goal, snap }) { if (goal.facts.members.some(member => snap.self.some(unit => unit.name === spec.target && Math.hypot(unit.rx - member.rx, unit.ry - member.ry) <= 3))) goal.status = 'completed' },
  project(ctx) { return projection(ctx, { ...baseConstraints(ctx), allowedUnitIds: alive(ctx, ctx.spec.unitIds).filter(id => ctx.snap.self.some(unit => unit.id === id && unit.canDeploy)), allowedActions: ['deploy'] }, blocked(ctx)) },
}
