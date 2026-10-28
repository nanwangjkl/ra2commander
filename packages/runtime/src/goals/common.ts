import { goalOwner, ownerId, type GoalConstraints, type GoalView } from '@ra2c/contracts'
import { assessArrival } from '../arrival.ts'
import { coverMembers } from '../cover.ts'
import type { GoalContext, GoalProjection, MapSize } from './types.ts'

export const terminal = (status: string) => ['completed', 'partial', 'failed', 'cancelled'].includes(status)
export const point = (map: MapSize, x: number, y: number) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < map.mapWidth && y < map.mapHeight
export const idsValid = (ids: number[], allowEmpty = false) => Array.isArray(ids) && (allowEmpty || ids.length > 0) && new Set(ids).size === ids.length && ids.every(Number.isSafeInteger)
export const stringsValid = (values: string[], allowEmpty = true) => Array.isArray(values) && (allowEmpty || values.length > 0) && values.every(value => typeof value === 'string' && !!value)
export const paused = (ctx: GoalContext) => ctx.programs.get(ownerId(goalOwner(ctx.spec)))?.status === 'paused'
export const alive = (ctx: GoalContext, ids: number[]) => ids.filter(id => ctx.snap.self.some(unit => unit.id === id) && !ctx.locked(id))
export const world = (ctx: GoalContext, name: string) => ({ name, x1: 0, y1: 0, x2: ctx.snap.mapWidth - 1, y2: ctx.snap.mapHeight - 1 })
export const formationExists = (ctx: GoalContext, id: string, planned = false) => ctx.formations.list().some(formation => formation.id === id) || planned && ctx.hasPlannedFormation(id)
export function baseConstraints(ctx: GoalContext): GoalConstraints {
  return { allowedUnitIds: [], enemyIds: ctx.snap.enemies.map(unit => unit.id), mapWidth: ctx.snap.mapWidth, mapHeight: ctx.snap.mapHeight, allowedActions: [] }
}
/** 不跨请求缓存；同一投影的约束与视图共用计算结果，动作提交前重新投影。 */
export function projection(ctx: GoalContext, constraints: GoalConstraints, extra: Partial<GoalView> = {}): GoalProjection {
  const { spec, goal: { facts } } = ctx
  const view: GoalView = { spec, unitIds: constraints.management?.allowedUnitIds ?? constraints.allowedUnitIds, produceRemaining: constraints.produceRemaining ?? {}, submitted: {}, observed: {}, uncertain: [], lossRatio: facts.lossRatio, retreatActive: facts.retreatTriggered, ...extra }
  if (constraints.blocked) view.blocked = constraints.blocked
  if (constraints.management) view.maxUnits = constraints.management.maxUnits
  if (constraints.management?.exact && constraints.management.allowedUnitIds.length !== constraints.management.maxUnits) view.blocked = '成员或来源已变化，请重新下达管理命令'
  return { constraints, view }
}
export function blocked(ctx: GoalContext): Partial<GoalView> { return ctx.goal.facts.blocked ? { blocked: ctx.goal.facts.blocked } : {} }
export function movementArrival(ctx: GoalContext) {
  const { spec, goal: { facts }, snap, formations } = ctx
  const destination = spec.kind === 'combat' ? spec.route?.[facts.routeIndex ?? 0] ?? spec.destination : spec.kind === 'rally' ? { x: spec.x, y: spec.y } : undefined
  if (!destination) return undefined
  const ids = new Set(spec.kind === 'combat' ? formations.membersOf(spec.formationId) : spec.kind === 'rally' ? spec.unitIds.filter(id => !formations.ownerOf(id)) : [])
  const arrival = assessArrival(snap.self.filter(unit => ids.has(unit.id)), destination, id => ctx.locked(id))
  const cover = spec.kind === 'combat' ? formations.coverOf(spec.formationId) : undefined
  if (cover) {
    const { members, slowest, protectedUnits, escorts } = coverMembers(cover, snap, [...ids])
    const remaining = members.map(unit => Math.hypot(unit.rx - destination.x, unit.ry - destination.y))
    const preparing = [...(cover.protectedSources ?? []), ...(cover.escortSources ?? []).map(source => source.goalId)].some(id => ['pending', 'active'].includes(ctx.goals.get(id)?.status ?? ''))
    arrival.reached &&= !preparing && protectedUnits.length > 0 && escorts.every(unit => !ctx.locked(unit.id)) && slowest.every(unit => Math.hypot(unit.rx - destination.x, unit.ry - destination.y) <= arrival.radius)
      && Math.max(0, ...remaining) - Math.min(...remaining) <= Math.max(cover.gap, Math.sqrt(members.length))
  }
  return arrival
}
