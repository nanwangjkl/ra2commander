import { validTargetRegion } from '@ra2c/contracts'
import { initialAttack, planAttack, recordAttack } from '../attack.ts'
import { baseConstraints, formationExists, idsValid, paused, projection, stringsValid, world } from './common.ts'
import type { GoalContext, GoalHandler } from './types.ts'

function members({ spec, goal, snap, locked, formations }: GoalContext<'attack'>) {
  return snap.self.filter(unit => !locked(unit.id) && (formations.ownerOf(unit.id) ?? undefined) === spec.formationId && (spec.dynamicNames ? spec.dynamicNames.includes(unit.name) && !!(unit.primaryWeapon || unit.secondaryWeapon) : spec.unitIds.includes(unit.id) && (goal.spec.kind !== 'attack' || goal.spec.unitIds.includes(unit.id)))).map(unit => unit.id)
}
function plan(ctx: GoalContext<'attack'>) {
  const preparing = ctx.spec.preparationGoalIds.some(id => { const goal = ctx.goals.get(id); return goal && ['pending', 'active'].includes(goal.status) })
  return planAttack(ctx.spec, ctx.snap, members(ctx), ctx.goal.facts.attack ?? initialAttack(), preparing, ctx.goal.spec.kind === 'attack' ? ctx.goal.spec.unitIds : ctx.spec.unitIds)
}
export const attack: GoalHandler<'attack'> = {
  validateSpec(spec) {
    if (!idsValid(spec.unitIds, true) || !spec.unitIds.length && !spec.dynamicNames?.length || !idsValid(spec.aircraftIds, true) || spec.aircraftIds.some(id => !spec.unitIds.includes(id)) || !stringsValid(spec.preparationGoalIds) || !stringsValid(spec.targetNames) || spec.dynamicNames && !stringsValid(spec.dynamicNames, false) || !['enemies', 'base', 'units', 'buildings'].includes(spec.targetKind) || !spec.ammoCapacity || Object.values(spec.ammoCapacity).some(value => !Number.isFinite(value)) || spec.targetRegion && !validTargetRegion(spec.targetRegion)) throw new Error('攻击对象或目标范围非法')
  },
  validateLive(ctx) { if (ctx.spec.formationId && !formationExists(ctx, ctx.spec.formationId, true)) throw new Error('攻击编队不存在或尚无准备目标') },
  validateFacts({ facts, activeSpec }) {
    const state = facts.attack
    if (state && (!Array.isArray(state.members) || new Set(state.members.map(member => member.unitId)).size !== state.members.length || state.members.some(member => !Number.isSafeInteger(member.unitId) || typeof member.aircraft !== 'boolean' || !['pending', 'ready', 'attacking', 'fired', 'lost', 'released'].includes(member.phase) || [member.lastAmmo, member.lastCooldown, member.acceptedAt, member.firedAt].some(value => value !== undefined && !Number.isFinite(value))))) throw new Error('攻击与投弹进度非法')
    if (activeSpec && !state) throw new Error('攻击缺少执行进度')
  },
  initialize({ goal }) { goal.facts.attack ??= initialAttack(); goal.facts.initialized = true },
  observe(ctx) {
    const planned = plan(ctx)
    ctx.goal.facts.attack = planned.state
    if (paused(ctx)) for (const member of planned.state.members) if (member.acceptedAt !== undefined) member.acceptedAt = ctx.snap.tick
    if (planned.finished) { ctx.goal.status = planned.outcome; if (planned.outcome !== 'completed') ctx.goal.facts.outcomeDetail = planned.view.detail }
  },
  project(ctx) {
    const planned = plan(ctx)
    return projection(ctx, { ...baseConstraints(ctx), allowedUnitIds: planned.view.readyIds, allowedActions: ['attack', 'move', 'attackMove', 'stop'], aircraftIds: planned.state.members.filter(member => member.aircraft).map(member => member.unitId), enemyIds: planned.view.targets.map(unit => unit.id), region: world(ctx, '攻击与返航路径') }, { attack: planned.view })
  },
  execution(_ctx, { view }) {
    const attack = view.attack!
    const waiting = !attack.readyIds.length && !attack.attackingIds.length && (attack.pendingIds.length > 0 || attack.preparing)
    return { state: waiting ? 'pending' : attack.groundIds.length ? 'continuous' : 'running', detail: attack.detail, ...(attack.totalAircraft ? { progress: { completed: attack.firedIds.length, total: attack.totalAircraft, label: '已实际发射一次' } } : {}) }
  },
  terminalExecution({ goal }) {
    const aircraft = goal.facts.attack?.members.filter(member => member.aircraft) ?? []
    return { state: goal.status as 'completed' | 'partial' | 'failed', detail: goal.facts.outcomeDetail ?? '本次飞机已实际发射，返航与装弹交给游戏', ...(aircraft.length ? { progress: { completed: aircraft.filter(member => member.phase === 'fired').length, total: aircraft.length, label: '已实际发射一次' } } : {}) }
  },
  managedMembers: members,
  stopMembers: ctx => members(ctx).filter(id => !ctx.goal.facts.attack?.members.some(member => member.unitId === id && member.phase === 'fired')),
  afterSubmit({ goal, snap }, request, results) { recordAttack(goal.facts.attack ??= initialAttack(), request, results, snap) },
}
