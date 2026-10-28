import { randomUUID } from 'node:crypto'
import type { ResolvedCapabilityParameters } from '@ra2c/command'
import { normalizeAttackGoal, type AttackGoal, type AttackObjective, type CombatGoal } from '@ra2c/contracts'
import type { BindingContext, BoundCapability } from './capabilities/bindings.ts'
import { formationName, fullMap, regionDestination, selectUnitSet } from './capabilities/selectors.ts'
import { matchesFutureMember, matchesSelector } from './unit-selection.ts'
import { releaseGlobalOrders } from './mining.ts'

type AttackParams = ResolvedCapabilityParameters['combat.attack']
type AttackOrder = { params: AttackParams; search: AttackObjective['search']['kind']; wholeFormation: boolean }
const id = () => `command-${randomUUID().slice(0, 8)}`
const preparing = (formationId: string, context: BindingContext) => [...context.ctx.runtime.goals.values()].filter(goal => ['pending', 'active'].includes(goal.status) && (
  goal.spec.kind === 'production' && goal.spec.formationId === formationId || goal.spec.kind === 'formation' && goal.spec.request.kind !== 'dissolveFormation' && goal.spec.request.formationId === formationId))

/** 三个公开入口先转为同一种攻击要求，再按成员特性选择兼容执行方式。 */
async function bindOrder(order: AttackOrder, context: BindingContext): Promise<BoundCapability> {
  const { params } = order, { ctx } = context, catalog = await context.catalog()
  const formation = params.formationId ? formationName(ctx, params.formationId, false, true) : undefined
  const sources = formation ? preparing(formation, context).filter(goal => {
    const source = goal.spec
    if (params.unitIds) return source.kind === 'formation' && source.request.kind !== 'dissolveFormation' ? source.request.unitIds.some(id => params.unitIds!.includes(id)) : ctx.runtime.production.some(record => record.goalId === source.id && record.observedIds.some(id => params.unitIds!.includes(id)))
    if (source.kind === 'production') { const item = catalog.all.find(item => item.name === source.target); return item && matchesFutureMember(item, params.selector, catalog) }
    return source.kind === 'formation' && source.request.kind !== 'dissolveFormation' && source.request.unitIds.some(id => ctx.runtime.snapshot!.self.some(unit => unit.id === id && matchesSelector(unit, params.selector, ctx, catalog, context.game)))
  }) : []
  const sourceIds = sources.filter(goal => !params.unitIds || (goal.spec.kind === 'formation' && goal.spec.request.kind !== 'dissolveFormation' ? goal.spec.request.unitIds.some(id => params.unitIds!.includes(id)) : ctx.runtime.production.some(record => record.goalId === goal.spec.id && record.observedIds.some(id => params.unitIds!.includes(id))))).map(goal => goal.spec.id)
  const pendingIds = sources.flatMap(goal => goal.spec.kind === 'formation' && goal.spec.request.kind !== 'dissolveFormation' ? goal.spec.request.unitIds
    : goal.spec.kind === 'production' ? ctx.runtime.production.filter(record => record.goalId === goal.spec.id).flatMap(record => record.observedIds) : [])
  const { region, destination } = params.regionName ? await regionDestination(ctx, params.regionName, context.check) : {}
  const targetNames = catalog.all.filter(item => catalog.isRole(item.name, 'constructionYard', item.type) || catalog.isRole(item.name, 'constructionVehicle', item.type)).map(item => item.name)
  const objective: AttackObjective = { target: { kind: params.target, names: targetNames, ...(params.targetId !== undefined ? { id: params.targetId } : {}), ...(region ? { region: { id: region.id, name: region.name, polygons: structuredClone(region.polygons) } } : {}) },
    search: { kind: order.search, ...(destination && order.search === 'region' ? { destination } : {}) }, completion: { ground: 'continuous', aircraft: 'single-shot' } }
  const hasAircraft = !!formation && (ctx.runtime.snapshot!.self.some(unit => unit.type === 1 && (ctx.formations.ownerOf(unit.id) === formation || pendingIds.includes(unit.id)))
    || sources.some(goal => { const source = goal.spec; return source.kind === 'production' && (source.targetType ?? catalog.all.find(item => item.name === source.target)?.type) === 1 }))
  if (order.wholeFormation && formation && !hasAircraft) {
    await ctx.runtime.clearLostCover(formation); context.check()
    const goal: CombatGoal = { id: id(), kind: 'combat', rawText: context.text, formationId: formation, region: fullMap(ctx.runtime.snapshot!), objective, ...(ctx.runtime.hasCover(formation) ? { executionMode: 'native' as const } : {}),
      allowedActions: ['move', 'attackMove', 'attack', 'stop'], ...(destination ? { destination } : {}), ...(region ? { attackRegion: objective.target.region! } : {}) }
    return { goals: [{ goal: normalizeAttackGoal(goal), choice: region ? `${formation} 前往并清理${region.name}区域内的敌人` : `编队 ${formation} 全图进攻` }] }
  }
  const { selected: members } = selectUnitSet(ctx, params, catalog, context.game, { armed: true, ...(formation ? { formationId: formation, pendingIds } : {}) })
  const names = formation && sourceIds.length && !params.unitIds ? catalog.all.filter(item => matchesFutureMember(item, params.selector, catalog)).map(item => item.name) : []
  const prepared = !!names.length && (params.quantity === 'all' || members.length < params.quantity)
  const awaitingIds = members.filter(unit => ctx.formations.ownerOf(unit.id) !== formation || ctx.runtime.handoffs.some(handoff => handoff.unitIds.includes(unit.id))).map(unit => unit.id)
  const preparationGoalIds = prepared ? sourceIds : sources.filter(goal => goal.spec.kind === 'formation' && goal.spec.request.kind !== 'dissolveFormation'
    ? goal.spec.request.unitIds.some(id => awaitingIds.includes(id)) : ctx.runtime.production.some(record => record.goalId === goal.spec.id && record.observedIds.some(id => awaitingIds.includes(id)))).map(goal => goal.spec.id)
  if (!members.length && !prepared) throw new Error('没有匹配的现有作战单位，未新建编队或追加生产')
  const groups = new Map<string, number[]>()
  for (const unit of members) {
    const owner = formation ?? ctx.formations.ownerOf(unit.id) ?? ''
    groups.set(owner, [...(groups.get(owner) ?? []), unit.id])
  }
  if (prepared && !groups.has(formation!)) groups.set(formation!, [])
  const goals = await releaseGlobalOrders(ctx, groups.get('') ?? [])
  const ammoCapacity = Object.fromEntries(catalog.all.filter(item => item.type === 1).map(item => [item.name, item.ammo ?? 1]))
  context.check()
  for (const [formationId, unitIds] of groups) {
    if (formationId) { await ctx.runtime.clearLostCover(formationId); context.check() }
    const aircraftIds = members.filter(unit => unitIds.includes(unit.id) && unit.type === 1).map(unit => unit.id)
    const goal: AttackGoal = { id: id(), kind: 'attack', rawText: context.text, unitIds, aircraftIds, ammoCapacity, preparationGoalIds, objective,
      ...(formationId && ctx.runtime.hasCover(formationId) && !aircraftIds.length && !hasAircraft ? { executionMode: 'native' as const } : {}),
      membership: prepared ? { kind: 'prepared', goalIds: sourceIds, names, ...(params.quantity !== 'all' ? { limit: params.quantity } : {}) } : { kind: 'selected' },
      targetKind: params.target, targetNames, ...(formationId ? { formationId } : {}), ...(params.targetId !== undefined ? { targetId: params.targetId } : {}), ...(region ? { targetRegion: objective.target.region! } : {}) }
    const target = params.targetId !== undefined ? `敌人#${params.targetId}` : ({ enemies: '敌人', base: '敌方基地', units: '敌方单位', buildings: '敌方建筑' }[params.target])
    goals.push({ goal: normalizeAttackGoal(goal), choice: `${formationId ? `${formationId}中选定成员` : `${unitIds.length}个现有单位`}攻击${region ? `${region.name}内的` : ''}${target}${aircraftIds.length || prepared && names.some(name => catalog.all.some(item => item.name === name && item.type === 1)) ? '；飞机满弹后各出击一次，以实际发射确认完成' : ''}（保留归属，不新建编队）` })
  }
  return { goals, ...(params.quantity !== 'all' && members.length < params.quantity && !prepared ? { skipped: [`现有匹配成员仅${members.length}个，先执行这些成员`] } : {}) }
}
export function bindAttack(params: AttackParams, context: BindingContext): Promise<BoundCapability> { return bindOrder({ params, search: 'visible', wholeFormation: false }, context) }
export function bindClearRegion(params: ResolvedCapabilityParameters['combat.clear-region'], context: BindingContext): Promise<BoundCapability> {
  return bindOrder({ params: { ...params, selector: 'combat', target: 'enemies', quantity: 'all' }, search: 'region', wholeFormation: true }, context)
}
export async function bindAttackAll(params: ResolvedCapabilityParameters['combat.attack-all'], context: BindingContext): Promise<BoundCapability> {
  if (params.selector || params.unitIds) return bindOrder({ params: { ...params, selector: params.selector ?? 'combat', target: 'enemies', quantity: 'all' }, search: 'map', wholeFormation: false }, context)
  const { ctx } = context
  const formations = params.formationId ? [formationName(ctx, params.formationId, false, true)] : ctx.formations.list().filter(formation => ctx.runtime.snapshot!.self.some(unit => formation.memberIds.includes(unit.id) && (unit.primaryWeapon || unit.secondaryWeapon))).map(formation => formation.id)
  if (!formations.length) throw new Error('没有可用作战编队')
  const goals: NonNullable<BoundCapability['goals']> = []
  for (const formationId of formations) goals.push(...(await bindOrder({ params: { formationId, selector: 'combat', target: 'enemies', quantity: 'all' }, search: 'map', wholeFormation: true }, context)).goals ?? [])
  return { goals }
}
