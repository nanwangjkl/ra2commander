import { randomUUID } from 'node:crypto'
import type { ResolvedCapabilityParameters } from '@ra2c/command'
import type { BuildingGoal } from '@ra2c/contracts'
import type { BindingContext, BoundCapability } from './capabilities/bindings.ts'
import { releaseGlobalOrders } from './mining.ts'

export async function bindBuildingOperation(operation: BuildingGoal['operation'], params: ResolvedCapabilityParameters['building.repair'], context: BindingContext): Promise<BoundCapability> {
  const { ctx } = context, catalog = await context.catalog()
  const selector = params.selector.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  const matches = ctx.runtime.snapshot!.self.filter(unit => unit.type === 2 && (params.unitIds ? params.unitIds.includes(unit.id)
    : ['all', '全部', '所有', '所有建筑', '全部建筑', '建筑', 'buildings'].includes(selector) || catalog.matchesUnit(unit, selector)))
    .filter(unit => operation === 'sell' || unit.hitPoints! > 0 && unit.hitPoints! < unit.maxHitPoints!)
    .sort((a, b) => a.id - b.id)
  const eligible = matches.filter(unit => operation !== 'sell' || catalog.all.find(item => item.name === unit.name)?.unsellable !== true)
  const selected = params.quantity === 'all' ? eligible : eligible.slice(0, params.quantity)
  const skipped = matches.filter(unit => !eligible.includes(unit)).map(unit => `${unit.name} #${unit.id}规则禁止出售，已跳过`)
  if (!selected.length) return { choices: [operation === 'repair' ? '当前没有匹配的受损己方建筑' : '当前没有匹配的可出售己方建筑'], ...(skipped.length ? { skipped } : {}) }
  if (params.quantity !== 'all' && selected.length < params.quantity) skipped.push(`仅有${selected.length}座符合条件的建筑，先执行这些建筑`)
  const unitIds = selected.map(unit => unit.id), goals = await releaseGlobalOrders(ctx, unitIds)
  context.check()
  const goal: BuildingGoal = { id: `command-${randomUUID().slice(0, 8)}`, kind: 'building', operation, unitIds, rawText: context.text }
  goals.push({ goal, choice: `${operation === 'repair' ? '开启原生扳手维修' : '出售'}${unitIds.length}座现有己方${operation === 'repair' ? '受损' : ''}建筑（${selected.map(unit => `${unit.name} #${unit.id}`).join('、')}）` })
  return { goals, ...(skipped.length ? { skipped } : {}) }
}
