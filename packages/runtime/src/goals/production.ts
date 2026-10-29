import { validBuildingPlacement, validTargetRegion } from '@ra2c/contracts'
import type { GoalConstraints, GoalView } from '@ra2c/contracts'
import { productionProgress } from '../production-progress.ts'
import { pendingProduction } from '../production-cancellation.ts'
import { alive as living, baseConstraints, projection, stringsValid } from './common.ts'
import type { GoalContext, GoalHandler } from './types.ts'

function constraintsFor(ctx: GoalContext<'production'>, observed: ReturnType<typeof productionProgress>): GoalConstraints {
  const { spec, goal, snap, production, formations, pausedQueues } = ctx
  const base = baseConstraints(ctx), alive = (ids: number[]) => living(ctx, ids)
  if (spec.afterGoalId) {
    const dependency = ctx.goals.get(spec.afterGoalId)
    if (dependency?.status !== 'completed') return { ...base, allowedProduce: [], allowedPlace: [], produceRemaining: {}, blocked: `等待基地搬迁完成${dependency && ['failed', 'partial', 'cancelled'].includes(dependency.status) ? `（搬迁已${dependency.status === 'cancelled' ? '取消' : '失败'}，未在旧址建造）` : dependency ? '' : '（搬迁目标尚未绑定）'}` }
  }
  const desired = goal.spec
  // 减少产量属于立即收紧；增量仍需等候新代码激活。
  const quantity = desired?.kind === 'production' ? Math.min(spec.quantity, desired.quantity) : spec.quantity
  const progress = quantity === spec.quantity ? observed : productionProgress({ ...spec, quantity }, production, snap)
  const pendingBuildings = production.filter(r => r.building && !r.placed && pendingProduction(r) > 0 && !ctx.goals.get(r.goalId)?.facts.cancelProduction)
  const allowedPlace = pendingBuildings.filter(r => r.name === spec.target ? r.goalId === spec.id : spec.prerequisites.includes(r.name)).map(r => r.name)
  const placements: NonNullable<GoalConstraints['placements']> = {}
  const placementRegions: NonNullable<GoalConstraints['placementRegions']> = {}
  if (spec.placementRegion) placementRegions[spec.target] = spec.placementRegion
  for (const name of allowedPlace) {
    const record = pendingBuildings.find(r => r.name === name && (name === spec.target ? r.goalId === spec.id : spec.prerequisites.includes(name)))
    if (record?.placementRegion) placementRegions[name] = record.placementRegion
    const direction = record?.placement?.directions[record.observedIds.length]
    if (record?.placement && direction) placements[name] = { id: `${record.id}:${record.observedIds.length}`, anchor: record.placement.anchor, direction }
  }
  const productionQueueTypes = { ...Object.fromEntries(spec.prerequisites.map(name => [name, 0])), [spec.target]: spec.targetType === 2 ? 0 : spec.targetType === 3 ? 2 : spec.targetType === 1 ? 4 : 3, ...spec.queueTypes }
  const queueSpace: Record<number, number> = {}
  for (const queue of snap.production?.queues ?? []) {
    const pending = production.filter(r => (r.queueType ?? (r.building ? 0 : 3)) === queue.type).reduce((n, r) => n + pendingProduction(r), 0)
    queueSpace[queue.type] = Math.max(0, queue.maxSize - Math.max(queue.size, pending))
  }
  const members = spec.formationId ? alive(progress.observed[spec.target] ?? []).filter(id => !formations.ownerOf(id)) : []
  const exists = spec.formationId && formations.list().some(f => f.id === spec.formationId)
  return { ...base, allowedProduce: [...spec.prerequisites, spec.target], allowedPlace, placements, placementRegions, productionQueueTypes, queueSpace, produceRemaining: progress.remaining, allowedQueueTypes: spec.queues, resumableQueueTypes: [...pausedQueues].filter(([, id]) => id === spec.id).map(([q]) => q),
    ...(spec.formationId ? { management: { kind: exists ? 'transferUnits' as const : 'createFormation' as const, formationId: spec.formationId, allowedUnitIds: members, maxUnits: members.length } } : {}) }
}

const readyBuildings = (constraints: GoalConstraints, snap: GoalContext<'production'>['snap']) =>
  [...new Set(constraints.allowedPlace ?? [])].filter(name => snap.production?.queues.some(queue => queue.status === 3 && queue.items.some(item => item.name === name)))

export const production: GoalHandler<'production'> = {
  validateSpec(spec, map) {
    if (spec.placementRegion && ((spec.targetType !== undefined && spec.targetType !== 2) || !validTargetRegion(spec.placementRegion))) throw new Error('建筑分区要求非法')
    if (spec.afterGoalId === spec.id) throw new Error('建造依赖必须指向基地搬迁目标')
    if (spec.placement && ((spec.targetType !== undefined && spec.targetType !== 2) || !validBuildingPlacement(spec.placement, map.mapWidth, map.mapHeight))) throw new Error('建筑方位要求非法或生产目标不是建筑')
    if (!/^[A-Za-z0-9_]+$/.test(spec.target) || !Number.isSafeInteger(spec.quantity) || spec.quantity < 1 || !stringsValid(spec.prerequisites) || !Array.isArray(spec.queues) || spec.queues.some(q => !Number.isInteger(q) || q < 0 || q > 5)) throw new Error('生产目标非法')
    if (spec.maintainPower && (!Number.isFinite(spec.maintainPower.reserve) || spec.maintainPower.reserve < 0 || !Number.isFinite(spec.maintainPower.output) || spec.maintainPower.output <= 0)) throw new Error('补电参数非法')
  },
  validateLive({ spec, goals }) { if (spec.afterGoalId && goals.has(spec.afterGoalId) && goals.get(spec.afterGoalId)?.spec.kind !== 'relocate') throw new Error('建造依赖必须指向基地搬迁目标') },
  requiredActions(ctx) {
    const constraints = constraintsFor(ctx, productionProgress(ctx.spec, ctx.production, ctx.snap))
    return readyBuildings(constraints, ctx.snap).map(name => ({ kind: 'place' as const, name }))
  },
  observe(ctx) {
    const { spec, snap, goal } = ctx
    const progress = productionProgress(spec, ctx.production, snap)
    const assigned = (progress.observed[spec.target] ?? []).filter(id => snap.self.some(u => u.id === id)).every(id => !ctx.locked(id) && (!spec.formationId || ctx.formations.ownerOf(id) === spec.formationId))
    if (!spec.maintainPower && assigned && (progress.observed[spec.target]?.length ?? 0) >= spec.quantity && !progress.uncertain.includes(spec.target)) {
      if (progress.placement && progress.placement.completed < spec.quantity) {
        goal.status = 'partial'; goal.facts.outcomeDetail = `已生产${spec.quantity}座，按指定${spec.placementRegion ? '分区及位置' : '方位'}建成${progress.placement.completed}座；位置未达标的建筑：${progress.placement.mismatchedIds.join('、') || '尚未确认'}，未额外补造`
      } else goal.status = 'completed'
    }
  },
  project(ctx) {
    const { spec, goal: { facts }, snap, production } = ctx
    const progress = productionProgress(spec, production, snap), constraints = constraintsFor(ctx, progress)
    const view: Partial<GoalView> = { submitted: progress.sent, observed: progress.observed, uncertain: progress.uncertain }
    const missingPrerequisites = snap.production?.available.includes(spec.target) ? [] : spec.prerequisites.filter(name => !snap.self.some(unit => unit.type === 2 && unit.name === name))
    view.productionPlan = {
      missingPrerequisites,
      unmetConditions: snap.production?.available.includes(spec.target) ? [] : (spec.unlockConditions ?? []).filter(condition => !condition.requiresExisting || !snap.self.some(unit => unit.type === 2 && unit.name === condition.name)),
      pendingPrerequisites: missingPrerequisites.filter(name => (progress.sent[name] ?? 0) > (progress.observed[name]?.length ?? 0)),
      pendingRallyIds: (progress.observed[spec.target] ?? []).filter(id => snap.self.some(unit => unit.id === id) && ctx.locked(id)),
      availableToProduce: (constraints.allowedProduce ?? []).filter(name => (constraints.produceRemaining?.[name] ?? 0) > 0 && snap.production?.available.includes(name) && (constraints.queueSpace?.[constraints.productionQueueTypes?.[name] ?? 0] ?? 1) > 0),
      ...(progress.placement ? { placement: { ...progress.placement, ...(constraints.placements?.[spec.target] ? { next: constraints.placements[spec.target] } : {}) } } : {}),
      readyToPlace: readyBuildings(constraints, snap),
    }
    if (spec.unlockConditions !== undefined && !snap.production?.available.includes(spec.target) && !missingPrerequisites.length && !view.productionPlan.unmetConditions?.length && (constraints.produceRemaining?.[spec.target] ?? 0) > 0 && !view.productionPlan.availableToProduce.length && !view.productionPlan.readyToPlace.length) view.productionPlan.unmetConditions = [{ name: spec.target, reason: `${spec.target} 前置建筑已齐，但游戏当前未开放生产，等待生产设施或科技条件变化` }]

    if (progress.blocked) view.blocked = progress.blocked
    else if (!facts.placementBlocked && facts.blocked) view.blocked = facts.blocked
    return projection(ctx, constraints, view)
  },
  continuous: ({ spec }) => !!spec.maintainPower,
  execution(ctx, { view }) {
    const pending = view.productionPlan?.pendingRallyIds ?? []
    if (pending.length) return { state: 'pending', detail: `已生产${view.observed[ctx.spec.target]?.length ?? 0}个，其中${pending.length}个等待抵达集结点及交接；不补造、不提前停车`, progress: { completed: view.observed[ctx.spec.target]?.length ?? 0, total: ctx.spec.quantity, label: '已生产，等待集结交接' } }
  },
  progress({ spec, goal }, view) {
    if (['completed', 'partial', 'failed'].includes(goal.status)) return {}
    return !spec.maintainPower ? { progress: { completed: Math.min(spec.quantity, view.productionPlan?.placement?.completed ?? view.observed[spec.target]?.length ?? 0), total: spec.quantity, ...(spec.placementRegion ? { label: '按指定分区及位置建成' } : spec.placement ? { label: '按指定方位建成' } : {}) } } : {}
  },
}
