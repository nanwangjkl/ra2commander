import { randomUUID } from 'node:crypto'
import { inTargetRegion, type RelocateGoal } from '@ra2c/contracts'
import type { ResolvedCapabilityParameters } from '@ra2c/command'
import type { BindingContext, BoundCapability } from './capabilities/bindings.ts'
import { checkPoint, normalizeName, regionDestination } from './capabilities/selectors.ts'
import { fixedGoalExecutionMode } from './execution-modes.ts'
import { releaseGlobalOrders } from './mining.ts'

export const relocationKey = (params: { regionName?: string; x?: number; y?: number }) => params.regionName ? normalizeName(params.regionName) : `${params.x},${params.y}`

export async function bindRelocation(params: ResolvedCapabilityParameters['base.relocate'], context: BindingContext): Promise<BoundCapability> {
  const { ctx } = context
  const catalog = await context.catalog()
  const resolved = params.regionName ? await regionDestination(ctx, params.regionName, context.check) : undefined
  const target: { x: number; y: number; name?: string } = resolved?.destination ?? { x: params.x!, y: params.y! }
  checkPoint(ctx.runtime.snapshot!, target.x, target.y)
  const snap = ctx.runtime.snapshot!
  const selected = snap.self.filter(unit => (params.unitId === undefined || unit.id === params.unitId) && !ctx.formations.ownerOf(unit.id)
    && (catalog.isRole(unit.name, 'constructionVehicle', unit.type) || catalog.isRole(unit.name, 'constructionYard', unit.type)))
    .sort((a, b) => Number(b.type === 7) - Number(a.type === 7) || Number(b.isIdle) - Number(a.isIdle) || a.id - b.id)[0]
  if (!selected) throw new Error('没有可搬迁的未编队建造厂或基地车')
  const rule = catalog.all.find(item => item.name === selected.name)!
  const vehicleName = selected.type === 7 ? selected.name : rule.undeploysInto
  const yardName = selected.type === 2 ? selected.name : rule.deploysInto
  if (!vehicleName || !yardName) throw new Error('当前基地规则不支持收起或展开')
  const key = relocationKey(params)
  const goalId = context.relocationIds.get(key) ?? `command-${randomUUID().slice(0, 8)}`
  context.relocationIds.set(key, goalId)
  for (const goal of ctx.runtime.goals.values()) if (goal.spec.kind === 'relocate' && !['cancelled', 'completed', 'failed', 'partial'].includes(goal.status)
    && (goal.spec.unitId === selected.id || goal.facts.relocation?.unitId === selected.id)) await ctx.runtime.cancelGoal(goal.spec.id, '已被新的基地搬迁命令替换')
  const region = resolved ? { id: resolved.region.id, name: resolved.region.name, polygons: structuredClone(resolved.region.polygons) } : undefined
  const candidates: Array<{ x: number; y: number }> = []
  for (const radius of [0, 4, 8, 12]) for (const [dx, dy] of radius ? [[-radius, 0], [radius, 0], [0, -radius], [0, radius], [-radius, -radius], [radius, radius], [-radius, radius], [radius, -radius]] : [[0, 0]]) {
    const point = { x: target.x + dx!, y: target.y + dy! }
    if (point.x < 0 || point.y < 0 || point.x >= snap.mapWidth || point.y >= snap.mapHeight || region && ![-1, 0, 1].every(x => [-1, 0, 1].every(y => inTargetRegion(point.x + x, point.y + y, region)))) continue
    candidates.push(point)
  }
  if (!candidates.length) throw new Error('目标区域没有基地搬迁候选落点')
  const goals = await releaseGlobalOrders(ctx, [selected.id])
  context.check()
  const goal: RelocateGoal = { id: goalId, kind: 'relocate', executionMode: fixedGoalExecutionMode('relocate'), rawText: context.text, unitId: selected.id, origin: { x: selected.rx, y: selected.ry }, vehicleName, yardName,
    destination: target, candidates, ...(region ? { targetRegion: region } : {}) }
  return { goals: [...goals, { goal, choice: `将基地 #${selected.id} 搬至${target.name ?? `${target.x},${target.y}`}，收起、移动后重新展开` }] }
}
