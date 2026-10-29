import { randomUUID } from 'node:crypto'
import type { ResolvedCapabilityParameters } from '@ra2c/command'
import type { UnitDeploymentGoal } from '@ra2c/contracts'
import type { BindingContext, BoundCapability } from './capabilities/bindings.ts'
import { destination, formationName, regionDestination, selectUnitSet } from './capabilities/selectors.ts'
import { matchesFutureMember } from './unit-selection.ts'
import { releaseGlobalOrders } from './mining.ts'

export async function bindUnitDeployment(params: ResolvedCapabilityParameters['unit.deploy'], context: BindingContext): Promise<BoundCapability> {
  const { ctx } = context, catalog = await context.catalog()
  const formation = params.formationId ? formationName(ctx, params.formationId, false, true) : undefined
  const eligible = (name: string) => catalog.all.some(item => item.name === name && item.deployer && !item.deploysInto)
  const matched = (context.producedGoals ?? []).filter(goal => (!formation || goal.formationId === formation) && eligible(goal.target) && matchesFutureMember(catalog.all.find(item => item.name === goal.target)!, params.selector, catalog))
  const sources = params.source !== 'existing' && !params.unitIds ? matched : []
  if (params.source === 'production' && !sources.length) throw new Error('本句没有匹配的可部署单位生产目标，未创建虚构编队或重复生产')
  const pendingIds = [...ctx.runtime.goals.values()].flatMap(goal => goal.spec.kind === 'formation' && goal.spec.request.kind !== 'dissolveFormation' && goal.spec.request.formationId === formation ? goal.spec.request.unitIds : [])
  const { matched: matches, selected } = selectUnitSet(ctx, params, catalog, context.game, { ...(formation ? { formationId: formation, pendingIds } : {}), eligible: unit => eligible(unit.name) && unit.canDeploy === true && typeof unit.isDeployed === 'boolean' })
  const groups = new Map<string, { ids: number[]; sources: UnitDeploymentGoal['sources'] }>()
  let limit = params.quantity === 'all' ? Infinity : params.quantity
  if (sources.length) {
    for (const source of sources) {
      const quantity = Math.min(source.quantity, limit)
      if (quantity <= 0) break
      const owner = source.formationId ?? ''
      const group = groups.get(owner) ?? { ids: [], sources: [] }
      group.sources.push({ goalId: source.id, name: source.target, quantity }); groups.set(owner, group); limit -= quantity
    }
  } else for (const unit of selected) {
    const owner = formation ?? ctx.runtime.plannedFormationOf(unit.id) ?? ''
    const group = groups.get(owner) ?? { ids: [], sources: [] }
    group.ids.push(unit.id); groups.set(owner, group)
  }
  if (!groups.size) return { choices: ['当前没有匹配的常规可部署单位（不包含基地车和灰熊变建筑）'], ...(matches.length ? { skipped: ['所选成员没有本轮支持的部署姿态'] } : {}) }
  const target = params.regionName ? await regionDestination(ctx, params.regionName, context.check) : undefined
  const point: UnitDeploymentGoal['destination'] = target?.destination ?? (params.x !== undefined || params.y !== undefined ? await destination(ctx, params, context.check, catalog) : undefined)
  const goals: NonNullable<BoundCapability['goals']> = await releaseGlobalOrders(ctx, groups.get('')?.ids ?? [])
  context.check()
  for (const [formationId, group] of groups) {
    const total = group.ids.length + group.sources.reduce((n, source) => n + source.quantity, 0)
    const transientNames = catalog.all.filter(item => item.deployer && (item.undeployDelay ?? 0) > 0).map(item => item.name)
    const goal: UnitDeploymentGoal = { id: `command-${randomUUID().slice(0, 8)}`, kind: 'unitDeploy', executionMode: 'native', rawText: context.text,
      unitIds: group.ids, sources: group.sources, deployed: params.deployed, transientNames,
      ...(formationId ? { formationId } : {}), ...(point ? { destination: point } : {}), ...(target ? { targetRegion: { id: target.region.id, name: target.region.name, polygons: structuredClone(target.region.polygons) } } : {}) }
    goals.push({ goal, choice: `${formationId ? `${formationId}中` : ''}${group.sources.length ? '本次新造' : '现有'}${total}个可部署成员${point ? `前往${point.name ?? `(${point.x},${point.y})`}后` : '原地'}${params.deployed ? '部署' : '解除部署'}，以实际姿态确认完成` })
  }
  const count = [...groups.values()].reduce((n, group) => n + group.ids.length + group.sources.reduce((sum, source) => sum + source.quantity, 0), 0)
  return { goals, ...(params.quantity !== 'all' && count < params.quantity ? { skipped: [`仅有${count}个匹配的部署成员或明确生产份额，先执行这些成员`] } : {}) }
}
