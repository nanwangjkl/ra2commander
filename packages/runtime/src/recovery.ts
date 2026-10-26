import type { GoalConstraints, GoalView, Snapshot } from '@ra2c/contracts'

interface Observation { signature: string; since: number; lastTick: number; eligible: boolean; reason: string }
interface Trace { tick: number; detail: unknown; repeats: number }
interface OwnerHistory { key: string; goals: Map<string, Observation>; recent: Trace[]; lastDiagnosis: number }

/** 只观察游戏事实；动作被接受不等于目标已有进展。时间使用游戏 tick，暂停游戏不会耗尽等待期。 */
export class RecoveryMonitor {
  private owners = new Map<string, OwnerHistory>()
  constructor(private readonly stallTicks = 900, private readonly cooldownTicks = 900) {}
  clear(): void { this.owners.clear() }
  reset(id: string): void { this.owners.delete(id) }
  trace(id: string, key: string, tick: number, detail: unknown): void {
    const history = this.history(id, key)
    const bounded = JSON.parse(JSON.stringify(detail, (key, value) => Array.isArray(value) ? value.slice(0, key === 'unitIds' ? 16 : 8) : typeof value === 'string' ? value.slice(0, 1000) : value))
    const last = history.recent.at(-1)
    if (last && JSON.stringify(last.detail) === JSON.stringify(bounded)) { last.tick = tick; last.repeats++; return }
    history.recent.push({ tick, detail: bounded, repeats: 1 })
    if (history.recent.length > 20) history.recent.shift()
  }
  context(id: string) {
    const history = this.owners.get(id)
    return history ? structuredClone({ recent: history.recent, progress: [...history.goals].map(([goalId, item]) => ({ goalId, sinceTick: item.since, lastTick: item.lastTick, actionable: item.eligible, reason: item.reason })) }) : { recent: [], progress: [] }
  }
  observe(id: string, key: string, snap: Snapshot, goals: GoalView[], constraints: Record<string, GoalConstraints>, waiting: Set<string>): string | undefined {
    const history = this.history(id, key)
    const active = new Set(goals.map(goal => goal.spec.id))
    for (const id of history.goals.keys()) if (!active.has(id)) history.goals.delete(id)
    const stalled: string[] = []
    for (const goal of goals) {
      const probe = inspectProgress(goal, constraints[goal.spec.id]!, snap, waiting.has(goal.spec.id))
      const previous = history.goals.get(goal.spec.id)
      const since = !previous || !probe.actionable || !previous.eligible || previous.signature !== probe.signature || snap.tick < previous.lastTick ? snap.tick : previous.since
      history.goals.set(goal.spec.id, { signature: probe.signature, since, lastTick: snap.tick, eligible: probe.actionable, reason: probe.reason })
      if (probe.actionable && snap.tick - since >= this.stallTicks) stalled.push(`${goal.spec.id}：${probe.reason}，${snap.tick - since} tick 没有实际进展`)
    }
    if (!stalled.length || snap.tick - history.lastDiagnosis < this.cooldownTicks) return undefined
    history.lastDiagnosis = snap.tick
    return stalled.join('；')
  }
  private history(id: string, key: string): OwnerHistory {
    let history = this.owners.get(id)
    if (!history || history.key !== key) {
      history = { key, goals: new Map(), recent: [], lastDiagnosis: -Infinity }
      this.owners.set(id, history)
    }
    return history
  }
}

function inspectProgress(goal: GoalView, constraints: GoalConstraints, snap: Snapshot, waiting: boolean) {
  const spec = goal.spec
  const members = snap.self.filter(unit => spec.kind === 'relocate' ? unit.id === goal.relocation?.unitId : goal.unitIds.includes(unit.id))
  const units = members.map(unit => [unit.id, Math.round(unit.rx * 2), Math.round(unit.ry * 2), unit.hitPoints, unit.transport?.unitIds])
  let actionable = false, reason = '等待条件变化'
  let facts: unknown = units
  if (spec.kind === 'building') {
    actionable = !!goal.building?.actions.length && !goal.building.pending
    reason = '建筑操作可执行但没有推进'
    facts = [goal.building?.completed, goal.building?.failed, snap.self.filter(unit => spec.unitIds.includes(unit.id)).map(unit => [unit.id, unit.hitPoints, unit.hasWrenchRepair])]
  } else if (spec.kind === 'production') {
    const plan = goal.productionPlan
    const queues = snap.production?.queues ?? []
    const candidates = plan?.availableToProduce.filter(name => queues.find(queue => queue.type === constraints.productionQueueTypes?.[name])?.status !== 2) ?? []
    const placement = !!plan?.readyToPlace.length
    const management = !!constraints.management?.allowedUnitIds.length
    // 缺钱、队列占满/暂停、未决提交、科技限制和交接等待均不启动停滞计时。
    actionable = !waiting && !goal.uncertain.length && (placement || management || (snap.credits > 0 && candidates.length > 0))
    reason = placement ? '建筑已就绪但未放置' : management ? '产物已出现但尚未编队' : '项目可造且队列有空位，但没有推进生产'
    const relevant = new Set([...spec.prerequisites, spec.target])
    facts = [goal.submitted, goal.observed, goal.produceRemaining, units,
      queues.filter(queue => queue.items.some(item => relevant.has(item.name))).map(queue => [queue.type, queue.status, queue.items.map(item => [item.name, item.quantity, Math.round(item.progress * 1000), item.creditsSpent])])]
  } else if (spec.kind === 'formation' || spec.kind === 'reinforce') {
    actionable = !waiting && !!constraints.management?.allowedUnitIds.length && (goal.maxUnits ?? 0) > 0 && !goal.blocked
    reason = '存在可交接成员但编队归属未推进'
  } else if (spec.kind === 'attack') {
    actionable = !!goal.attack?.readyIds.length && !!goal.attack.targets.length
    reason = '有已就绪攻击成员和匹配敌人，但没有实际行动'
    facts = [units, goal.attack?.readyIds, goal.attack?.firedIds, goal.attack?.targets.map(unit => [unit.id, unit.hitPoints])]
  } else if (spec.kind === 'mining') {
    actionable = !!goal.mining?.actions.length
    reason = '已有矿格分配或进区步骤，但未向空闲矿车下达有效指令'
    facts = [units, goal.mining?.assigned, goal.mining?.actions]
  } else if (spec.kind === 'relocate') {
    actionable = !!members.length && !!goal.relocation && !['confirming', 'completed', 'failed'].includes(goal.relocation.phase)
    reason = '基地搬迁阶段未推进'
    facts = [units, goal.relocation?.phase, goal.relocation?.destination]
  } else if (spec.kind === 'deploy') {
    actionable = members.some(unit => unit.canDeploy)
    reason = '基地车可展开但没有展开'
  } else if (spec.kind === 'rally' || spec.kind === 'combat') {
    actionable = !!members.length && !goal.blocked && !goal.arrival?.reached && (spec.kind === 'rally' || !!spec.destination || !!spec.attackRegion)
    reason = '部队有可执行目标但位置与交战结果未变化'
    facts = [units, spec.kind === 'combat' ? snap.enemies.filter(unit => constraints.enemyIds?.includes(unit.id)).map(unit => [unit.id, unit.hitPoints]) : [], goal.arrival?.reached]
  } else if (spec.kind === 'transport') {
    actionable = !!members.length && snap.self.some(unit => unit.id === spec.transportId && (unit.transport?.occupied ?? 0) < (unit.transport?.capacity ?? 0))
    reason = '步兵和载具已就绪但尚未上车'
    facts = [units, snap.self.find(unit => unit.id === spec.transportId)?.transport]
  } else if (spec.kind === 'explore') {
    actionable = !!members.length && !!goal.exploration?.targets.length
    reason = '已有侦察落点但位置和视野未推进'
    facts = [units, goal.exploration?.regions.map(region => [region.id, region.seen, region.deferred])]
  } else if (spec.kind === 'repair') {
    actionable = !goal.repair?.waiting && (!!goal.repair?.assembling.length || !!goal.repair?.targets.length)
    reason = '存在组装或维修任务但未取得进展'
    facts = [units, goal.repair?.readyIds, goal.repair?.damaged, goal.repair?.assembling]
  }
  return { actionable, reason, signature: JSON.stringify(facts) }
}
