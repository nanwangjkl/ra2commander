import { randomUUID } from 'node:crypto'
import type { ResolvedCapabilityParameters } from '@ra2c/command'
import type { AttackGoal, SnapshotUnit } from '@ra2c/contracts'
import type { BindingContext, BoundCapability } from './capabilities/bindings.ts'
import { formationName, regionDestination, selectUnits } from './capabilities/selectors.ts'
import { releaseGlobalOrders } from './mining.ts'

export async function bindAttack(params: ResolvedCapabilityParameters['combat.attack'], context: BindingContext): Promise<BoundCapability> {
  const { ctx } = context, catalog = await context.catalog()
  const formation = params.formationId ? formationName(ctx, params.formationId, false, true) : undefined
  const planned = formation ? context.formationGoals.get(formation) : undefined
  const plannedIds = planned && planned.request.kind !== 'dissolveFormation' ? planned.request.unitIds : []
  const selected = selectUnits(ctx, params, catalog).filter(unit => !!(unit.primaryWeapon || unit.secondaryWeapon)
    && (!formation || ctx.formations.ownerOf(unit.id) === formation || plannedIds.includes(unit.id)))
  const members = params.quantity === 'all' ? selected : selected.slice(0, params.quantity)
  const preparationGoalIds = formation ? [...ctx.runtime.goals.values()].filter(goal => ['pending', 'active'].includes(goal.status) && (
    goal.spec.kind === 'production' && goal.spec.formationId === formation || goal.spec.kind === 'formation' && goal.spec.request.formationId === formation)).map(goal => goal.spec.id) : []
  const dynamic = !!formation && !members.length && ctx.runtime.hasPlannedFormation(formation)
  if (!members.length && !dynamic) throw new Error('没有匹配的现有作战单位，未新建编队或追加生产')
  const groups = new Map<string, number[]>()
  for (const unit of members) {
    const owner = formation ?? ctx.formations.ownerOf(unit.id) ?? ''
    groups.set(owner, [...(groups.get(owner) ?? []), unit.id])
  }
  if (dynamic) groups.set(formation!, [])
  const region = params.regionName ? (await regionDestination(ctx, params.regionName, context.check)).region : undefined
  const goals = await releaseGlobalOrders(ctx, groups.get('') ?? [])
  const ammoCapacity = Object.fromEntries(catalog.all.filter(item => item.type === 1).map(item => [item.name, item.ammo ?? 1]))
  const targetNames = catalog.all.filter(item => catalog.isRole(item.name, 'constructionYard', item.type) || catalog.isRole(item.name, 'constructionVehicle', item.type)).map(item => item.name)
  const eligibleNames = dynamic ? catalog.all.filter(item => {
    if (![1, 3, 7].includes(item.type)) return false
    if (['combat', 'all'].includes(params.selector)) return !item.roles.some(role => ['harvester', 'engineer', 'constructionVehicle'].includes(role))
    if (['aircraft', '飞机', '空军'].includes(params.selector)) return item.type === 1
    if (['infantry', '步兵'].includes(params.selector)) return item.type === 3
    if (['vehicles', '车辆'].includes(params.selector)) return item.type === 7
    return catalog.matchesUnit({ id: 0, name: item.name, type: item.type, rx: 0, ry: 0, isIdle: true } as SnapshotUnit, params.selector)
  }).map(item => item.name) : undefined
  context.check()
  for (const [formationId, unitIds] of groups) {
    const aircraftIds = members.filter(unit => unitIds.includes(unit.id) && unit.type === 1).map(unit => unit.id)
    const goal: AttackGoal = { id: `command-${randomUUID().slice(0, 8)}`, kind: 'attack', rawText: context.text, unitIds, aircraftIds, ammoCapacity, preparationGoalIds,
      targetKind: params.target, targetNames, ...(formationId ? { formationId } : {}), ...(eligibleNames ? { dynamicNames: eligibleNames } : {}),
      ...(params.targetId !== undefined ? { targetId: params.targetId } : {}), ...(region ? { targetRegion: { id: region.id, name: region.name, polygons: structuredClone(region.polygons) } } : {}) }
    const target = params.targetId !== undefined ? `敌人#${params.targetId}` : ({ enemies: '敌人', base: '敌方基地', units: '敌方单位', buildings: '敌方建筑' }[params.target])
    goals.push({ goal, choice: `${formationId ? `${formationId}中选定成员` : `${unitIds.length}个现有单位`}攻击${region ? `${region.name}内的` : ''}${target}${aircraftIds.length || dynamic && params.selector === 'aircraft' ? '；飞机满弹后各出击一次，以实际发射确认完成' : ''}（保留归属，不新建编队）` })
  }
  return { goals, ...(params.quantity !== 'all' && members.length < params.quantity && !dynamic ? { skipped: [`现有匹配成员仅${members.length}个，先执行这些成员`] } : {}) }
}
