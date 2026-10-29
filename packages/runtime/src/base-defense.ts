import { inTargetRegion, validTargetRegion, type ActionRequest, type TargetRegion } from '@ra2c/contracts'
import type { GoalContext } from './goals/types.ts'
import { emptyCoverMotion } from './cover.ts'
import { guardAttackOrders } from './attack-orders.ts'

export interface BaseDefenseState { anchorId: number; position: { x: number; y: number }; region: TargetRegion }
export function defenseState(ctx: GoalContext<'combat'>): BaseDefenseState {
  const spec=ctx.spec.baseDefense!
  return ctx.goal.facts.baseDefense ?? {anchorId:spec.anchorId,position:spec.position,region:spec.region}
}
export function observeBaseDefense(ctx: GoalContext<'combat'>): void {
  const previous=defenseState(ctx), names=ctx.spec.baseDefense!.anchorNames
  // 仅接受原 ID 或最近位置附近的合法变形，基地被毁不擅自跳到另一座基地。
  const anchor=ctx.snap.self.find(unit=>unit.id===previous.anchorId&&names.includes(unit.name)) ?? ctx.snap.self.filter(unit=>names.includes(unit.name)&&Math.hypot(unit.rx-previous.position.x,unit.ry-previous.position.y)<=3).sort((a,b)=>Math.hypot(a.rx-previous.position.x,a.ry-previous.position.y)-Math.hypot(b.rx-previous.position.x,b.ry-previous.position.y))[0]
  if (!anchor) {ctx.goal.facts.baseDefense ??= structuredClone(previous);return}
  const regions=ctx.regionsAt?.(anchor.rx,anchor.ry) ?? []
  const area=regions.find(region=>region.id===previous.region.id) ?? regions[0] ?? previous.region
  ctx.goal.facts.baseDefense={anchorId:anchor.id,position:{x:anchor.rx,y:anchor.ry},region:area}
}
export function defenseTargets(ctx: GoalContext<'combat'>) { const area=defenseState(ctx).region;return ctx.snap.enemies.filter(unit=>inTargetRegion(unit.rx,unit.ry,area)) }
export function defenseOrders(ctx: GoalContext<'combat'>): ActionRequest[] {
  const ids=ctx.formations.membersOf(ctx.spec.formationId).filter(id=>ctx.snap.self.some(unit=>unit.id===id)&&!ctx.locked(id))
  const motion=ctx.goal.facts.coverMotion ??= emptyCoverMotion(), targets=defenseTargets(ctx)
  return guardAttackOrders(ctx.snap, ids, targets, motion)
}
export function validDefenseState(state: BaseDefenseState): boolean {return !!state&&Number.isSafeInteger(state.anchorId)&&!!state.position&&[state.position.x,state.position.y].every(Number.isFinite)&&validTargetRegion(state.region)}
