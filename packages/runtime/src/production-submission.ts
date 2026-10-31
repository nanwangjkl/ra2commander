import { randomUUID } from 'node:crypto'
import { directionLabels, type ActionContext, type ActionRequest, type ActionResult, type GoalConstraints, type Snapshot } from '@ra2c/contracts'
import { pendingProduction, prepareCancellation } from './production-cancellation.ts'
import { productionProgress } from './production-progress.ts'
import type { FactoryRallies } from './factory-rally.ts'
import type { ProductionExits } from './production-exit.ts'
import type { GoalState, ProductionRecord } from './state.ts'

interface ProductionSubmissionDeps {
  goals: ReadonlyMap<string, GoalState>
  production: ProductionRecord[]
  rallies: FactoryRallies
  exits: ProductionExits
  ralliesEnabled: boolean
  snapshot(): Snapshot | undefined
  checkpoint(): void | Promise<void>
  submit(actions: ActionRequest[], context: ActionContext, guard: () => boolean): Promise<ActionResult[]>
  buildingFoundation?: (name: string) => { width: number; height: number } | undefined
}
type Reservation = { kind: 'ready'; record: ProductionRecord } | { kind: 'deferred' } | { kind: 'interrupted' }

/** 生产预留与撤销票据、建筑落点/集结冲突；不产生额外生产目标。 */
export class ProductionSubmission {
  private cancelling: Promise<void> | undefined
  constructor(private readonly deps: ProductionSubmissionDeps) {}
  flushCancellations(): Promise<void> {
    return this.cancelling ??= this.sendCancellations().finally(() => { this.cancelling = undefined })
  }
  private async sendCancellations(): Promise<void> {
    for (const record of this.deps.production) {
      const goal = this.deps.goals.get(record.goalId), snap = this.deps.snapshot()
      if (!snap || goal?.status !== 'cancelled' || !goal.facts.cancelProduction || !pendingProduction(record)) continue
      // 其他目标仍需的共享前置保留；这里只撤销本次目标的提交。
      if (goal.spec.kind === 'production' && record.name !== goal.spec.target && [...this.deps.goals.values()].some(other => other !== goal && ['pending', 'active'].includes(other.status)
        && other.spec.kind === 'production' && [other.spec.target, ...other.spec.prerequisites].includes(record.name))) continue
      if (!prepareCancellation(record, this.deps.production, snap)) continue
      const ticket = record.cancellation!
      const valid = () => this.deps.snapshot()?.sessionKey === snap.sessionKey && this.deps.snapshot() === snap && this.deps.production.includes(record) && record.cancellation === ticket && ticket.state === 'prepared' && goal.status === 'cancelled'
      try { await this.deps.checkpoint() }
      catch (error) { delete record.cancellation; goal.facts.blocked = `撤销记录保存失败：${String(error).slice(0, 100)}`; return }
      try {
        if (!valid()) { if (record.cancellation === ticket && ticket.state !== 'confirmed') delete record.cancellation; continue }
        const results = await this.deps.submit([{ kind: 'cancel', name: record.name, quantity: ticket.quantity }], snap, valid)
        if (ticket.state === 'confirmed') continue
        if (!results.length || results.every(result => !result.ok && result.submitted === 0)) {
          delete record.cancellation
          goal.facts.blocked = `队列撤销尚未发送：${results.map(result => result.reason).join('、')}`
        } else {
          ticket.state = results.length && results.every(result => result.ok) ? 'sent' : 'unknown'
          delete goal.facts.blocked
        }
      } catch (error) {
        // API 调用结果不明时保留票据，重启/重试不能盲目再撤一份。
        if (ticket.state === 'confirmed') continue
        ticket.state = 'unknown'
        goal.facts.blocked = `队列撤销结果待确认：${String(error).slice(0, 120)}`
      }
    }
  }

  async reserve(goal: GoalState, request: Extract<ActionRequest, { kind: 'produce' }>, constraints: GoalConstraints, snap: Snapshot, valid: () => boolean): Promise<Reservation> {
    const activeSpec = goal.activeSpec!
    if (this.deps.ralliesEnabled) {
      try {
        const checked = await this.deps.rallies.beforeProduction(constraints.productionQueueTypes![request.name]!, snap, () => valid() && goal.status === 'active' && goal.activeSpec === activeSpec)
        if (!valid() || goal.status !== 'active' || goal.activeSpec !== activeSpec) return { kind: 'interrupted' }
        if (!checked.ok) { goal.facts.rallyBlocked = true; goal.facts.blocked = checked.reason ?? '等待可用集结点后生产'; return { kind: 'deferred' } }
        if (goal.facts.rallyBlocked) { delete goal.facts.rallyBlocked; delete goal.facts.blocked }
      } catch (error) {
        if (!valid() || goal.status !== 'active' || goal.activeSpec !== activeSpec) return { kind: 'interrupted' }
        goal.facts.rallyBlocked = true; goal.facts.blocked = `生产前集结点检查未完成：${String(error).slice(0, 120)}`; return { kind: 'deferred' }
      }
    }
    const spec = activeSpec
    // 同一句话明确要求的建筑也可能先被其他目标当作前置生产；统一记到该建设目标，避免换代码后再造一遍。
    const powerTarget = spec.kind === 'production' && !!spec.maintainPower && request.name === spec.target
    const target = spec.kind === 'production' && (request.name !== spec.target || powerTarget) ? [...this.deps.goals.values()].find(candidate => {
      const desired = candidate.activeSpec ?? candidate.spec
      return !['cancelled', 'completed', 'partial', 'failed'].includes(candidate.status) && !candidate.facts.preparationError && desired.kind === 'production' && !desired.maintainPower
        && (powerTarget ? !desired.afterGoalId || this.deps.goals.get(desired.afterGoalId)?.status === 'completed' : !desired.placement && !desired.placementRegion && !desired.afterGoalId) && desired.target === request.name
        && (productionProgress(desired, this.deps.production, snap).remaining[request.name] ?? 0) >= (powerTarget ? 1 : request.quantity)
    }) : undefined
    const ownerSpec = target?.activeSpec ?? target?.spec ?? spec
    if (powerTarget && target && ownerSpec.kind === 'production') request.quantity = Math.min(request.quantity, productionProgress(ownerSpec, this.deps.production, snap).remaining[request.name] ?? 0)
    const record: ProductionRecord = { id: randomUUID(), goalId: target?.spec.id ?? goal.spec.id, name: request.name, quantity: request.quantity, building: spec.kind === 'production' && (request.name !== spec.target || spec.targetType === 2), queueType: constraints.productionQueueTypes![request.name]!, state: 'reserved', observedIds: [], placed: false }
    if (ownerSpec.kind === 'production' && ownerSpec.target === request.name && ownerSpec.placementRegion) record.placementRegion = structuredClone(ownerSpec.placementRegion)
    if (ownerSpec.kind === 'production' && ownerSpec.target === request.name && ownerSpec.placement) {
      const submitted = this.deps.production.filter(r => r.goalId === record.goalId && r.name === request.name && r.state !== 'rejected').reduce((n, r) => n + r.quantity, 0)
      record.placement = { anchor: structuredClone(ownerSpec.placement.anchor), directions: Array.from({ length: request.quantity }, (_, n) => ownerSpec.placement!.directions[Math.min(submitted + n, ownerSpec.placement!.directions.length - 1)]!) }
      const base = ownerSpec.afterGoalId ? this.deps.goals.get(ownerSpec.afterGoalId)?.facts.relocation : undefined
      if (base && ownerSpec.placement.anchor.name === '基地') record.placement.anchor = { ...base.position, name: '基地' }
    }
    this.deps.production.push(record)
    try { await this.deps.checkpoint() }
    catch (err) { record.state = 'rejected'; goal.facts.blocked = `生产预留保存失败: ${String(err)}`; return { kind: 'interrupted' } }
    if (!valid() || goal.status !== 'active') { record.state = 'rejected'; return { kind: 'interrupted' } }
    return { kind: 'ready', record }
  }

  protectPlacement(request: Extract<ActionRequest, { kind: 'place' }>, snap: Snapshot): void {
    // 该字段只由宿主按最新集结事实填写，不接受生成脚本自行放宽或伪造。
    const points = this.deps.rallies.protectedPoints(snap, this.deps.exits.state.units)
    if (points.length) request.rallyPoints = points
    else delete request.rallyPoints
  }

  async placementResult(goal: GoalState, request: Extract<ActionRequest, { kind: 'place' }>, results: ActionResult[], snap: Snapshot, guard: () => boolean): Promise<'blocked' | 'rejected' | 'interrupted' | undefined> {
    if (request.kind === 'place' && results.length && results.every(result => !result.ok && result.submitted === 0 && result.reason === 'building-rally-conflict')) {
      goal.facts.placementBlocked = true
      const location = results[0]!.placement, foundation = this.deps.buildingFoundation?.(request.name)
      if (!location || !foundation) goal.facts.blocked = '无法确认建筑占地及替代集结点，保留就绪建筑'
      else {
        try {
          const checked = await this.deps.rallies.beforePlacement({ id: -1, name: request.name, x: location.x, y: location.y, foundation, factory: 0 }, snap, guard, this.deps.exits.state.units)
          if (!guard()) return 'interrupted'
          goal.facts.blocked = checked.ok ? '已避开建筑落点调整集结点，下一步继续放置' : checked.reason ?? '集结点尚未安全换点，保留就绪建筑'
        } catch (error) {
          if (!guard()) return 'interrupted'
          goal.facts.blocked = `放置前集结点调整未完成，保留就绪建筑：${String(error).slice(0, 120)}`
        }
      }
      return 'blocked'
    }
    if (request.kind === 'place' && results.length && results.every(result => !result.ok && result.submitted === 0 && (['no-spot', 'cannot-place', 'building-spacing'].includes(result.reason ?? '') || result.reason?.startsWith('placement-footprint-unavailable:')))) {
      goal.facts.placementBlocked = true
      const missing = results.find(result => result.reason?.startsWith('placement-footprint-unavailable:'))?.reason?.split(':')[1]
      goal.facts.blocked = missing ? `缺少${missing}的建筑占地数据，保留就绪建筑并继续重试`
        : request.placement ? `${request.name} 在${request.placement.anchor.name ?? '参照点'}${directionLabels[request.placement.direction]}暂无合法位置，保留就绪建筑并继续尝试该方向`
        : `${request.name} 暂无可放置位置，保留就绪建筑并继续重试`
      return 'rejected'
    }
  }
}
