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
  const temporaryAbsenceNames = catalog.all.filter(item => catalog.isRole(item.name, 'terrorDrone', item.type)).map(item => item.name)
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
  const unitNames = new Set<string>(), unitTypes = new Set<number>()
  for (const selector of params.targetSelectors ?? []) {
    const role = context.game.roles().find(role => role.id === context.game.roleForAlias(selector))
    if (role?.match && !role.members.length && !role.match.flags && !role.match.excludeFlags && !role.match.labelIncludes && !role.match.positivePower) unitTypes.add(role.match.type)
    else {
      const matches = catalog.all.filter(item => catalog.matchesUnit(item, selector))
      if (!matches.length) throw new Error(`未找到敌方兵种或类别：${selector}；保留目标要求，不扩大为全部敌人`)
      matches.forEach(item => unitNames.add(item.name))
    }
  }
  const objective: AttackObjective = { target: { kind: params.target, names: targetNames, ...(params.targetId !== undefined ? { id: params.targetId } : {}), ...(region ? { region: { id: region.id, name: region.name, polygons: structuredClone(region.polygons) } } : {}) },
    search: { kind: order.search, ...(destination && order.search === 'region' ? { destination } : {}) }, completion: { ground: 'continuous', aircraft: 'single-shot' }, coordination:params.splitTargets?'independent':formation?'focus':'independent' }
  if (unitNames.size) objective.target.unitNames = [...unitNames]
  if (unitTypes.size) objective.target.unitTypes = [...unitTypes]
  if (params.targetDomain && params.targetDomain !== 'all') objective.target.domain = params.targetDomain
  const targetLabel = params.targetSelectors?.map(selector => context.game.roles().find(role => role.id === context.game.roleForAlias(selector))?.aliases[0] ?? catalog.all.find(item => item.name === selector)?.label ?? selector).join('、')
  const hasAircraft = !!formation && (ctx.runtime.snapshot!.self.some(unit => unit.type === 1 && (ctx.formations.ownerOf(unit.id) === formation || pendingIds.includes(unit.id)))
    || sources.some(goal => { const source = goal.spec; return source.kind === 'production' && (source.targetType ?? catalog.all.find(item => item.name === source.target)?.type) === 1 }))
  if (order.wholeFormation && formation && !hasAircraft) {
    await ctx.runtime.clearLostCover(formation); context.check()
    const goal: CombatGoal = { id: id(), kind: 'combat', rawText: context.text, formationId: formation, region: fullMap(ctx.runtime.snapshot!), objective, executionMode: 'native', temporaryAbsenceNames,
      memberNames:Object.fromEntries(ctx.runtime.unobservableMembers(formation).map(member=>[member.id,member.name])),
      allowedActions: ['move', 'attackMove', 'attack', 'stop'], ...(destination ? { destination } : {}), ...(region ? { attackRegion: objective.target.region! } : {}) }
    const selectedTarget = `${params.targetDomain === 'air' ? '空中' : params.targetDomain === 'ground' ? '地面' : ''}${targetLabel ?? '敌人'}`
    return { goals: [{ goal: normalizeAttackGoal(goal), choice: `${formation} 直接攻击${region ? `${region.name}区域内的` : '全图'}${selectedTarget}；没有可见目标时继续搜索／观察` }] }
  }
  const { selected: members } = selectUnitSet(ctx, params, catalog, context.game, { armed: true, ...(formation ? { formationId: formation, pendingIds } : {}) })
  const unobservable = ctx.runtime.unobservableMembers(formation).filter(member => params.unitIds ? params.unitIds.includes(member.id)
    : catalog.all.some(item=>item.name===member.name && matchesFutureMember(item,params.selector,catalog)))
    .slice(0,params.quantity==='all'?undefined:Math.max(0,params.quantity-members.length))
  const sourceNames=sources.flatMap(goal=>{
    const source=goal.spec
    if(source.kind==='production')return [source.target]
    if(source.kind!=='formation'||source.request.kind==='dissolveFormation')return []
    const requested=new Set(source.request.unitIds)
    return ctx.runtime.snapshot!.self.filter(unit=>requested.has(unit.id)&&matchesSelector(unit,params.selector,ctx,catalog,context.game)).map(unit=>unit.name)
  })
  const names = formation && sourceIds.length && !params.unitIds ? [...new Set([...members.map(unit=>unit.name),...unobservable.map(unit=>unit.name),...sourceNames])] : []
  const prepared = !!names.length && (params.quantity === 'all' || members.length + unobservable.length < params.quantity)
  const awaitingIds = members.filter(unit => ctx.formations.ownerOf(unit.id) !== formation || ctx.runtime.handoffs.some(handoff => handoff.unitIds.includes(unit.id))).map(unit => unit.id)
  const preparationGoalIds = prepared ? sourceIds : sources.filter(goal => goal.spec.kind === 'formation' && goal.spec.request.kind !== 'dissolveFormation'
    ? goal.spec.request.unitIds.some(id => awaitingIds.includes(id)) : ctx.runtime.production.some(record => record.goalId === goal.spec.id && record.observedIds.some(id => awaitingIds.includes(id)))).map(goal => goal.spec.id)
  if (!members.length && !unobservable.length && !prepared) throw new Error('没有匹配的现有作战单位，未新建编队或追加生产')
  const groups = new Map<string, number[]>()
  for (const unit of members) {
    const owner = formation ?? ctx.runtime.plannedFormationOf(unit.id) ?? ''
    groups.set(owner, [...(groups.get(owner) ?? []), unit.id])
  }
  for (const member of unobservable) {
    const owner=formation ?? ctx.formations.ownerOf(member.id) ?? ''
    groups.set(owner,[...(groups.get(owner) ?? []),member.id])
  }
  if (prepared && !groups.has(formation!)) groups.set(formation!, [])
  const goals = await releaseGlobalOrders(ctx, groups.get('') ?? [])
  const ammoCapacity = Object.fromEntries(catalog.all.filter(item => item.type === 1).map(item => [item.name, item.ammo ?? 1]))
  context.check()
  for (const [formationId, unitIds] of groups) {
    if (formationId) { await ctx.runtime.clearLostCover(formationId); context.check() }
    const aircraftIds = members.filter(unit => unitIds.includes(unit.id) && unit.type === 1).map(unit => unit.id)
    const goal: AttackGoal = { id: id(), kind: 'attack', rawText: context.text, unitIds, aircraftIds, ammoCapacity, preparationGoalIds, objective:{...objective,coordination:params.splitTargets||!formationId?'independent':'focus'}, temporaryAbsenceNames,
      memberNames:Object.fromEntries([...members,...unobservable].filter(member=>unitIds.includes(member.id)).map(member=>[member.id,member.name])),
      executionMode: 'native',
      membership: prepared ? { kind: 'prepared', goalIds: sourceIds, names, ...(params.quantity !== 'all' ? { limit: params.quantity } : {}) } : { kind: 'selected' },
      targetKind: params.target, targetNames, ...(formationId ? { formationId } : {}), ...(params.targetId !== undefined ? { targetId: params.targetId } : {}), ...(region ? { targetRegion: objective.target.region! } : {}) }
    const target = params.targetId !== undefined ? `敌人#${params.targetId}` : targetLabel ?? ({ enemies: '敌人', base: '敌方基地', units: '敌方单位', buildings: '敌方建筑' }[params.target])
    goals.push({ goal: normalizeAttackGoal(goal), choice: `${formationId ? `${formationId}中选定成员` : `${unitIds.length}个现有单位`}攻击${region ? `${region.name}内的` : ''}${params.targetDomain === 'air' ? '空中' : params.targetDomain === 'ground' ? '地面' : ''}${target}${aircraftIds.length || prepared && names.some(name => catalog.all.some(item => item.name === name && item.type === 1)) ? '；飞机满弹后各出击一次，以实际发射确认完成' : ''}${unobservable.some(member=>unitIds.includes(member.id))?'；暂时离场成员重现后按新目标执行':''}（保留归属，不新建编队）` })
  }
  return { goals, ...(params.quantity !== 'all' && members.length + unobservable.length < params.quantity && !prepared ? { skipped: [`现有匹配成员仅${members.length + unobservable.length}个，先执行这些成员`] } : {}) }
}
export function bindAttack(params: AttackParams, context: BindingContext): Promise<BoundCapability> { return bindOrder({ params, search: params.regionName ? 'region' : 'visible', wholeFormation: false }, context) }
export function bindClearRegion(params: ResolvedCapabilityParameters['combat.clear-region'], context: BindingContext): Promise<BoundCapability> {
  return bindOrder({ params: { ...params, selector: 'combat', target: 'enemies', quantity: 'all' }, search: 'region', wholeFormation: true }, context)
}
export async function bindAttackAll(params: ResolvedCapabilityParameters['combat.attack-all'], context: BindingContext): Promise<BoundCapability> {
  if (params.selector || params.unitIds) return bindOrder({ params: { ...params, selector: params.selector ?? 'combat', target: 'enemies', quantity: 'all' }, search: 'map', wholeFormation: false }, context)
  const { ctx } = context
  const formations = params.formationId ? [formationName(ctx, params.formationId, false, true)] : ctx.formations.list().filter(formation => ctx.runtime.snapshot!.self.some(unit => formation.memberIds.includes(unit.id) && (unit.primaryWeapon || unit.secondaryWeapon))).map(formation => formation.id)
  if (!formations.length) throw new Error('没有可用作战编队')
  const goals: NonNullable<BoundCapability['goals']> = []
  for (const formationId of formations) goals.push(...(await bindOrder({ params: { formationId, selector: 'combat', target: 'enemies', quantity: 'all', targetDomain: params.targetDomain, splitTargets:params.splitTargets, ...(params.targetSelectors ? { targetSelectors: params.targetSelectors } : {}) }, search: 'map', wholeFormation: true }, context)).goals ?? [])
  return { goals }
}
