import { randomUUID } from 'node:crypto'
import type { ResolvedCapabilityParameters } from '@ra2c/command'
import type { MiningGoal } from '@ra2c/contracts'
import { initialMining, miningBatch, observeOre } from '@ra2c/runtime'
import type { CommandContext } from './commands.ts'
import type { BindingContext, BoundCapability } from './capabilities/bindings.ts'
import { formationName, regionDestination, selectUnitSet } from './capabilities/selectors.ts'
import { fixedGoalExecutionMode } from './execution-modes.ts'

/** 新命令接管所选未编队成员，其余成员保留原目标及原卡片的进度。 */
export async function releaseGlobalOrders(ctx: CommandContext, ids: number[]): Promise<NonNullable<BoundCapability['goals']>> {
  const edits: NonNullable<BoundCapability['goals']> = []
  for (const goal of ctx.runtime.goals.values()) {
    const spec = goal.spec
    if (spec.kind === 'relocate' && ['pending', 'active'].includes(goal.status) && ids.includes(goal.facts.relocation?.unitId ?? spec.unitId)) {
      await ctx.runtime.cancelGoal(spec.id, '所选单位已由新命令接管')
      continue
    }
    if (goal.ownerId !== 'global' || !['pending', 'active'].includes(goal.status) || (spec.kind !== 'mining' && spec.kind !== 'rally' && spec.kind !== 'attack' && spec.kind !== 'building') || !spec.unitIds.some(id => ids.includes(id))) continue
    const remaining = spec.unitIds.filter(id => !ids.includes(id))
    if (remaining.length) edits.push({ goal: { ...spec, unitIds: remaining, ...(spec.kind === 'attack' ? { aircraftIds: spec.aircraftIds.filter(id => remaining.includes(id)) } : {}) }, choice: `保留其余${remaining.length}个对象的原${spec.kind === 'mining' ? '采矿' : spec.kind === 'attack' ? '攻击' : spec.kind === 'building' ? '建筑操作' : '集结'}目标` })
    else await ctx.runtime.cancelGoal(spec.id, '所选单位已由新命令接管')
  }
  return edits
}

export async function bindMining(params: ResolvedCapabilityParameters['economy.gather'], context: BindingContext): Promise<BoundCapability> {
  const catalog = await context.catalog(), { region, destination } = await regionDestination(context.ctx, params.regionName, context.check)
  const formation = params.formationId ? formationName(context.ctx, params.formationId) : undefined
  const { selected } = selectUnitSet(context.ctx, { ...params, selector: 'harvester' }, catalog, context.game, { ...(formation ? { formationId: formation } : {}), eligible: unit => catalog.isRole(unit.name, 'harvester', unit.type) })
  if (!selected.length) throw new Error('没有匹配的现有矿车，未追加生产')
  const groups = new Map<string, number[]>()
  for (const unit of selected) {
    const owner = context.ctx.formations.ownerOf(unit.id) ?? ''
    groups.set(owner, [...(groups.get(owner) ?? []), unit.id])
  }
  const goals = await releaseGlobalOrders(context.ctx, groups.get('') ?? [])
  context.check()
  for (const [formationId, unitIds] of groups) {
    const goal: MiningGoal = { id: `command-${randomUUID().slice(0, 8)}`, kind: 'mining', executionMode: fixedGoalExecutionMode('mining'), rawText: context.text, unitIds, ...(formationId ? { formationId } : {}),
      targetRegion: { id: region.id, name: region.name, polygons: structuredClone(region.polygons) }, destination: { x: destination.x, y: destination.y } }
    goals.push({ goal, choice: `让${formationId ? `${formationId}的` : ''}${unitIds.length}辆现有矿车持续采集${region.name}区内已知矿格（不区分矿种、不新增生产）` })
  }
  return { goals, ...(params.quantity !== 'all' && selected.length < params.quantity ? { skipped: [`仅有${selected.length}辆匹配矿车，先使用现有成员采矿`] } : {}) }
}

/** 有界、低频的公开格子读取；只更新事实，所选执行器负责发令。 */
export class MiningObserver {
  private busy = false
  private next = 0
  async poll(ctx: Pick<CommandContext, 'runtime' | 'bridge'>): Promise<void> {
    const { runtime } = ctx, snap = runtime.snapshot
    if (this.busy || !snap) return
    const goals = [...runtime.goals.values()].filter(goal => goal.status === 'active' && !goal.facts.nativeError && goal.activeSpec?.kind === 'mining' && runtime.programs.get(goal.ownerId)?.status === 'active'
      && (!goal.facts.mining?.oreCells.length || goal.facts.mining.observedAt === undefined || snap.tick - goal.facts.mining.observedAt >= 30))
    if (!goals.length) return
    const goal = goals[this.next++ % goals.length]!, spec = goal.activeSpec as MiningGoal
    const ids = spec.unitIds.filter(id => (runtime.formations.ownerOf(id) ?? undefined) === spec.formationId)
    this.busy = true
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const batch = miningBatch(spec, snap, goal.facts.mining ?? initialMining(), ids)
        const observation = await ctx.bridge.readMapBatch(batch.cells, snap.mapWidth, snap.sessionKey)
        if (!Array.isArray(observation.ore)) throw new Error('当前页面桥尚未提供矿格观察，请重启 Companion')
        if (runtime.battleKey !== snap.sessionKey || runtime.goals.get(spec.id) !== goal || goal.status !== 'active' || runtime.programs.get(goal.ownerId)?.status !== 'active') return
        observeOre(goal.facts.mining ??= initialMining(), spec, snap.mapWidth, { seen: observation.seen, ore: observation.ore }, batch, snap.tick)
        if (goal.facts.mining.oreCells.length || goal.facts.mining.passes > 0) break
      }
    } finally { this.busy = false }
  }
}
