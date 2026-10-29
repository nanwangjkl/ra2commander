import { randomUUID } from 'node:crypto'
import {
  validateScriptActions, liveScriptActions, inRegion, inTargetRegion, goalExecutionMode, goalOwner, normalizeAttackGoal, attackObjective, ownerId, directionLabels,
  type ActionRequest, type ActionResult, type ActionContext, type Snapshot, type StepConstraints,
  type GoalConstraints, type GoalSpec, type GoalView, type ScriptAction, type ScriptOwner, type FormationRequest, type GoalExecution, type CoverPolicy,
} from '@ra2c/contracts'
import { codeHash, type StepExecutor } from '@ra2c/js-worker'
import { FormationRegistry } from './formation.ts'
import { emptyFacts, type GoalState, type ProgramState, type ProductionRecord, type Handoff } from './state.ts'
import { observeProduction, productionProgress } from './production-progress.ts'
import { cancellationDetail, observeCancellations, pendingProduction, prepareCancellation } from './production-cancellation.ts'
import { ExplorationStore, skillGoalIds, type SkillRun } from './exploration.ts'
import { RecoveryMonitor } from './recovery.ts'
import { handlerFor, validateGoalSpec, validateGoalFacts } from './goals/index.ts'
import { formationPreparing, presentUnitIds } from './goals/common.ts'
import { validateCover, emptyCoverMotion, recordCoverOrder, coverMembers, coverMoves, type CoverMotion } from './cover.ts'
import { coverCombat, coverRangePairs, airborne, type CoverIntent, type CoverRange } from './cover-combat.ts'
import type { GoalContext, GoalProjection } from './goals/types.ts'
import { FactoryRallies, type FactorySite, type FactoryRallyDeps } from './factory-rally.ts'
import { ProductionExits, insideFactory, exitPoint, type ExitYield } from './production-exit.ts'
export type { ProductionExitState } from './production-exit.ts'
export { rallyCandidates } from './factory-rally.ts'
export type { FactorySite, RallySetting, FactoryRallyState } from './factory-rally.ts'
export { initialMining, miningBatch, observeOre } from './mining.ts'
export { skillGoalIds } from './exploration.ts'
export { ExplorationStore } from './exploration.ts'
export type { ExplorationMap, ExplorationProgress, ExplorationObservation, SkillRun } from './exploration.ts'

export { FormationRegistry } from './formation.ts'
export type { Formation, CreateResult } from './formation.ts'
export { computePrerequisiteClosure } from './production.ts'
export type { RulesLookup, PrerequisiteClosure } from './production.ts'
export { persistState, restoreState, saveStateFile, readStateFile } from './persist.ts'
export type { PersistedState } from './persist.ts'
export type { GoalState, ProgramState, ProductionRecord, Handoff } from './state.ts'

export interface CompileLease {
  readonly ownerId: string
  readonly sessionKey: string
  readonly revision: number
  readonly formationRevision: number
  readonly signal: AbortSignal
  readonly repair: boolean
  readonly recoveryStatus?: 'active' | 'paused'
  goals: GoalSpec[]
}
export interface RuntimeDeps {
  executor: Pick<StepExecutor, 'run'>
  submit: (actions: ActionRequest[], context: ActionContext, guard: () => boolean) => Promise<ActionResult[]>
  formations?: FormationRegistry
  /** 必须成功完成持久化才允许发送非幂等生产请求。 */
  checkpoint: () => void | Promise<void>
  onProgramFaulted?: (ownerId: string) => void
  onProgramStalled?: (ownerId: string, reason: string) => void
  recovery?: { stallTicks?: number; cooldownTicks?: number }
  coverRanges?: (pairs: Array<{ unitId: number; targetId: number }>, snap: Snapshot) => Promise<CoverRange[]>
  factorySites?: (snap: Snapshot) => Promise<FactorySite[]>
  rallyTiles?: FactoryRallyDeps['tiles']
  rallyClear?: FactoryRallyDeps['clear']
  regionsAt?: (x: number, y: number) => import('@ra2c/contracts').TargetRegion[]
  log?: (message: string) => void
}

export class TaskRuntime {
  battleResult: Snapshot['battle'] | undefined
  session = -1
  private sessionKey = ''
  private retiredSessions = new Set<string>()
  private latest?: Snapshot
  private draining: Promise<void> | undefined
  private cancelling: Promise<void> | undefined
  private coverIdleOrders = new Map<string, CoverMotion>()
  /** 新快照不重置下一位，避免前面的控制对象反复抢先。 */
  private nextProgram = 0
  private pending = new Map<string, { lease: CompileLease; abort: AbortController }>()
  readonly programs = new Map<string, ProgramState>()
  readonly goals = new Map<string, GoalState>()
  readonly formations: FormationRegistry
  readonly production: ProductionRecord[] = []
  readonly seenUnitIds = new Set<number>()
  readonly pausedQueues = new Map<number, string>()
  readonly handoffs: Handoff[] = []
  readonly exploration = new ExplorationStore()
  readonly skillRuns = new Map<string, SkillRun>()
  readonly factoryRallies: FactoryRallies
  readonly productionExits = new ProductionExits()
  private lastUnitOrders = new Map<number, { goalId: string; request: ActionRequest; owner: string; revision: number; generation: number }>()
  private exitOrders = { seq: -1, ids: new Set<number>() }
  private readonly recovery: RecoveryMonitor

  constructor(private readonly deps: RuntimeDeps) {
    this.formations = deps.formations ?? new FormationRegistry()
    this.recovery = new RecoveryMonitor(deps.recovery?.stallTicks, deps.recovery?.cooldownTicks)
    this.factoryRallies = new FactoryRallies({ current: () => this.latest,
      sites: snap => deps.factorySites?.(snap) ?? Promise.resolve([]),
      tiles: (points, snap) => deps.rallyTiles?.(points, snap) ?? Promise.resolve([]),
      clear: point => deps.rallyClear?.(point) ?? true,
      submit: (action, snap, guard) => deps.submit([action], snap, guard), checkpoint: () => deps.checkpoint(),
      automaticAllowed: () => !['paused', 'stopped'].includes(this.programs.get('global')?.status ?? ''),
      notify: setting => deps.log?.(`[companion] ${setting.name} #${setting.factoryId} 默认集结点${setting.status === 'submitted' ? `指令已提交至 (${setting.point!.x},${setting.point!.y})` : `未设置：${setting.reason ?? setting.status}`}`),
      relocated: (factoryId, before, after, snap) => this.productionExits.relocatePending(factoryId, before, after, snap),
    })
  }
  recoveryContext(id: string) { return this.recovery.context(id) }
  private recoveryKey(program: ProgramState): string { return `${this.sessionKey}:${program.revision}:${program.script?.version ?? 0}` }
  get battleKey(): string { return this.sessionKey }
  get snapshot(): Snapshot | undefined { return this.latest }
  hasPendingCommand(id: string): boolean { return this.pending.has(id) }
  pendingCommandIds(): string[] { return [...this.pending.keys()] }
  /** 等待集结的产物还没有实际归属，但新命令应指向它已经约定的编队。 */
  plannedFormationOf(id: number): string | undefined {
    const existing = this.formations.ownerOf(id)
    if (existing) return existing
    for (const record of this.production) {
      const goal = this.goals.get(record.goalId)
      if (record.observedIds.includes(id) && goal && ['active', 'pending'].includes(goal.status) && goal.spec.kind === 'production' && goal.spec.formationId) return goal.spec.formationId
    }
  }
  hasPlannedFormation(id: string): boolean {
    return [...this.goals.values()].some(goal => !['cancelled', 'completed', 'partial', 'failed'].includes(goal.status) && (
      goal.spec.kind === 'formation' && goal.spec.request.kind === 'createFormation' && goal.spec.request.formationId === id && goal.spec.request.unitIds.some(unit => this.latest?.self.some(item => item.id === unit))
      || goal.spec.kind === 'production' && goal.spec.formationId === id))
  }

  /** 提供已有执行事实的精简视图；不改变目标，也不把动作提交当作完成。 */
  goalExecution(id: string): GoalExecution | undefined {
    const goal = this.goals.get(id)
    if (!goal) return undefined
    if (goal.facts.endedByBattle) return { state: goal.status as 'completed' | 'partial' | 'failed', detail: goal.facts.outcomeDetail ?? '对局已结束' }
    const handler = handlerFor(goal.spec)
    const terminal = this.latest && ['completed', 'partial', 'failed'].includes(goal.status) ? handler.terminalExecution?.(this.goalContext(goal.spec, this.latest)) : undefined
    if (terminal) return terminal
    const progress = this.latest && ['completed', 'partial', 'failed'].includes(goal.status) ? handler.progress?.(this.goalContext(goal.spec, this.latest), this.project(goal.spec, this.latest).view) ?? {} : {}
    if (goal.status === 'partial' || goal.status === 'failed') return { ...progress, state: goal.status, detail: [goal.facts.outcomeDetail ?? '探索未全部完成', progress.detail].filter(Boolean).join('；') }
    if (goal.status === 'completed') return { state: 'completed', ...progress }
    if (goal.status === 'cancelled') return { state: 'cancelled', detail: goal.facts.cancelProduction ? cancellationDetail(goal, this.production) : goal.facts.cancelReason ?? '目标已取消或被替换' }
    const program = this.programs.get(goal.ownerId)
    const spec = goal.activeSpec
    if (!spec && goal.status === 'pending' && goal.facts.completedQuantity !== undefined) return { state: 'completed', detail: `前次${goal.facts.completedQuantity}个已完成，新增总量待生效` }
    if (!spec || !program?.activeGoalIds.includes(id) || !this.latest) return program?.status === 'paused' ? { state: 'paused', detail: '目标保留，控制对象已暂停' } : undefined
    if (program.status === 'paused') return program.stats.errors >= 3 && program.stats.lastError
      ? { state: 'faulted', detail: `脚本运行出错，已暂停：${program.stats.lastError}` } : { state: 'paused', detail: '控制对象已暂停' }
    if (program.status === 'stopped') return { state: 'cancelled', detail: '控制对象已停止' }
    if (goal.facts.nativeError) return { state: 'faulted', detail: `本机执行出错：${goal.facts.nativeError}` }
    const ctx = this.goalContext(spec, this.latest), projected = this.project(spec, this.latest), view = projected.view
    const activeHandler = handlerFor(spec)
    const execution = activeHandler.execution?.(ctx, projected)
    const exitIds = new Set(spec.kind === 'production' ? view.observed[spec.target] ?? [] : [])
    const factories = new Set(this.productionExits.state.units.filter(unit => exitIds.has(unit.unitId)).map(unit => unit.factoryId))
    const exitNotices = this.productionExits.state.blockages.filter(block => factories.has(block.factoryId) && block.state !== 'recovered').map(block => block.detail)
    const notice = [goal.facts.coverEnded, ...exitNotices].filter(Boolean).join('；')
    if (execution) return { ...execution, ...(notice ? { detail: [notice, execution.detail].filter(Boolean).join('；') } : {}) }
    const currentProgress = activeHandler.progress?.(ctx, view) ?? {}
    const unmet = view.productionPlan?.unmetConditions ?? []
    const conditionDetail = unmet.length && !view.productionPlan?.availableToProduce.length && !view.productionPlan?.readyToPlace.length ? unmet.map(condition => condition.reason).join('；') : undefined
    const detail = view.blocked ?? conditionDetail ?? (goal.facts.placementBlocked ? goal.facts.blocked : undefined) ?? (view.uncertain.length ? `提交结果待确认：${view.uncertain.join('、')}` : undefined)
    if (detail) return { state: 'blocked', detail, ...(currentProgress.progress ? { progress: currentProgress.progress } : {}) }
    const continuous = activeHandler.continuous?.(ctx)
    return { ...currentProgress, state: continuous ? 'continuous' : 'running', ...(notice ? { detail: [notice, currentProgress.detail].filter(Boolean).join('；') } : {}) }
  }

  async cancelSkillRun(id: string, superseded = false): Promise<void> {
    const run = this.skillRuns.get(id)
    if (!run || !['preparing', 'exploring', 'repairing', 'covering'].includes(run.status)) return
    if (run.kind === 'cover') {
      if (this.formations.coverOf(run.formationId)?.runId === run.id) await this.uncover(run.formationId)
      run.status = superseded ? 'superseded' : 'cancelled'
      for (const goalId of run.ownedPreparationGoalIds ?? run.preparationGoalIds.filter(id => this.goals.get(id)?.spec.skill?.runId === run.id)) {
        if (this.goals.get(goalId)?.spec.kind === 'production') await this.cancelProductionGoal(goalId)
        else await this.cancelGoal(goalId, '玩家取消掩护准备')
      }
      return
    }
    run.status = superseded ? 'superseded' : 'cancelled'
    run.detail = superseded ? '编队已接受新命令，停止原 Skill 后续步骤' : '玩家取消 Skill；已进入游戏队列的生产不回退'
    await Promise.all(skillGoalIds(run).map(goalId => {
      const goal = this.goals.get(goalId)
      return goal && !['completed', 'partial', 'failed', 'cancelled'].includes(goal.status) ? this.cancelGoal(goalId, run.detail) : Promise.resolve()
    }))
  }

  private syncSkillRuns(): void {
    for (const run of this.skillRuns.values()) {
      if (!['preparing', 'exploring', 'repairing', 'covering'].includes(run.status)) continue
      if (run.kind === 'cover') {
        let profile = this.formations.coverOf(run.formationId)
        if (run.cover && this.formations.list().some(formation => formation.id === run.formationId)) {
          const assigned = new Set(run.assignedEscortIds ?? (profile?.runId === run.id ? profile.escortIds : []))
          const candidates = [...run.escortIds, ...(run.cover.escortSources ?? []).flatMap(source => this.production.filter(record => record.goalId === source.goalId && record.name === (this.goals.get(source.goalId)?.spec as { target?: string })?.target).flatMap(record => record.observedIds).slice(0, source.quantity))]
          const incoming = candidates.filter(id => !assigned.has(id) && this.latest?.self.some(unit => unit.id === id) && this.formations.ownerOf(id) === run.formationId && !this.locked(id))
          const kept = profile?.runId === run.id ? profile.escortIds.filter(id => this.formations.ownerOf(id) === run.formationId && this.latest?.self.some(unit => unit.id === id)) : []
          const desired = { ...run.cover, escortIds: [...new Set([...kept, ...incoming])] }
          if (JSON.stringify(profile) !== JSON.stringify(desired)) this.setCover(run.formationId, desired)
          run.assignedEscortIds = [...new Set([...assigned, ...incoming])]
          run.escortIds = [...new Set([...run.escortIds, ...incoming])]
          profile = this.formations.coverOf(run.formationId)
        }
        if (profile?.runId === run.id) {
          const escorts = this.latest?.self.filter(unit => profile.escortIds.includes(unit.id) && this.formations.ownerOf(unit.id) === run.formationId).length ?? 0
          const total = this.latest?.self.filter(unit => this.formations.ownerOf(unit.id) === run.formationId).length ?? 0
          const preparing = run.preparationGoalIds.some(id => ['pending', 'active'].includes(this.goals.get(id)?.status ?? ''))
          run.status = escorts && total > escorts ? 'covering' : preparing ? 'preparing' : 'covering'
          run.detail = `同属${run.formationId}：被掩护${total - escorts}、掩护${escorts}${preparing ? '；等待本次生产和交接，其余可用成员先行动' : escorts ? '；协同行动' : '；掩护成员已损失或准备结束，未追加生产'}`
        } else if (run.status === 'covering' || run.preparationGoalIds.some(id => this.goals.get(id)?.status === 'cancelled')) { run.status = 'superseded'; run.detail = '掩护已解除或被重新安排' }
        continue
      }
      if (run.kind === 'repair-vehicle') {
        const repair = this.goals.get(run.repairGoalId)
        if (repair?.status === 'cancelled') { void this.cancelSkillRun(run.id, true).catch(error => this.deps.log?.(String(error))); continue }
        if (repair && ['failed', 'partial'].includes(repair.status)) { run.status = repair.status as 'failed' | 'partial'; run.detail = repair.facts.outcomeDetail ?? '维修任务结束'; continue }
        if (run.preparationGoalIds.some(id => this.goals.get(id)?.status === 'cancelled')) { void this.cancelSkillRun(run.id).catch(error => this.deps.log?.(String(error))); continue }
        const ready = repair?.facts.repair?.engineerIds ?? []
        const count = this.latest?.self.filter(unit => this.formations.ownerOf(unit.id) === run.formationId && unit.transport?.unitIds.some(id => ready.includes(id))).length ?? 0
        run.status = count ? 'repairing' : 'preparing'
        run.detail = `已组装${count}/${run.quantity}辆维修车`
        continue
      }
      const explore = this.goals.get(run.exploreGoalId), prepare = this.goals.get(run.preparationGoalId)
      if (explore?.status === 'cancelled') { void this.cancelSkillRun(run.id, true).catch(error => this.deps.log?.(String(error))); continue }
      if (explore && ['completed', 'partial', 'failed'].includes(explore.status)) {
        if (explore.status === 'completed' && prepare && !['completed', 'cancelled'].includes(prepare.status)) {
          run.detail = '探索已完成，等待本次固定数量生产及编队结束'
          continue
        }
        run.status = explore.status as 'completed' | 'partial' | 'failed'
        run.detail = explore.facts.outcomeDetail ?? '探索完成'
        if (prepare && !['completed', 'cancelled'].includes(prepare.status)) void this.cancelGoal(prepare.spec.id, run.detail).catch(error => this.deps.log?.(String(error)))
      } else if (prepare?.status === 'cancelled') {
        void this.cancelSkillRun(run.id).catch(error => this.deps.log?.(String(error)))
      } else {
        const ready = this.latest?.self.some(unit => this.formations.ownerOf(unit.id) === run.formationId && !this.locked(unit.id))
        run.status = ready ? 'exploring' : 'preparing'
      }
    }
  }

  private program(owner: ScriptOwner): ProgramState {
    const id = ownerId(owner)
    let program = this.programs.get(id)
    if (!program) {
      program = { id, owner, goalIds: [], activeGoalIds: [], revision: 0, generation: 0, status: 'idle', memory: {}, stats: { steps: 0, actions: 0, rejected: 0, errors: 0 } }
      this.programs.set(id, program)
    }
    return program
  }

  setCover(formationId: string, cover: CoverPolicy): void {
    validateCover(cover)
    const previous = this.formations.coverOf(formationId)
    if (previous && previous.runId !== cover.runId) {
      const old = this.skillRuns.get(previous.runId)
      if (old) { old.status = 'superseded'; old.detail = '已重新安排掩护' }
    }
    this.formations.setCover(formationId, cover)
    this.coverIdleOrders.delete(formationId)
    const program = this.program({ kind: 'formation', formationId })
    program.generation++
    for (const id of program.activeGoalIds) {
      const facts = this.goals.get(id)!.facts
      if (facts.coverMotion) facts.coverMotion.orders = {}
      delete facts.coverEnded
    }
  }
  hasCover(formationId: string): boolean {
    return !!this.formations.coverOf(formationId) || [...this.skillRuns.values()].some(run => run.kind === 'cover' && run.formationId === formationId && ['preparing', 'covering'].includes(run.status))
  }
  /** 新命令到来早于下一次战损观察时，也立即解除失去受护对象的旧角色。 */
  async clearLostCover(formationId: string): Promise<boolean> {
    const policy = this.formations.coverOf(formationId)
    if (!policy || this.latest?.self.some(unit => this.formations.ownerOf(unit.id) === formationId && !policy.escortIds.includes(unit.id))
      || policy.protectedSources?.some(id => ['pending', 'active'].includes(this.goals.get(id)?.status ?? ''))) return false
    this.endCover(formationId, '被掩护成员已全部损失，已转为普通编队，继续当前任务')
    return true
  }

  /** 战损只结束掩护职责，保留任务、成员、独立生产和暂停/停止状态。 */
  private endCover(formationId: string, detail: string, failed = false, escortIds = this.formations.coverOf(formationId)?.escortIds ?? []): void {
    const policy = this.formations.coverOf(formationId)
    if (!policy) return
    this.formations.setCover(formationId)
    this.coverIdleOrders.delete(formationId)
    const run = this.skillRuns.get(policy.runId)
    if (run?.kind === 'cover') { run.status = failed ? 'failed' : 'partial'; run.detail = detail }
    const present = this.latest ? presentUnitIds(this.latest) : new Set<number>()
    const released = escortIds.filter(id => present.has(id) && this.formations.ownerOf(id) === formationId)
    const program = this.programs.get(`formation:${formationId}`)
    if (program) { program.generation++; program.memory = {} }
    for (const goal of this.goals.values()) if (goal.ownerId === program?.id && (goal.activeSpec || goal.facts.initialized) && ['pending', 'active'].includes(goal.status) && (goal.spec.kind === 'combat' || goal.spec.kind === 'attack')) {
      delete goal.facts.coverMotion
      goal.facts.coverEnded = detail
      if (goal.spec.kind === 'attack' && released.length) goal.facts.coverReleasedIds = [...new Set([...(goal.facts.coverReleasedIds ?? []), ...released])]
    }
  }

  private observeCoverLosses(snap: Snapshot): void {
    const present = presentUnitIds(snap), context = { snap, goals: this.goals, handoffs: this.handoffs }
    for (const formation of this.formations.list()) {
      const policy = formation.cover
      if (!policy) continue
      const run = this.skillRuns.get(policy.runId)
      const escorts = new Set([...policy.escortIds, ...(run?.kind === 'cover' ? run.escortIds : []),
        ...(policy.escortSources ?? []).flatMap(source => this.production.filter(record => record.goalId === source.goalId && record.name === (this.goals.get(source.goalId)?.spec as { target?: string })?.target).flatMap(record => record.observedIds).slice(0, source.quantity))])
      const members = formation.memberIds.filter(id => present.has(id))
      // 没有现役成员但本次仍有生产或交接时，保留准备，不判全灭。
      if (!members.length && formationPreparing(context, formation.id)) continue
      const escortLost = !members.some(id => escorts.has(id)) && !formationPreparing(context, formation.id, { sourceIds: (policy.escortSources ?? []).map(source => source.goalId), accepts: id => escorts.has(id) })
      const protectedLost = !members.some(id => !escorts.has(id)) && !formationPreparing(context, formation.id, { sourceIds: policy.protectedSources ?? [], accepts: id => !escorts.has(id) })
      if (!escortLost && !protectedLost) continue
      const detail = !members.length ? `${formation.id} 已无存活成员，掩护结束，保留队名`
        : `${protectedLost ? '被掩护' : '掩护'}成员已全部损失，已转为普通编队，继续当前任务`
      this.endCover(formation.id, detail, !members.length, [...escorts])
    }
  }
  async uncover(formationId: string): Promise<void> {
    const previous = this.formations.coverOf(formationId)
    if (!previous) return
    const snap = this.latest, program = this.programs.get(`formation:${formationId}`)
    this.formations.setCover(formationId)
    this.coverIdleOrders.delete(formationId)
    const run = this.skillRuns.get(previous.runId)
    if (run) { run.status = 'cancelled'; run.detail = '掩护已解除，成员保留在原队' }
    if (program) {
      program.generation++; program.memory = {}
      for (const id of program.activeGoalIds) delete this.goals.get(id)!.facts.coverMotion
    }
    const generation = program?.generation
    const ids = snap ? previous.escortIds.filter(id => this.formations.ownerOf(id) === formationId && snap.self.some(unit => unit.id === id)) : []
    if (snap && ids.length) await this.deps.submit([{ kind: 'stop', unitIds: ids }], snap,
      () => this.latest === snap && this.sessionKey === snap.sessionKey && !this.formations.coverOf(formationId) && program?.generation === generation && ids.every(id => this.formations.ownerOf(id) === formationId))
  }

  private goalContext(spec: GoalSpec, snap: Snapshot): GoalContext {
    return { spec, snap, goal: this.goals.get(spec.id) ?? { ownerId: ownerId(goalOwner(spec)), spec, status: 'pending', facts: emptyFacts() },
      goals: this.goals, programs: this.programs, formations: this.formations, production: this.production, pausedQueues: this.pausedQueues,
      handoffs: this.handoffs, exploration: this.exploration, locked: id => this.locked(id), hasPlannedFormation: id => this.hasPlannedFormation(id), ...(this.deps.regionsAt ? { regionsAt:this.deps.regionsAt } : {}) }
  }
  private project(spec: GoalSpec, snap: Snapshot): GoalProjection {
    const result = handlerFor(spec).project(this.goalContext(spec, snap))
    if ((spec.kind === 'combat' || spec.kind === 'attack') && spec.formationId) {
      const policy = this.formations.coverOf(spec.formationId)
      if (policy) {
        const escorts = policy.escortIds.filter(id => this.formations.ownerOf(id) === spec.formationId && snap.self.some(unit => unit.id === id) && !this.locked(id))
        result.constraints.allowedUnitIds = [...new Set([...result.constraints.allowedUnitIds, ...escorts])]
        const targetRegion = result.constraints.targetRegion ?? attackObjective(spec)?.target.region
        result.constraints.coverFire = { unitIds: escorts, enemyIds: snap.enemies.filter(unit => airborne(unit) && (!targetRegion || inTargetRegion(unit.rx, unit.ry, targetRegion))).map(unit => unit.id) }
        const members = coverMembers(policy, snap, result.constraints.allowedUnitIds)
        result.view.cover = { protectedIds: members.protectedUnits.map(u => u.id), escortIds: escorts, slowestIds: members.slowest.map(u => u.id), heldIds: this.goals.get(spec.id)?.facts.coverMotion?.heldIds ?? [], detail: this.goals.get(spec.id)?.facts.coverMotion?.detail ?? '掩护配置生效，协调行军与近身支援' }
      }
    }
    result.constraints.allowedUnitIds = result.constraints.allowedUnitIds.filter(id => !this.productionExits.locked(id))
    if (result.constraints.friendlyTargetIds) result.constraints.friendlyTargetIds = result.constraints.friendlyTargetIds.filter(id => !this.productionExits.locked(id))
    if (result.constraints.management) result.constraints.management.allowedUnitIds = result.constraints.management.allowedUnitIds.filter(id => !this.productionExits.locked(id))
    result.view.unitIds = result.view.unitIds.filter(id => !this.productionExits.locked(id))
    if (spec.kind === 'formation' && spec.request.kind !== 'dissolveFormation' && spec.request.unitIds.some(id => this.productionExits.waiting(id))) result.view.blocked = '等待新造成员抵达集结点后编队'
    return result
  }
  private validateGoal(spec: GoalSpec): void {
    if (!this.latest) throw new Error('目标缺少当前对局')
    validateGoalSpec(spec, this.latest)
    const ctx = this.goalContext(spec, this.latest)
    validateGoalFacts(ctx.goal, this.latest)
    handlerFor(spec).validateLive?.(ctx)
  }

  upsertGoal(spec: GoalSpec): string {
    if (this.battleResult?.phase === 'ended') throw new Error('对局已结束，请进入新对局后下令')
    spec = { ...normalizeAttackGoal(spec), executionMode: goalExecutionMode(spec) }
    if (spec.kind === 'rally') spec = { ...spec, unitIds: [...new Set(spec.unitIds)].filter(id => !this.formations.ownerOf(id) && this.latest?.self.some(u => u.id === id)) }
    this.validateGoal(spec)
    if (!this.goals.has(spec.id)) this.productionExits.unhalt('unitIds' in spec ? spec.unitIds : spec.kind === 'formation' && spec.request.kind !== 'dissolveFormation' ? spec.request.unitIds : [])
    if (spec.kind === 'formation' && !spec.sourceOwners) {
      const ids = spec.request.kind === 'dissolveFormation' ? this.formations.membersOf(spec.request.formationId) : spec.request.unitIds
      spec = { ...spec, sourceOwners: ids.map(id => [id, this.formations.ownerOf(id) ?? null]) }
    }
    const owner = goalOwner(spec)
    const program = this.program(owner)
    const old = this.goals.get(spec.id)
    if (old && goalOwner(spec).kind === 'formation' && (old.status !== 'pending' || old.activeSpec || old.spec.rawText !== spec.rawText)) throw new Error('编队新命令应使用新的目标 ID')
    if (old && goalExecutionMode(old.spec) !== goalExecutionMode(spec)) throw new Error('改变执行方式须使用新的目标 ID')
    if (old && (old.ownerId !== program.id || old.spec.kind !== spec.kind || old.status === 'cancelled')) throw new Error('不能复用其他对象或已取消目标的 ID')
    if (old?.status === 'completed' && spec.kind !== 'production') throw new Error('该目标已完成，请建立新目标')
    if (old) {
      const completedQuantity = old.status === 'completed' && old.spec.kind === 'production' ? old.activeSpec?.kind === 'production' ? old.activeSpec.quantity : old.spec.quantity : undefined
      old.spec = structuredClone(spec)
      if (old.status === 'completed') {
        if (completedQuantity !== undefined) old.facts.completedQuantity = completedQuantity
        old.status = 'pending'
        delete old.activeSpec
        program.activeGoalIds = program.activeGoalIds.filter(id => id !== spec.id)
      }
    } else this.goals.set(spec.id, { ownerId: program.id, spec: structuredClone(spec), status: 'pending', facts: emptyFacts() })
    if (owner.kind === 'formation') {
      for (const id of program.goalIds) if (id !== spec.id && !program.activeGoalIds.includes(id)) {
        const previous = this.goals.get(id)!
        previous.status = 'cancelled'; previous.facts.cancelReason = `已被后续命令替换：${spec.rawText}`
      }
      program.goalIds = [spec.id]
    }
    else if (!program.goalIds.includes(spec.id)) program.goalIds.push(spec.id)
    if (goalExecutionMode(spec) === 'script' || owner.kind === 'formation') {
      program.revision++
      delete program.compileError
      this.cancelCommand(program.id)
    }
    return program.id
  }

  /** 全局本机目标独立生效；编队改令替换该队旧任务并撤销迟到脚本。 */
  activateNativeGoals(id: string): string[] {
    const program = this.programs.get(id)
    if (!program || !this.latest) return []
    const activated: string[] = []
    for (const goalId of program.goalIds) {
      const goal = this.goals.get(goalId)!
      if (!goal || !['pending', 'active'].includes(goal.status) || goalExecutionMode(goal.spec) !== 'native' || JSON.stringify(goal.spec) === JSON.stringify(goal.activeSpec)) continue
      if (program.owner.kind === 'formation') {
        for (const oldId of program.activeGoalIds) if (oldId !== goalId) {
          const old = this.goals.get(oldId)
          if (old?.status === 'active') { old.status = 'cancelled'; old.facts.cancelReason = `已被后续命令替换：${goal.spec.rawText}` }
        }
        program.activeGoalIds = []
        program.generation++
        this.recovery.reset(program.id)
      }
      goal.activeSpec = structuredClone(goal.spec)
      goal.status = 'active'
      delete goal.facts.nativeError
      try { handlerFor(goal.activeSpec).initialize?.(this.goalContext(goal.activeSpec, this.latest)) }
      catch (error) { this.nativeFault(goal, error) }
      if (!program.activeGoalIds.includes(goalId)) program.activeGoalIds.push(goalId)
      activated.push(goalId)
    }
    if (activated.length && ['idle', 'stopped'].includes(program.status)) program.status = 'active'
    return activated
  }

  /** 试点回退：保留同一目标及发令事实，停止本机来源，等待生成代码接管。 */
  useScriptExecution(kinds: readonly GoalSpec['kind'][]): string[] {
    const changed: string[] = []
    for (const goal of this.goals.values()) {
      if (!kinds.includes(goal.spec.kind) || goalExecutionMode(goal.spec) !== 'native' || !['pending', 'active'].includes(goal.status)) continue
      goal.spec = { ...goal.spec, executionMode: 'script' }
      delete goal.activeSpec
      delete goal.facts.nativeError
      goal.status = 'pending'
      const program = this.programs.get(goal.ownerId)!
      program.activeGoalIds = program.activeGoalIds.filter(id => id !== goal.spec.id)
      if (program.status === 'active' && !this.activeSpecs(program).length) program.status = 'idle'
      program.revision++
      this.cancelCommand(program.id)
      changed.push(goal.spec.id)
    }
    return changed
  }

  beginCompile(id: string, repair = false): CompileLease {
    const program = this.programs.get(id)
    if (!program || !this.latest || this.latest.sessionKey !== this.sessionKey) throw new Error('没有有效控制对象或对局')
    if (repair && !['active', 'paused'].includes(program.status)) throw new Error('脚本不处于运行或故障暂停态')
    this.cancelCommand(id)
    const abort = new AbortController()
    const goals = program.goalIds.map(g => this.goals.get(g)!).filter(g => g && goalExecutionMode(g.spec) === 'script' && !['cancelled', 'completed', 'partial', 'failed'].includes(g.status)).map(g => structuredClone(g.spec))
    const lease: CompileLease = { ownerId: id, sessionKey: this.sessionKey, revision: program.revision, formationRevision: this.formations.revision, signal: abort.signal, repair, goals, ...(repair ? { recoveryStatus: program.status as 'active' | 'paused' } : {}) }
    this.pending.set(id, { lease, abort })
    return lease
  }

  private currentLease(lease: CompileLease): boolean {
    return this.pending.get(lease.ownerId)?.lease === lease && !lease.signal.aborted && lease.sessionKey === this.sessionKey && this.programs.get(lease.ownerId)?.revision === lease.revision && lease.formationRevision === this.formations.revision
  }
  isCompileCurrent(lease: CompileLease): boolean { return this.currentLease(lease) }

  prepareCompile(lease: CompileLease, goals: GoalSpec[]): boolean {
    if (!this.currentLease(lease)) return false
    if (goals.length !== lease.goals.length || goals.some((g, i) => g.id !== lease.goals[i]!.id || ownerId(goalOwner(g)) !== lease.ownerId || goalExecutionMode(g) !== 'script')) throw new Error('预处理改变了目标归属')
    for (const goal of goals) {
      // 管理动作可能已提交归属、仍等待停车确认，不能要求“新队尚不存在”。
      if (goal.kind !== 'formation') this.validateGoal(goal)
      this.goals.get(goal.id)!.spec = structuredClone(goal)
    }
    lease.goals = structuredClone(goals)
    return true
  }

  compileFrame(lease: CompileLease): { snapshot: Snapshot; constraints: StepConstraints } {
    if (!this.currentLease(lease) || !this.latest) throw new Error('候选脚本上下文已失效')
    return this.frame(this.programs.get(lease.ownerId)!, lease.goals, this.latest)
  }

  commitCompile(lease: CompileLease, code: string, promptVersion?: string): boolean {
    if (!this.currentLease(lease)) return false
    const program = this.programs.get(lease.ownerId)!
    if (lease.repair && program.status !== lease.recoveryStatus) return false
    const nextIds = new Set(lease.goals.map(g => g.id))
    for (const id of program.activeGoalIds) {
      if (!nextIds.has(id) && (program.owner.kind === 'formation' || goalExecutionMode(this.goals.get(id)!.activeSpec!) === 'script')) {
        const old = this.goals.get(id)
        if (old?.status === 'active') {
          old.status = 'cancelled'
          old.facts.cancelReason = `已被后续命令替换：${lease.goals.map(goal => goal.rawText).join('；')}`
        }
      }
    }
    program.activeGoalIds = program.owner.kind === 'global' ? program.activeGoalIds.filter(id => this.goals.get(id)?.status === 'active' && goalExecutionMode(this.goals.get(id)!.activeSpec!) === 'native') : []
    for (const spec of lease.goals) {
      const goal = this.goals.get(spec.id)!
      if (['cancelled', 'completed', 'partial', 'failed'].includes(goal.status)) continue
      goal.activeSpec = structuredClone(spec)
      goal.status = 'active'
      const handler = handlerFor(spec)
      handler.initialize?.(this.goalContext(spec, this.latest!))
      if (!handler.initialize) goal.facts.initialized = true
      program.activeGoalIds.push(spec.id)
    }
    program.script = { code, version: (program.script?.version ?? 0) + 1, hash: codeHash(code), ...(promptVersion ? { promptVersion } : {}) }
    program.generation++
    program.memory = {}
    program.status = program.activeGoalIds.length ? 'active' : 'idle'
    program.stats.errors = 0
    this.recovery.reset(program.id)
    delete program.compileError
    this.cancelCommand(program.id)
    this.deps.log?.(`[runtime] ${program.id} v${program.script.version}，目标 ${program.activeGoalIds.join(', ') || '无'}`)
    return true
  }

  failCompile(lease: CompileLease, error: string): void {
    if (this.pending.get(lease.ownerId)?.lease === lease) {
      this.programs.get(lease.ownerId)!.compileError = error
      this.releaseCommand(lease)
    }
  }
  cancelCommand(id: string): void { this.pending.get(id)?.abort.abort(); this.pending.delete(id) }
  releaseCommand(lease: CompileLease): void { if (this.pending.get(lease.ownerId)?.lease === lease) this.cancelCommand(lease.ownerId) }
  cancelAllCommands(): void { for (const id of this.pending.keys()) this.cancelCommand(id) }

  async cancelGoal(id: string, reason = '玩家已取消该目标'): Promise<void> {
    const goal = this.goals.get(id)
    if (!goal || ['completed', 'partial', 'failed', 'cancelled'].includes(goal.status)) return
    goal.status = 'cancelled'
    goal.facts.cancelReason = reason
    const program = this.programs.get(goal.ownerId)!
    program.goalIds = program.goalIds.filter(g => g !== id)
    program.activeGoalIds = program.activeGoalIds.filter(g => g !== id)
    if (program.status === 'active' && !this.activeSpecs(program).length) program.status = 'idle'
    if (goalExecutionMode(goal.spec) === 'script') { program.revision++; this.cancelCommand(program.id) }
    const snap = this.latest
    const spec = goal.activeSpec ?? goal.spec
    if (snap) {
      const stoppedIds = handlerFor(spec).stopMembers?.(this.goalContext(spec, snap)) ?? []
      const owner = goalOwner(spec)
      if (stoppedIds.length) await this.deps.submit([{ kind: 'stop', unitIds: stoppedIds }], snap, () => this.sessionKey === snap.sessionKey && goal.status === 'cancelled' && this.goals.get(id) === goal && (program.owner.kind === 'global' || !program.activeGoalIds.some(other => other !== id && this.goals.get(other)?.status === 'active')) && stoppedIds.every(unit => owner.kind === 'global' ? !this.formations.ownerOf(unit) : this.formations.ownerOf(unit) === owner.formationId))
    }
    for (const [queue, owner] of this.pausedQueues) {
      if (owner !== id || !snap) continue
      const guard = () => this.sessionKey === snap.sessionKey && this.pausedQueues.get(queue) === id && goal.status === 'cancelled'
      if (snap.production?.queues.some(q => q.type === queue && q.status === 2)) {
        const result = await this.deps.submit([{ kind: 'resumeQueue', queueType: queue }], snap, guard)
        if (result.length && result.every(r => r.ok) && guard()) this.pausedQueues.delete(queue)
      } else if (snap.production?.queues.some(q => q.type === queue)) this.pausedQueues.delete(queue)
    }
  }

  pendingProductionCount(id: string): number { return this.production.filter(record => record.goalId === id).reduce((n, record) => n + pendingProduction(record), 0) }

  async cancelProductionGoal(id: string): Promise<string> {
    const goal = this.goals.get(id)
    if (!goal || goal.spec.kind !== 'production') throw new Error('生产目标不存在')
    if (goal.status === 'completed') return '生产目标已完成'
    await this.cancelGoal(id)
    if (goal.status !== 'cancelled') return '目标已结束'
    goal.facts.cancelProduction = true
    await this.flushProductionCancellations()
    return cancellationDetail(goal, this.production)
  }

  private flushProductionCancellations(): Promise<void> {
    return this.cancelling ??= this.sendProductionCancellations().finally(() => { this.cancelling = undefined })
  }
  private async sendProductionCancellations(): Promise<void> {
    for (const record of this.production) {
      const goal = this.goals.get(record.goalId), snap = this.latest
      if (!snap || goal?.status !== 'cancelled' || !goal.facts.cancelProduction || !pendingProduction(record)) continue
      // 其他目标仍需的共享前置保留；这里只撤销本次目标的提交。
      if (goal.spec.kind === 'production' && record.name !== goal.spec.target && [...this.goals.values()].some(other => other !== goal && ['pending', 'active'].includes(other.status)
        && other.spec.kind === 'production' && [other.spec.target, ...other.spec.prerequisites].includes(record.name))) continue
      if (!prepareCancellation(record, this.production, snap)) continue
      const ticket = record.cancellation!
      const valid = () => this.sessionKey === snap.sessionKey && this.latest === snap && this.production.includes(record) && record.cancellation === ticket && ticket.state === 'prepared' && goal.status === 'cancelled'
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

  /** 队伍尚未创建时也保留显式控制状态，迟到的成员交接不能恢复它。 */
  private controlProgram(id: string): ProgramState | undefined {
    return this.programs.get(id) ?? this.programs.get(this.goals.get(id)?.ownerId ?? '')
      ?? (id === 'global' ? this.program({ kind: 'global' }) : id.startsWith('formation:') && id.length > 10 ? this.program({ kind: 'formation', formationId: id.slice(10) }) : undefined)
  }
  async stop(id: string): Promise<void> {
    const program = this.controlProgram(id)
    if (!program) return
    const goals = [...new Set([...program.goalIds, ...program.activeGoalIds])]
    this.cancelCommand(program.id)
    program.status = 'stopped'
    program.generation++
    await Promise.all(goals.map(g => this.cancelGoal(g, `${program.id} 脚本已停止`)))
  }
  pause(id: string): void {
    this.recovery.reset(id)
    this.cancelCommand(id)
    const program = this.controlProgram(id)
    if (program) {
      if (this.latest) for (const spec of this.activeSpecs(program)) handlerFor(spec).pause?.(this.goalContext(spec, this.latest))
      program.status = 'paused'; program.generation++
      if (program.owner.kind === 'formation' && this.formations.coverOf(program.owner.formationId) && this.latest) {
        const snap = this.latest, generation = program.generation, formationId = program.owner.formationId
        const ids = this.formations.membersOf(formationId).filter(id => snap.self.some(unit => unit.id === id))
        void this.deps.submit([{ kind: 'stop', unitIds: ids }], snap, () => program.status === 'paused' && program.generation === generation && this.sessionKey === snap.sessionKey && ids.every(id => this.formations.ownerOf(id) === formationId)).catch(error => this.deps.log?.(String(error)))
      }
    }
  }
  resume(id: string): void {
    this.recovery.reset(id)
    this.cancelCommand(id)
    const program = this.programs.get(id)
    if (program && (program.script || this.activeSpecs(program).length) && program.status === 'paused') { program.status = 'active'; program.stats.errors = 0; program.generation++ }
    if (program) for (const spec of this.activeSpecs(program)) delete this.goals.get(spec.id)!.facts.nativeError
    if (program) for (const spec of this.activeSpecs(program)) if (this.goals.get(spec.id)!.facts.coverMotion) this.goals.get(spec.id)!.facts.coverMotion!.orders = {}
  }
  async stopUnits(ids: number[]): Promise<void> {
    this.productionExits.halt(ids)
    const owners = new Set(ids.map(id => this.formations.ownerOf(id)).filter((x): x is string => !!x).map(formationId => ownerId({ kind: 'formation', formationId })))
    const cancel: string[] = []
    for (const goal of this.goals.values()) {
      const spec = goal.activeSpec ?? goal.spec
      if (['cancelled', 'completed', 'partial', 'failed'].includes(goal.status)) continue
      const members = this.latest ? handlerFor(spec).managedMembers?.(this.goalContext(spec, this.latest)) ?? [] : []
      const selected = 'unitIds' in spec ? spec.unitIds : spec.kind === 'formation' && spec.request.kind !== 'dissolveFormation' ? spec.request.unitIds : []
      if ([...members, ...selected].some(id => ids.includes(id))) cancel.push(spec.id)
    }
    await Promise.all([...owners].map(id => this.stop(id)).concat(cancel.map(id => this.cancelGoal(id))))
  }

  resolveProduction(id: string, result: 'sent' | 'not-sent'): void {
    const record = this.production.find(r => r.id === id)
    if (!record || record.state === 'rejected') throw new Error('该记录不存在或已确定未发送')
    if (result === 'not-sent' && record.observedIds.length) throw new Error('已经观察到产物，不能标记未发送')
    if (result === 'not-sent' && this.latest?.production?.queues.some(q => q.items.some(i => i.name === record.name))) throw new Error('游戏队列中仍有该项目，不能标记未发送')
    record.state = result === 'sent' ? 'submitted' : 'rejected'
  }

  private locked(id: number): boolean { return this.productionExits.locked(id) || this.exitOrders.seq === this.latest?.seq && this.exitOrders.ids.has(id) || this.handoffs.some(h => h.unitIds.includes(id)) }
  private activeSpecs(program: ProgramState): GoalSpec[] {
    return program.activeGoalIds.map(id => this.goals.get(id)).filter((g): g is GoalState => !!g && g.status === 'active' && !!g.activeSpec).map(g => g.activeSpec!)
  }

  private goalConstraints(spec: GoalSpec, snap: Snapshot): GoalConstraints { return this.project(spec, snap).constraints }

  private frame(program: ProgramState, specs: GoalSpec[], snap: Snapshot, running = false): { snapshot: Snapshot; constraints: StepConstraints } {
    const goals: Record<string, GoalConstraints> = Object.create(null)
    const views: GoalView[] = []
    for (const spec of specs) {
      const { constraints, view } = this.project(spec, snap)
      goals[spec.id] = constraints
      views.push(view)
    }
    const constraints: StepConstraints = { allowedUnitIds: [], enemyIds: snap.enemies.map(u => u.id), mapWidth: snap.mapWidth, mapHeight: snap.mapHeight, goals, ignoreInactiveGoals: running }
    const regional = specs.length > 0 && specs.every(spec => !!attackObjective(spec)?.target.region)
    const targetIds = new Set(Object.values(goals).flatMap(goal => [...goal.enemyIds, ...(goal.coverFire?.enemyIds ?? [])]))
    return { snapshot: { ...snap, enemies: regional ? snap.enemies.filter(enemy => targetIds.has(enemy.id)) : snap.enemies, constraints, control: { owner: program.owner, goals: views, formations: this.formations.list().map(f => ({ id: f.id, memberIds: [...f.memberIds] })) } }, constraints }
  }

  private observe(snap: Snapshot): void {
    const converted = new Set<number>()
    for (const goal of this.goals.values()) {
      // 已退出目标的事实冻结；不能再把后来出现的产物认作旧成员变形。
      if (goal.status !== 'active' && goal.status !== 'pending') continue
      // 回退等待脚本时仍观察已提交的变形，避免把新身份误记成生产。
      const spec = goal.activeSpec ?? (goal.status === 'pending' && goal.facts.initialized ? goal.spec : undefined)
      if (!spec || goal.facts.nativeError) continue
      const ctx = this.goalContext(spec, snap)
      try { for (const id of handlerFor(spec).track?.(ctx) ?? []) converted.add(id) }
      catch (error) { if (goalExecutionMode(spec) !== 'native') throw error; this.nativeFault(goal, error) }
    }
    if (this.deps.factorySites) this.productionExits.observe(snap, this.factoryRallies.knownSites, this.factoryRallies.state.settings, this.seenUnitIds, this.production, converted, !this.exitAllowed(), this.factoryRallies.clear)
    observeProduction(this.production, this.seenUnitIds, snap, converted)
    observeCancellations(this.production, snap)
    // 先解除失效角色，再结算攻击；剩余掩护成员可在同轮接续原任务。
    this.observeCoverLosses(snap)
    for (const last of [false, true]) for (const goal of this.goals.values()) {
      const spec = goal.activeSpec
      if (goal.status !== 'active' || !spec) continue
      const handler = handlerFor(spec)
      if (!!handler.observeLast !== last) continue
      if (goal.facts.nativeError) continue
      let result: { stopIds: number[] } | void
      try { result = handler.observe?.(this.goalContext(spec, snap)) }
      catch (error) { if (goalExecutionMode(spec) !== 'native') throw error; this.nativeFault(goal, error); continue }
      if (result?.stopIds.length && this.battleResult?.phase !== 'ended') {
        const program = this.programs.get(goal.ownerId)!
        void this.deps.submit([{ kind: 'stop', unitIds: result.stopIds }], snap, () => this.sessionKey === snap.sessionKey && this.goals.get(spec.id) === goal && program.activeGoalIds.includes(spec.id) && !program.activeGoalIds.some(id => id !== spec.id && this.goals.get(id)?.status === 'active')).catch(error => this.deps.log?.(String(error)))
      }
    }
    // 旧状态恢复时，所有目标可能早已完成；不要保留无活动目标的 active 状态。
    for (const program of this.programs.values()) if (program.status === 'active' && !this.activeSpecs(program).length) program.status = 'idle'
  }
  private complete(goal: GoalState): void {
    goal.status = 'completed'
    const program = this.programs.get(goal.ownerId)
    if (program?.status === 'active' && !this.activeSpecs(program).length) program.status = 'idle'
  }

  async onSnapshot(snap: Snapshot): Promise<void> {
    if (this.retiredSessions.has(snap.sessionKey)) return
    if (snap.sessionKey !== this.sessionKey) {
      if (this.sessionKey) {
        this.retiredSessions.add(this.sessionKey)
        this.cancelAllCommands()
        this.programs.clear(); this.goals.clear(); this.formations.clear()
        this.exploration.clear(); this.skillRuns.clear(); this.coverIdleOrders.clear()
        this.recovery.clear()
        this.factoryRallies.reset()
        this.productionExits.reset(); this.lastUnitOrders.clear()
        this.exitOrders = { seq: -1, ids: new Set() }
        this.production.length = 0; this.handoffs.length = 0; this.seenUnitIds.clear(); this.pausedQueues.clear()
      }
      this.session = snap.session; this.sessionKey = snap.sessionKey
      this.nextProgram = 0
      for (const unit of snap.self) this.seenUnitIds.add(unit.id)
    } else if (this.latest && snap.seq <= this.latest.seq) return
    if (this.latest?.sessionKey !== snap.sessionKey) this.battleResult = undefined
    if (snap.battle?.phase === 'ended') this.battleResult = structuredClone(snap.battle)
    if (this.battleResult?.phase === 'ended') snap = { ...snap, battle: this.battleResult }
    this.latest = snap
    this.observe(snap)
    if (this.battleResult?.phase === 'ended') this.finishBattle()
    if (this.battleResult?.phase !== 'ended') this.syncSkillRuns()
    if (!this.draining) this.draining = this.drain().finally(() => { this.draining = undefined })
    await this.draining
  }

  /** 胜负来自公开玩家状态；停掉调度，不向已结束的对局补发停车或撤销生产。 */
  finishBattle(): void {
    const result = this.battleResult
    if (result?.phase !== 'ended' || !result.outcome) return
    if (this.latest && this.latest.battle !== result) this.latest = { ...this.latest, battle: result }
    this.cancelAllCommands()
    for (const goal of this.goals.values()) {
      if (!['active', 'pending'].includes(goal.status)) continue
      const combat = goal.spec.kind === 'combat' || goal.spec.kind === 'attack'
      goal.status = combat ? result.outcome === 'victory' ? 'completed' : 'failed' : 'partial'
      goal.facts.endedByBattle = result.outcome
      goal.facts.outcomeDetail = `对局${result.outcome === 'victory' ? '胜利' : '失败'}，${combat ? '作战任务结束' : '后续任务停止，保留已完成进度'}`
    }
    for (const program of this.programs.values()) if (program.status !== 'stopped') program.status = 'idle'
    for (const run of this.skillRuns.values()) if (!['completed', 'partial', 'failed', 'cancelled', 'superseded'].includes(run.status)) { run.status = 'partial'; run.detail = '对局已结束，停止后续 Skill 步骤' }
  }

  private async drain(): Promise<void> {
    let consumed: Snapshot | undefined
    while (this.latest && consumed !== this.latest) {
      const snap = this.latest
      if (this.battleResult?.phase === 'ended') { this.finishBattle(); return }
      consumed = snap
      if ([...this.goals.values()].some(goal => ['active', 'pending'].includes(goal.status) && goal.spec.kind === 'production' && (goal.spec.targetType === 7 || goal.spec.targetType === 3))) this.factoryRallies.state.enabled = true
      if (this.productionExits.state.units.some(unit => unit.phase !== 'ready')) this.factoryRallies.state.enabled = true
      if (this.deps.factorySites) {
        try { await this.factoryRallies.poll(snap) }
        catch (error) { this.deps.log?.(`[companion] 集结点设置暂不可用：${String(error).slice(0, 140)}`) }
        if (this.latest !== snap) continue
        this.productionExits.observe(snap, this.factoryRallies.knownSites, this.factoryRallies.state.settings, this.seenUnitIds, this.production, new Set(), !this.exitAllowed(), this.factoryRallies.clear)
        try { await this.advanceProductionExits(snap) }
        catch (error) { this.deps.log?.(`[companion] 出厂交接暂不可用：${String(error).slice(0, 140)}`) }
        if (this.latest !== snap) continue
      }
      if (this.production.some(record => pendingProduction(record) > 0 && this.goals.get(record.goalId)?.facts.cancelProduction)) {
        await this.flushProductionCancellations()
        if (this.latest !== snap) continue
      }
      if (this.handoffs.length) await this.flushHandoffs(snap)
      const programs = [...this.programs.values()]
      const start = this.nextProgram % (programs.length || 1)
      for (let offset = 0; offset < programs.length; offset++) {
        if (this.latest !== snap) break
        const index = (start + offset) % programs.length
        const program = programs[index]!
        if (program.status === 'idle' && program.owner.kind === 'formation' && this.formations.coverOf(program.owner.formationId)) await this.coverStandby(program, snap)
        // 在 await 前交棒；当前计算若被新快照抢占，下一轮也不会从它重新开始。
        this.nextProgram = (index + 1) % programs.length
        if (program.status === 'active') {
          const budget = { remaining: 20 }
          if (this.activeSpecs(program).some(spec => goalExecutionMode(spec) === 'native')) await this.nativeStep(program, snap, budget)
          if (this.latest !== snap) continue
          if (program.status === 'active' && program.script) await this.step(program, snap, budget)
          if (this.latest === snap && program.status === 'active' && !this.hasPendingCommand(program.id)) {
            const frame = this.frame(program, this.activeSpecs(program).filter(spec => goalExecutionMode(spec) === 'script'), snap, true)
            const waiting = new Set(this.handoffs.map(handoff => handoff.goalId))
            for (const goal of frame.snapshot.control!.goals) if (this.goals.get(goal.spec.id)?.facts.placementBlocked || this.goals.get(goal.spec.id)?.facts.rallyBlocked || goal.cover) waiting.add(goal.spec.id)
            const stalled = this.recovery.observe(program.id, this.recoveryKey(program), snap, frame.snapshot.control!.goals, frame.constraints.goals!, waiting)
            if (stalled) this.deps.onProgramStalled?.(program.id, stalled)
          }
        }
        // 每个片段最多访问 8 个对象；剩余对象可在同一快照继续，不丢步、不重复执行。
        if (this.latest === snap && (offset + 1) % 8 === 0 && offset + 1 < programs.length) await new Promise<void>(resolve => setImmediate(resolve))
      }
    }
  }

  private exitAllowed(id?: number): boolean {
    if (['paused', 'stopped'].includes(this.programs.get('global')?.status ?? '')) return false
    if (id === undefined) return true
    const job = this.productionExits.state.units.find(job => job.unitId === id)
    if (job?.halted) return false
    const stamp = this.exitStamp(id)
    return !['paused', 'stopped'].includes(this.programs.get(stamp.owner)?.status ?? '')
  }

  private exitStamp(id: number): Pick<ExitYield, 'owner' | 'revision' | 'generation'> {
    const formation = this.plannedFormationOf(id)
    const owner = formation ? `formation:${formation}` : 'global', program = this.programs.get(owner)
    return { owner, revision: program?.revision ?? 0, generation: program?.generation ?? 0 }
  }

  private sameExitOwner(order: Pick<ExitYield, 'unitId' | 'owner' | 'revision' | 'generation'>): boolean {
    const current = this.exitStamp(order.unitId)
    return this.exitAllowed(order.unitId) && current.owner === order.owner && current.revision === order.revision && current.generation === order.generation
  }

  private canYieldExit(id: number, snap: Snapshot): boolean {
    const unit = snap.self.find(unit => unit.id === id)
    if (!unit || ![3, 7].includes(unit.type) || unit.zone === 1 || unit.harvester || unit.naval || !this.exitAllowed(id) || this.handoffs.some(handoff => handoff.unitIds.includes(id))) return false
    if (!unit.isIdle && !this.productionExits.waiting(id)) return false
    if (snap.enemies.some(enemy => Math.hypot(enemy.rx - unit.rx, enemy.ry - unit.ry) <= Math.max(unit.primaryWeapon?.maxRange ?? 0, unit.secondaryWeapon?.maxRange ?? 0))) return false
    for (const goal of this.goals.values()) {
      const spec = goal.activeSpec
      if (!spec || goal.status !== 'active' || !['mining', 'repair', 'relocate', 'transport', 'deploy'].includes(spec.kind)) continue
      const ids = spec.kind === 'repair' ? this.formations.membersOf(spec.formationId) : spec.kind === 'relocate' ? [spec.unitId] : 'unitIds' in spec ? spec.unitIds : []
      if (ids.includes(id)) return false
    }
    return true
  }

  private exitPointAllowed(id: number, point: { x: number; y: number }): boolean {
    const owner = this.exitStamp(id).owner
    return [...this.goals.values()].every(goal => goal.ownerId !== owner || goal.status !== 'active' || goal.activeSpec?.kind !== 'combat' || inRegion(point.x, point.y, goal.activeSpec.region))
  }

  private async advanceProductionExits(snap: Snapshot): Promise<void> {
    const store = this.productionExits, sites = this.factoryRallies.knownSites
    if (this.exitOrders.seq !== snap.seq) this.exitOrders = { seq: snap.seq, ids: new Set() }
    // 临时让路不改变归属；抵达后只恢复仍属于同一有效任务的动作。
    for (const order of [...store.state.yields]) {
      const unit = snap.self.find(unit => unit.id === order.unitId)
      const validOwner = this.sameExitOwner(order)
      const arrived = unit && Math.hypot(unit.rx - order.point.x, unit.ry - order.point.y) <= 2
      if (unit && validOwner && !arrived && snap.time - order.sentAt < 4) continue
      store.state.yields = store.state.yields.filter(item => item !== order)
      if (!unit || !validOwner || !order.resume || store.waiting(unit.id)) continue
      const goal = this.goals.get(order.resume.goalId)
      if (!goal?.activeSpec || goal.status !== 'active') continue
      const program = this.programs.get(goal.ownerId)
      if (!program || program.status !== 'active') continue
      const item: ScriptAction = { goalId: goal.spec.id, request: order.resume.request }
      const frame = this.frame(program, [goal.activeSpec], snap, true), live = liveScriptActions([item], frame.constraints, frame.snapshot)
      if (!live.length || validateScriptActions(live, frame.constraints, frame.snapshot)) continue
      const results = await this.deps.submit([live[0]!.request as ActionRequest], snap, () => this.latest === snap && this.sameExitOwner(order) && goal.status === 'active' && program.status === 'active')
      if (results.length && results.every(result => result.ok)) this.exitOrders.ids.add(unit.id)
    }
    if (!this.exitAllowed()) return
    let budget = 6
    for (const block of store.state.blockages) {
      if (!this.exitAllowed(block.unitId) || block.state === 'recovered' || block.state === 'unresolved' || block.lastAttempt !== undefined && snap.time - block.lastAttempt < 3) continue
      const factory = sites.find(site => site.id === block.factoryId)
      if (!factory) continue
      if (block.attempts >= 3) { block.state = 'unresolved'; block.detail = '出口疏通已有限尝试3次，仍未恢复；保留产物与目标，等待新命令或障碍变化'; continue }
      const exit = exitPoint(factory)
      const blockers = snap.self.filter(unit => unit.id !== block.unitId && this.canYieldExit(unit.id, snap) && !store.state.yields.some(order => order.unitId === unit.id) && (insideFactory(unit, factory) || Math.hypot(unit.rx - exit.x, unit.ry - exit.y) <= 2))
        .sort((a, b) => Math.hypot(a.rx - exit.x, a.ry - exit.y) - Math.hypot(b.rx - exit.x, b.ry - exit.y)).slice(0, 4)
      block.attempts++; block.lastAttempt = snap.time; block.state = 'clearing'
      block.detail = blockers.length ? `正在疏散${blockers.length}个出口阻挡单位（第${block.attempts}次）` : '没有可让路的己方阻挡者，有限尝试让厂内单位驶向集结点'
      const moved: number[] = []
      for (const blocker of blockers) {
        const point = await this.factoryRallies.point(factory, sites, snap, store.state.yields.map(order => order.point))
        if (!point || !this.exitPointAllowed(blocker.id, point) || this.latest !== snap) continue
        const stamp = this.exitStamp(blocker.id), previous = this.lastUnitOrders.get(blocker.id)
        const resume = previous && previous.owner === stamp.owner && previous.revision === stamp.revision && previous.generation === stamp.generation ? { goalId: previous.goalId, request: structuredClone(previous.request) } : undefined
        const order: ExitYield = { unitId: blocker.id, factoryId: factory.id, point, sentAt: snap.time, ...stamp, ...(resume ? { resume } : {}) }
        store.state.yields.push(order)
        const guard = () => this.latest === snap && this.sameExitOwner(order) && store.state.yields.includes(order) && block.state === 'clearing'
        await this.deps.checkpoint()
        if (!guard()) { store.state.yields = store.state.yields.filter(item => item !== order); continue }
        const result = await this.deps.submit([{ kind: 'move', unitIds: [blocker.id], ...point }], snap, guard)
        if (!result.length || result.some(item => !item.ok)) store.state.yields = store.state.yields.filter(item => item !== order)
        else moved.push(blocker.id)
        if (--budget <= 0) return
      }
      if (!moved.length && !blockers.length) {
        const job = store.state.units.find(unit => unit.unitId === block.unitId)
        if (job?.point && this.exitAllowed(job.unitId)) {
          const stamp = { unitId: job.unitId, ...this.exitStamp(job.unitId) }
          await this.deps.submit([{ kind: 'move', unitIds: [job.unitId], ...job.point }], snap, () => this.latest === snap && this.sameExitOwner(stamp) && store.waiting(job.unitId))
          job.sentAt = snap.time
        }
      }
    }
    for (const job of store.state.units) {
      if (job.phase !== 'rallying' || !job.point || job.halted || store.state.yields.some(order => order.unitId === job.unitId) || !this.exitAllowed(job.unitId) || snap.time - job.progressAt < 3 || job.sentAt !== undefined && snap.time - job.sentAt < 3 || job.attempts >= 3) continue
      const stamp = { unitId: job.unitId, ...this.exitStamp(job.unitId) }
      job.attempts++; job.sentAt = snap.time
      await this.deps.checkpoint()
      const results = await this.deps.submit([{ kind: 'move', unitIds: [job.unitId], ...job.point }], snap, () => this.latest === snap && this.sameExitOwner(stamp) && store.waiting(job.unitId))
      if (job.attempts >= 3) job.detail = '集结受阻，重试已用尽'
      else if (!results.length || results.some(result => !result.ok)) job.detail = '集结移动回执未确认，保留准备状态'
      if (--budget <= 0) break
    }
  }

  private async coverStandby(program: ProgramState, snap: Snapshot): Promise<void> {
    if (program.owner.kind !== 'formation') return
    const formationId = program.owner.formationId, policy = this.formations.coverOf(formationId), revision = this.formations.revision, generation = program.generation
    if (!policy || this.formations.membersOf(formationId).some(id => this.locked(id))) return
    const ids = this.formations.membersOf(formationId), previous = this.coverIdleOrders.get(formationId) ?? emptyCoverMotion()
    if (snap.self.some(unit => ids.includes(unit.id) && unit.isDeployed)) return
    const intent: CoverIntent = { targets: [], threats: snap.enemies, region: { name: '掩护待命', x1: 0, y1: 0, x2: snap.mapWidth - 1, y2: snap.mapHeight - 1 }, waiting: false }
    const ranges = await this.deps.coverRanges?.(coverRangePairs(policy, snap, ids, intent, previous), snap).catch(() => []) ?? []
    const plan = coverCombat(policy, snap, ids, intent, previous, ranges)
    const guard = () => this.latest === snap && this.sessionKey === snap.sessionKey && program.status === 'idle' && program.generation === generation && this.formations.revision === revision && this.formations.coverOf(formationId) === policy
    if (!guard()) return
    this.coverIdleOrders.set(formationId, plan.state)
    for (const request of plan.actions.slice(0, 20)) {
      const results = await this.deps.submit([request], snap, guard)
      if (!guard()) return
      recordCoverOrder(plan.state, request, snap.tick, results)
    }
  }

  private async coverActions(spec: GoalSpec, snap: Snapshot): Promise<ActionRequest[] | undefined> {
    if ((spec.kind !== 'combat' && spec.kind !== 'attack') || !spec.formationId) return undefined
    const policy = this.formations.coverOf(spec.formationId)
    if (!policy) return undefined
    const goal = this.goals.get(spec.id)!, projected = this.project(spec, snap), ids = projected.constraints.allowedUnitIds
    // 基地防守无入侵者时全队原地待命，不由掩护待命流程追加站位移动。
    if (spec.kind === 'combat' && spec.baseDefense && !projected.constraints.enemyIds.length) return undefined
    const previous = goal.facts.coverMotion ?? emptyCoverMotion()
    if (spec.kind === 'combat' && goal.facts.retreatTriggered && spec.retreat) {
      const plan = coverMoves(policy, snap, ids, spec.retreat, previous, { directDestination: true })
      goal.facts.coverMotion = plan.state
      return plan.actions
    }
    const targetRegion = projected.constraints.targetRegion ?? attackObjective(spec)?.target.region
    const threats = snap.enemies.filter(unit => !targetRegion || inTargetRegion(unit.rx, unit.ry, targetRegion))
    let targets = snap.enemies.filter(unit => projected.constraints.enemyIds.includes(unit.id))
    if (spec.kind === 'combat' && !spec.allowedActions.includes('attack')) targets = []
    if (spec.kind === 'combat' && spec.patrol) targets = targets.filter(target => snap.self.some(unit => ids.includes(unit.id) && Math.hypot(unit.rx - target.rx, unit.ry - target.ry) <= Math.max(unit.primaryWeapon?.maxRange ?? 0, unit.secondaryWeapon?.maxRange ?? 0) + policy.gap))
    const intent: CoverIntent = {
      targets, threats, region: projected.constraints.region!,
      destination: spec.kind === 'combat' ? spec.route?.[goal.facts.routeIndex ?? 0] ?? spec.destination : attackObjective(spec)?.search.destination,
      waiting: !policy.escortIds.some(id => snap.self.some(unit => unit.id === id)) && (policy.escortSources ?? []).some(source => ['pending', 'active'].includes(this.goals.get(source.goalId)?.status ?? '')),
    }
    const ranges = await this.deps.coverRanges?.(coverRangePairs(policy, snap, ids, intent, previous), snap).catch(() => []) ?? []
    const plan = coverCombat(policy, snap, ids, intent, previous, ranges)
    if (this.latest === snap && this.formations.coverOf(spec.formationId) === policy) goal.facts.coverMotion = plan.state
    return plan.actions
  }

  private async flushHandoffs(snap: Snapshot): Promise<void> {
    if (!this.handoffs.length) return
    try { await this.deps.checkpoint() }
    catch (err) {
      for (const handoff of this.handoffs) {
        const goal = this.goals.get(handoff.goalId)
        if (goal) goal.facts.blocked = `交接记录保存失败: ${String(err).slice(0, 100)}`
      }
      return
    }
    for (const handoff of [...this.handoffs]) {
      const guard = () => this.sessionKey === snap.sessionKey && this.handoffs.includes(handoff) && handoff.owners.every(([id, owner]) => (this.formations.ownerOf(id) ?? null) === owner)
      const ids = handoff.unitIds.filter(id => snap.self.some(u => u.id === id))
      if (ids.some(id => this.productionExits.locked(id))) {
        const goal = this.goals.get(handoff.goalId)
        if (goal) goal.facts.blocked = '等待新造成员抵达集结点后交接，未发送停车指令'
        continue
      }
      try {
        const results = ids.length ? await this.deps.submit([{ kind: 'stop', unitIds: ids }], snap, guard) : [{ ok: true }]
        if (guard() && results.length && results.every(r => r.ok)) {
          this.handoffs.splice(this.handoffs.indexOf(handoff), 1)
          const goal = this.goals.get(handoff.goalId)
          if (goal) {
            delete goal.facts.blocked
            if (goal.status !== 'cancelled' && goal.spec.kind === 'formation') {
              const run = goal.spec.cover && this.skillRuns.get(goal.spec.cover.runId)
              if (goal.spec.cover && (!run || ['preparing', 'covering'].includes(run.status))) this.setCover(goal.spec.request.formationId, goal.spec.cover)
              this.complete(goal)
            }
          }
        } else if (this.goals.get(handoff.goalId)) this.goals.get(handoff.goalId)!.facts.blocked = '成员交接停车尚未确认'
      } catch (err) { if (this.goals.get(handoff.goalId)) this.goals.get(handoff.goalId)!.facts.blocked = `成员交接失败: ${String(err).slice(0, 120)}` }
    }
  }

  private async manage(goal: GoalState, request: FormationRequest, snap: Snapshot): Promise<void> {
    if (this.handoffs.some(h => h.goalId === goal.spec.id)) return
    if (request.kind !== 'dissolveFormation' && request.unitIds.some(id => this.productionExits.locked(id))) return
    let ids: number[]
    if (request.kind === 'createFormation') {
      const result = this.formations.create(request.formationId, request.unitIds, { force: !!request.force })
      if (!result.ok) throw new Error(result.reason)
      ids = request.unitIds
    } else if (request.kind === 'transferUnits') {
      const result = this.formations.transfer(request.unitIds, request.formationId)
      if (!result.ok) throw new Error(result.reason)
      ids = request.unitIds
    } else {
      ids = [...this.formations.membersOf(request.formationId)]
      for (const run of this.skillRuns.values()) if (run.kind === 'cover' && run.formationId === request.formationId && ['preparing', 'covering'].includes(run.status)) await this.cancelSkillRun(run.id, true)
      // 明确解散后，独立生产继续但不再重建这个队。掩护自身新增的准备已在上面取消。
      for (const pending of this.goals.values()) if (pending.spec.kind === 'production' && pending.spec.formationId === request.formationId && ['pending', 'active'].includes(pending.status)) {
        delete pending.spec.formationId
        if (pending.activeSpec?.kind === 'production') delete pending.activeSpec.formationId
        const producing = this.programs.get(pending.ownerId)
        if (producing) { producing.revision++; this.cancelCommand(producing.id) }
      }
      const program = this.programs.get(ownerId({ kind: 'formation', formationId: request.formationId }))
      if (program) {
        this.cancelCommand(program.id)
        program.generation++; program.status = 'stopped'
        for (const id of [...program.activeGoalIds, ...program.goalIds]) { const g = this.goals.get(id); if (g) { g.status = 'cancelled'; g.facts.cancelReason = `编队 ${request.formationId} 已解散` } }
        program.activeGoalIds = []; program.goalIds = []
      }
      this.formations.dissolve(request.formationId)
    }
    this.handoffs.push({ goalId: goal.spec.id, unitIds: [...ids], owners: ids.map(id => [id, this.formations.ownerOf(id) ?? null]) })
    await this.flushHandoffs(snap)
  }

  private async fault(program: ProgramState, error: string, snap: Snapshot): Promise<void> {
    this.recovery.trace(program.id, this.recoveryKey(program), snap.tick, { kind: 'error', error })
    program.stats.errors++; program.stats.lastError = error
    if (program.stats.errors < 3) return
    program.status = 'paused'; program.generation++
    const ids = this.activeSpecs(program).filter(spec => goalExecutionMode(spec) === 'script').flatMap(g => this.goalConstraints(g, snap).allowedUnitIds)
    if (ids.length) await this.deps.submit([{ kind: 'stop', unitIds: [...new Set(ids)] }], snap, () => program.status === 'paused' && this.programs.get(program.id) === program && this.sessionKey === snap.sessionKey)
    if (program.status === 'paused' && this.programs.get(program.id) === program && !this.hasPendingCommand(program.id)) this.deps.onProgramFaulted?.(program.id)
  }

  private nativeFault(goal: GoalState, error: unknown): void {
    goal.facts.nativeError = String(error).slice(0, 300)
    this.deps.log?.(`[runtime] ${goal.spec.id} 本机执行出错：${goal.facts.nativeError}`)
  }

  private async nativeStep(program: ProgramState, snap: Snapshot, budget: { remaining: number }): Promise<void> {
    const generation = program.generation, formationRevision = this.formations.revision
    const valid = () => this.programs.get(program.id) === program && program.status === 'active' && program.generation === generation && this.sessionKey === snap.sessionKey && this.latest === snap && this.formations.revision === formationRevision
    const specs = this.activeSpecs(program).filter(spec => goalExecutionMode(spec) === 'native')
    // 混合对象给脚本保留一半预算；未发送的固定步骤下步仍由真实事实提出。
    let available = this.activeSpecs(program).some(spec => goalExecutionMode(spec) === 'script') ? Math.floor(budget.remaining / 2) : budget.remaining
    for (const spec of specs) {
      if (!valid() || available <= 0) return
      const goal = this.goals.get(spec.id)!
      if (goal.facts.nativeError) continue
      try {
        const requests = await this.coverActions(spec, snap) ?? handlerFor(spec).nativeActions!(this.goalContext(spec, snap))
        const actions = requests.slice(0, available).map(request => ({ goalId: spec.id, request }))
        const before = budget.remaining
        await this.submitActions(program, snap, actions, 'native', valid, budget)
        available -= before - budget.remaining
      } catch (error) { this.nativeFault(goal, error) }
    }
  }

  private async step(program: ProgramState, snap: Snapshot, budget: { remaining: number }): Promise<void> {
    const script = program.script!
    const generation = program.generation
    const formationRevision = this.formations.revision
    const authorized = () => this.programs.get(program.id) === program && program.status === 'active' && program.generation === generation && program.script === script && this.sessionKey === snap.sessionKey
    const valid = () => authorized() && this.latest === snap && formationRevision === this.formations.revision
    const specs = this.activeSpecs(program).filter(spec => goalExecutionMode(spec) === 'script')
    if (!specs.length || !budget.remaining) return
    if (program.owner.kind === 'formation' && this.formations.coverOf(program.owner.formationId) && specs.every(spec => spec.kind === 'combat' || spec.kind === 'attack' && !spec.aircraftIds.length)) {
      for (const spec of specs) {
        const actions = (await this.coverActions(spec, snap) ?? []).map(request => ({ goalId: spec.id, request }))
        if (!await this.submitActions(program, snap, actions, 'script', valid, budget)) return
      }
      return
    }
    const frame = this.frame(program, specs, snap, true)
    for (const spec of specs) {
      if (spec.kind !== 'combat' || this.goals.get(spec.id)!.facts.retreatTriggered) continue
      const outside = snap.self.filter(u => frame.constraints.goals![spec.id]!.allowedUnitIds.includes(u.id) && !inRegion(u.rx, u.ry, spec.region))
      if (outside.length) {
        const region = spec.region
        await this.deps.submit([{ kind: 'stop', unitIds: outside.map(u => u.id) }, ...outside.map(u => ({ kind: 'move' as const, unitIds: [u.id], x: Math.max(region.x1, Math.min(region.x2, u.rx)), y: Math.max(region.y1, Math.min(region.y2, u.ry)) }))], snap, valid)
        return
      }
    }
    const outcome = await this.deps.executor.run(script.code, frame.snapshot, program.memory, frame.constraints)
    if (!valid()) return
    program.stats.steps++
    this.recovery.trace(program.id, this.recoveryKey(program), snap.tick, { kind: 'script', actions: outcome.actions, ...(!outcome.ok ? { error: outcome.error } : {}) })
    if (!outcome.ok) { await this.fault(program, outcome.error ?? '执行失败', snap); return }
    outcome.actions = liveScriptActions(outcome.actions, frame.constraints, frame.snapshot)
    const outputError = validateScriptActions(outcome.actions, frame.constraints, frame.snapshot)
    if (outputError) { await this.fault(program, outputError, snap); return }
    if (!await this.submitActions(program, snap, outcome.actions, 'script', valid, budget)) return
    if (authorized()) { program.memory = outcome.memory; program.stats.errors = 0 }
  }
  /** 两种动作来源只在这里接入游戏；预算、即时校验、台账和回执共享。 */
  private async submitActions(program: ProgramState, snap: Snapshot, actions: ScriptAction[], mode: 'script' | 'native', valid: () => boolean, budget: { remaining: number }): Promise<boolean> {
    let deferred = false
    const failure = async (goal: GoalState, error: string) => {
      if (mode === 'native') this.nativeFault(goal, error)
      else await this.fault(program, error, snap)
    }
    for (const item of actions) {
      if (!valid() || !budget.remaining) return false
      const goal = this.goals.get(item?.goalId)
      // 单目标取消/完成不使其他目标失效，也不把陈旧引用当作脚本异常。
      if (!goal || goal.ownerId !== program.id || goal.status !== 'active' || !goal.activeSpec || !program.activeGoalIds.includes(item.goalId) || goalExecutionMode(goal.activeSpec) !== mode || goal.facts.nativeError) continue
      const activeSpec = goal.activeSpec
      const fresh = this.frame(program, [activeSpec], snap, true)
      const live = liveScriptActions([item], fresh.constraints, fresh.snapshot)[0]
      if (!live) continue
      item.request = live.request
      const error = validateScriptActions([item], fresh.constraints, fresh.snapshot)
      if (error) { await failure(goal, error); return false }
      budget.remaining--
      const request = item.request
      if (request.kind === 'createFormation' || request.kind === 'transferUnits' || request.kind === 'dissolveFormation') {
        try { await this.manage(goal, request, snap); program.stats.actions++; program.stats.errors = 0 }
        catch (err) { goal.facts.blocked = String(err); await failure(goal, String(err)) }
        // 管理请求改变成员修订，下一步用最新归属重新执行。
        return false
      }
      let record: ProductionRecord | undefined
      if (request.kind === 'produce') {
        if (this.deps.factorySites) {
          try {
            const checked = await this.factoryRallies.beforeProduction(fresh.constraints.goals![item.goalId]!.productionQueueTypes![request.name]!, snap, () => valid() && goal.status === 'active' && goal.activeSpec === activeSpec)
            if (!valid() || goal.status !== 'active' || goal.activeSpec !== activeSpec) return false
            if (!checked.ok) { goal.facts.rallyBlocked = true; goal.facts.blocked = checked.reason ?? '等待可用集结点后生产'; deferred = true; continue }
            if (goal.facts.rallyBlocked) { delete goal.facts.rallyBlocked; delete goal.facts.blocked }
          } catch (error) {
            if (!valid() || goal.status !== 'active' || goal.activeSpec !== activeSpec) return false
            goal.facts.rallyBlocked = true; goal.facts.blocked = `生产前集结点检查未完成：${String(error).slice(0, 120)}`; deferred = true; continue
          }
        }
        const spec = goal.activeSpec
        // 同一句话明确要求的建筑也可能先被其他目标当作前置生产；统一记到该建设目标，避免换代码后再造一遍。
        const target = spec.kind === 'production' && request.name !== spec.target ? [...this.goals.values()].find(candidate => {
          const desired = candidate.activeSpec ?? candidate.spec
          return !['cancelled', 'completed', 'partial', 'failed'].includes(candidate.status) && desired.kind === 'production' && !desired.maintainPower && !desired.placement && !desired.placementRegion && !desired.afterGoalId && desired.target === request.name
            && (productionProgress(desired, this.production, snap).remaining[request.name] ?? 0) >= request.quantity
        }) : undefined
        record = { id: randomUUID(), goalId: target?.spec.id ?? item.goalId, name: request.name, quantity: request.quantity, building: spec.kind === 'production' && (request.name !== spec.target || spec.targetType === 2), queueType: fresh.constraints.goals![item.goalId]!.productionQueueTypes![request.name]!, state: 'reserved', observedIds: [], placed: false }
        const ownerSpec = target?.activeSpec ?? target?.spec ?? spec
        if (ownerSpec.kind === 'production' && ownerSpec.target === request.name && ownerSpec.placementRegion) record.placementRegion = structuredClone(ownerSpec.placementRegion)
        if (ownerSpec.kind === 'production' && ownerSpec.target === request.name && ownerSpec.placement) {
          const submitted = this.production.filter(r => r.goalId === record!.goalId && r.name === request.name && r.state !== 'rejected').reduce((n, r) => n + r.quantity, 0)
          record.placement = { anchor: structuredClone(ownerSpec.placement.anchor), directions: Array.from({ length: request.quantity }, (_, n) => ownerSpec.placement!.directions[Math.min(submitted + n, ownerSpec.placement!.directions.length - 1)]!) }
          const base = ownerSpec.afterGoalId ? this.goals.get(ownerSpec.afterGoalId)?.facts.relocation : undefined
          if (base && ownerSpec.placement.anchor.name === '基地') record.placement.anchor = { ...base.position, name: '基地' }
        }
        this.production.push(record)
        try { await this.deps.checkpoint() }
        catch (err) { record.state = 'rejected'; goal.facts.blocked = `生产预留保存失败: ${String(err)}`; return false }
        if (!valid() || goal.status !== 'active') { record.state = 'rejected'; return false }
      }
      const guard = () => valid() && goal.status === 'active' && this.goals.get(item.goalId) === goal && goal.activeSpec === activeSpec
      let phase: 'prepare' | 'submit' | 'receipt' = 'prepare'
      try {
        const handler = handlerFor(activeSpec)
        handler.beforeSubmit?.(this.goalContext(goal.activeSpec, snap), request)
        phase = 'submit'
        const results = await this.deps.submit([request], snap, guard)
        if ('unitIds' in request && ['move', 'attackMove', 'attack', 'guard'].includes(request.kind) && results.length && results.every(result => result.ok)) {
          for (const unitId of request.unitIds) this.lastUnitOrders.set(unitId, { goalId: item.goalId, request: { ...request, unitIds: [unitId] }, owner: program.id, revision: program.revision, generation: program.generation })
        }
        if (goal.facts.coverMotion) recordCoverOrder(goal.facts.coverMotion, request, snap.tick, results)
        phase = 'receipt'
        if (handler.afterSubmit?.(this.goalContext(goal.activeSpec, snap), request, results)) continue
        if (mode === 'script') this.recovery.trace(program.id, this.recoveryKey(program), snap.tick, { goalId: item.goalId, request, results })
        if (request.kind === 'place' && results.length && results.every(result => !result.ok && result.submitted === 0 && ['no-spot', 'cannot-place'].includes(result.reason ?? ''))) {
          goal.facts.placementBlocked = true
          goal.facts.blocked = request.placement ? `${request.name} 在${request.placement.anchor.name ?? '参照点'}${directionLabels[request.placement.direction]}暂无合法位置，保留就绪建筑并继续尝试该方向` : `${request.name} 暂无可放置位置，保留就绪建筑并继续重试`
          program.stats.rejected++
          continue
        }
        if (request.kind !== 'produce' && results.some(result => !result.ok && ['invisible-target', 'invalid-units', 'stale-snapshot', 'stale-session'].includes(result.reason ?? ''))) continue
        if (!results.length || results.some(r => !r.ok)) {
          const notSent = !results.length || results.every(r => !r.ok && r.submitted === 0 && ['stale-session', 'stale-snapshot', 'revoked-or-no-snapshot', 'no-api'].includes(r.reason ?? ''))
          if (record) record.state = notSent ? 'rejected' : 'unknown'
          goal.facts.blocked = notSent ? '动作未发送' : '提交结果不确定，保留记录'
          program.stats.rejected++
          return false
        }
        if (record) record.state = 'submitted'
        if (request.kind === 'pauseQueue' && snap.production?.queues.some(q => q.type === request.queueType && q.status !== 2)) this.pausedQueues.set(request.queueType, item.goalId)
        if (request.kind === 'resumeQueue') this.pausedQueues.delete(request.queueType)
        delete goal.facts.blocked
        delete goal.facts.placementBlocked
        program.stats.actions++
      } catch (err) {
        if (mode === 'script') this.recovery.trace(program.id, this.recoveryKey(program), snap.tick, { goalId: item.goalId, request, error: String(err) })
        if (record) record.state = 'unknown'
        if (mode === 'native' && phase !== 'submit') { this.nativeFault(goal, err); return false }
        goal.facts.blocked = `提交结果不确定: ${String(err).slice(0, 120)}`
        return false
      }
    }
    return !deferred
  }

}
