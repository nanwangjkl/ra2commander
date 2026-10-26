import { randomUUID } from 'node:crypto'
import {
  validateScriptActions, liveScriptActions, inRegion, inTargetRegion, goalOwner, ownerId,
  type ActionRequest, type ActionResult, type ActionContext, type Snapshot, type StepConstraints,
  type GoalConstraints, type GoalSpec, type GoalView, type ScriptOwner, type FormationRequest, type GoalExecution,
} from '@ra2c/contracts'
import { codeHash, type StepExecutor } from '@ra2c/js-worker'
import { FormationRegistry } from './formation.ts'
import { emptyFacts, type GoalState, type ProgramState, type ProductionRecord, type Handoff } from './state.ts'
import { observeProduction, productionProgress } from './production-progress.ts'
import { assessArrival } from './arrival.ts'
import { planRepairs, emptyRepairState } from './repair.ts'
import { ExplorationStore, skillGoalIds, type SkillRun } from './exploration.ts'
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
  goals: GoalSpec[]
}
export interface RuntimeDeps {
  executor: Pick<StepExecutor, 'run'>
  submit: (actions: ActionRequest[], context: ActionContext, guard: () => boolean) => Promise<ActionResult[]>
  formations?: FormationRegistry
  /** 必须成功完成持久化才允许发送非幂等生产请求。 */
  checkpoint: () => void | Promise<void>
  onProgramFaulted?: (ownerId: string) => void
  log?: (message: string) => void
}

export class TaskRuntime {
  session = -1
  private sessionKey = ''
  private retiredSessions = new Set<string>()
  private latest?: Snapshot
  private draining: Promise<void> | undefined
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

  constructor(private readonly deps: RuntimeDeps) { this.formations = deps.formations ?? new FormationRegistry() }
  get battleKey(): string { return this.sessionKey }
  get snapshot(): Snapshot | undefined { return this.latest }
  hasPendingCommand(id: string): boolean { return this.pending.has(id) }
  pendingCommandIds(): string[] { return [...this.pending.keys()] }
  hasPlannedFormation(id: string): boolean {
    return [...this.goals.values()].some(goal => !['cancelled', 'completed', 'partial', 'failed'].includes(goal.status) && (
      goal.spec.kind === 'formation' && goal.spec.request.kind === 'createFormation' && goal.spec.request.formationId === id && goal.spec.request.unitIds.some(unit => this.latest?.self.some(item => item.id === unit))
      || goal.spec.kind === 'production' && goal.spec.formationId === id))
  }

  /** 提供已有执行事实的精简视图；不改变目标，也不把动作提交当作完成。 */
  goalExecution(id: string): GoalExecution | undefined {
    const goal = this.goals.get(id)
    if (!goal) return undefined
    if (goal.status === 'partial' || goal.status === 'failed') {
      const exploration = this.explorationExecution(goal.spec)
      return { ...exploration, state: goal.status, detail: [goal.facts.outcomeDetail ?? '探索未全部完成', exploration.detail].filter(Boolean).join('；') }
    }
    if (goal.status === 'completed') return { state: 'completed', ...this.explorationExecution(goal.spec), ...(goal.spec.kind === 'combat' && goal.spec.route ? { progress: { completed: goal.spec.route.length, total: goal.spec.route.length, label: '已到达路点' } } : {}) }
    if (goal.status === 'cancelled') return { state: 'cancelled', detail: goal.facts.cancelReason ?? '目标已取消或被替换' }
    const program = this.programs.get(goal.ownerId)
    const spec = goal.activeSpec
    if (!spec && goal.status === 'pending' && goal.facts.completedQuantity !== undefined) return { state: 'completed', detail: `前次${goal.facts.completedQuantity}个已完成，新增总量待生效` }
    if (!spec || !program?.activeGoalIds.includes(id) || !this.latest) return program?.status === 'paused' ? { state: 'paused', detail: '目标保留，脚本已暂停' } : undefined
    if (program.status === 'paused') return program.stats.errors >= 3 && program.stats.lastError
      ? { state: 'faulted', detail: `脚本运行出错，已暂停：${program.stats.lastError}` } : { state: 'paused', detail: '脚本已暂停' }
    if (program.status === 'stopped') return { state: 'cancelled', detail: '脚本已停止' }
    const view = this.frame(program, [spec], this.latest).snapshot.control!.goals[0]!
    const progress = spec.kind === 'explore' ? this.explorationExecution(spec).progress : spec.kind === 'production' && !spec.maintainPower
      ? { completed: Math.min(spec.quantity, view.observed[spec.target]?.length ?? 0), total: spec.quantity }
      : spec.kind === 'combat' && spec.route ? { completed: goal.facts.routeIndex ?? 0, total: spec.route.length, label: '已到达路点' } : undefined
    const detail = view.blocked ?? (view.uncertain.length ? `提交结果待确认：${view.uncertain.join('、')}` : undefined)
    if (detail) return { state: 'blocked', detail, ...(progress ? { progress } : {}) }
    const continuous = (spec.kind === 'production' && !!spec.maintainPower) || spec.kind === 'reinforce' || (spec.kind === 'combat' && (spec.mode === 'hold' || spec.mode === 'assault' || (!spec.destination && !spec.attackRegion)))
    if (spec.kind === 'repair' && view.repair) {
      const r = view.repair
      return { state: r.readyIds.length ? 'continuous' : 'running', ...(spec.quantity ? { progress: { completed: r.readyIds.length, total: spec.quantity, label: '已组装维修车' } } : {}), detail: `${r.waiting ? '等待组件生产及交接；' : ''}已组装${r.readyIds.length}辆；${r.assembling.length}组正在上车；${r.targets.length}辆分头维修，受损坦克${r.damaged.length}辆${!r.targets.length && r.readyIds.length ? '，待命中' : ''}` }
    }
    return { ...this.explorationExecution(spec), state: continuous ? 'continuous' : 'running', ...(progress ? { progress } : {}), ...(spec.kind === 'combat' && spec.route && view.spec.kind === 'combat' ? { detail: `当前目的地：${view.spec.destination?.name ?? `${view.spec.destination?.x},${view.spec.destination?.y}`}` } : {}) }
  }

  private explorationExecution(spec: GoalSpec): Pick<GoalExecution, 'progress' | 'detail'> {
    if (spec.kind !== 'explore' || !this.exploration.progress.has(spec.explorationId)) return {}
    const view = this.exploration.view(spec)
    const unfinished = view.regions.filter(region => !region.satisfied), threshold = Math.round(view.coverageRatio * 100)
    return { progress: { completed: view.regions.length - unfinished.length, total: view.regions.length, label: `分区达标（每区≥${threshold}%）` },
      detail: unfinished.length ? `未达标：${unfinished.map(region => `${region.name} ${region.total ? Math.floor(region.seen * 1000 / region.total) / 10 : 0}%`).join('、')}` : `全部目标分区覆盖均已达到${threshold}%` }
  }

  async cancelSkillRun(id: string, superseded = false): Promise<void> {
    const run = this.skillRuns.get(id)
    if (!run || !['preparing', 'exploring', 'repairing'].includes(run.status)) return
    run.status = superseded ? 'superseded' : 'cancelled'
    run.detail = superseded ? '编队已接受新命令，停止原 Skill 后续步骤' : '玩家取消 Skill；已进入游戏队列的生产不回退'
    await Promise.all(skillGoalIds(run).map(goalId => {
      const goal = this.goals.get(goalId)
      return goal && !['completed', 'partial', 'failed', 'cancelled'].includes(goal.status) ? this.cancelGoal(goalId, run.detail) : Promise.resolve()
    }))
  }

  private syncSkillRuns(): void {
    for (const run of this.skillRuns.values()) {
      if (!['preparing', 'exploring', 'repairing'].includes(run.status)) continue
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

  private observeExploration(snap: Snapshot): void {
    for (const goal of this.goals.values()) {
      const spec = goal.activeSpec
      if (goal.status !== 'active' || spec?.kind !== 'explore') continue
      const status = this.programs.get(goal.ownerId)?.status
      if (status === 'paused') { this.exploration.suspend(spec.explorationId, snap.tick); continue }
      if (status !== 'active') continue
      const preparation = spec.preparationGoalId && this.goals.get(spec.preparationGoalId)
      const members = this.formations.membersOf(spec.formationId).filter(id => !this.locked(id))
      const waiting = !!preparation && !['completed', 'partial', 'failed', 'cancelled'].includes(preparation.status) || this.handoffs.some(h => h.unitIds.some(id => this.formations.ownerOf(id) === spec.formationId))
      const result = this.exploration.advance(spec, snap, members, waiting)
      if (!result) continue
      goal.status = result.state; goal.facts.done = true; goal.facts.outcomeDetail = result.detail
      const program = this.programs.get(goal.ownerId)!
      if (!this.activeSpecs(program).length) program.status = 'idle'
      const ids = snap.self.filter(unit => members.includes(unit.id)).map(unit => unit.id)
      if (ids.length) void this.deps.submit([{ kind: 'stop', unitIds: ids }], snap, () => this.sessionKey === snap.sessionKey && this.goals.get(spec.id) === goal && program.activeGoalIds.includes(spec.id) && !program.activeGoalIds.some(id => id !== spec.id && this.goals.get(id)?.status === 'active')).catch(error => this.deps.log?.(String(error)))
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

  private validateGoal(goal: GoalSpec): void {
    if (!goal.id || !goal.rawText || !this.latest) throw new Error('目标缺少 ID、命令或当前对局')
    const snap = this.latest
    const point = (x: number, y: number) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < snap.mapWidth && y < snap.mapHeight
    if (goal.kind === 'repair') {
      if (!this.formations.list().some(f => f.id === goal.formationId) && !this.hasPlannedFormation(goal.formationId)) throw new Error('维修编队不存在或尚无准备目标')
      if (!goal.vehicleNames.length || !goal.engineerNames.length || !goal.tankNames.length || !Number.isSafeInteger(goal.policy.retryTicks) || goal.policy.retryTicks < 1 || !Number.isSafeInteger(goal.policy.stallTicks) || goal.policy.stallTicks <= goal.policy.retryTicks) throw new Error('维修目标参数非法')
      if (goal.followFormationId === goal.formationId || (goal.followFormationId && !this.formations.list().some(f => f.id === goal.followFormationId))) throw new Error('被支援编队不存在或与维修队相同')
    } else if (goal.kind === 'transport') {
      if (!goal.unitIds.length || goal.unitIds.some(id => !snap.self.some(unit => unit.id === id && unit.type === 3) || this.formations.ownerOf(id)) || !snap.self.some(unit => unit.id === goal.transportId && unit.transport && unit.transport.capacity > unit.transport.occupied)) throw new Error('上车成员或载具不可用')
    } else if (goal.kind === 'explore') {
      if (!this.formations.list().some(f => f.id === goal.formationId) && !this.hasPlannedFormation(goal.formationId)) throw new Error('探索编队不存在或尚无准备目标')
      if (!this.exploration.progress.has(goal.explorationId)) throw new Error('探索范围不存在')
      if (goal.explorationId !== goal.id || [goal.policy.pointSpacing, goal.policy.stallTicks, goal.policy.maxStallsPerRegion].some(value => !Number.isSafeInteger(value) || value < 1) || (goal.policy.coverageRatio !== undefined && (!Number.isFinite(goal.policy.coverageRatio) || goal.policy.coverageRatio <= 0 || goal.policy.coverageRatio > 1))) throw new Error('探索策略非法')
      if ([goal.policy.interiorMargin, goal.policy.retryPasses].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) throw new Error('探索内缩与重试参数非法')
      if (goal.policy.centerFirst !== undefined && typeof goal.policy.centerFirst !== 'boolean') throw new Error('探索中心优先参数非法')
    } else if (goal.kind === 'combat') {
      if (!this.formations.list().some(f => f.id === goal.formationId) && !this.hasPlannedFormation(goal.formationId)) throw new Error('编队不存在，请先建队')
      const r = goal.region
      if (!r || !point(r.x1, r.y1) || !point(r.x2, r.y2) || r.x1 > r.x2 || r.y1 > r.y2) throw new Error('授权地域非法')
      if (goal.route && (!goal.route.length || goal.route.some(stop => !point(stop.x, stop.y)))) throw new Error('路线目的地非法')
      if (goal.retreat && (!point(goal.retreat.x, goal.retreat.y) || !Number.isFinite(goal.retreat.lossAbove) || goal.retreat.lossAbove < 0 || goal.retreat.lossAbove >= 1)) throw new Error('回撤条件非法')
    } else if (goal.kind === 'deploy') {
      if (!goal.unitIds.length || goal.unitIds.some(id => !snap.self.some(u => u.id === id && u.canDeploy))) throw new Error('没有可展开的基地车')
    } else if (goal.kind === 'production') {
      if (!/^[A-Za-z0-9_]+$/.test(goal.target) || !Number.isSafeInteger(goal.quantity) || goal.quantity < 1 || goal.queues.some(q => !Number.isInteger(q) || q < 0 || q > 5)) throw new Error('生产目标非法')
      if (goal.maintainPower && (!Number.isFinite(goal.maintainPower.reserve) || goal.maintainPower.reserve < 0 || !Number.isFinite(goal.maintainPower.output) || goal.maintainPower.output <= 0)) throw new Error('补电参数非法')
    } else if (goal.kind === 'formation') {
      const r = goal.request
      if (!r.formationId) throw new Error('缺少编队名')
      const exists = this.formations.list().some(f => f.id === r.formationId)
      if (r.kind === 'createFormation' && exists) throw new Error('编队已存在')
      if (r.kind !== 'createFormation' && !exists) throw new Error('目标编队不存在')
      if (r.kind !== 'dissolveFormation') {
        if (!r.unitIds.length || new Set(r.unitIds).size !== r.unitIds.length || r.unitIds.some(id => !Number.isSafeInteger(id) || !snap.self.some(u => u.id === id))) throw new Error('编队成员非法或已消失')
        if (r.kind === 'createFormation' && !r.force && r.unitIds.some(id => this.formations.ownerOf(id))) throw new Error('成员已属于其他编队，明确转编或使用 --force')
      }
    } else if (goal.kind === 'reinforce') {
      if (!Number.isSafeInteger(goal.targetSize) || goal.targetSize < 1 || goal.source === goal.formationId || !this.formations.list().some(f => f.id === goal.formationId) || (goal.source !== null && !this.formations.list().some(f => f.id === goal.source))) throw new Error('补员目标或来源非法')
    } else if (goal.kind === 'rally' && (!point(goal.x, goal.y) || !goal.unitIds.length)) throw new Error('集结目标非法')
  }

  upsertGoal(spec: GoalSpec): string {
    if (spec.kind === 'rally') spec = { ...spec, unitIds: [...new Set(spec.unitIds)].filter(id => !this.formations.ownerOf(id) && this.latest?.self.some(u => u.id === id)) }
    this.validateGoal(spec)
    if (spec.kind === 'formation' && !spec.sourceOwners) {
      const ids = spec.request.kind === 'dissolveFormation' ? this.formations.membersOf(spec.request.formationId) : spec.request.unitIds
      spec = { ...spec, sourceOwners: ids.map(id => [id, this.formations.ownerOf(id) ?? null]) }
    }
    const owner = goalOwner(spec)
    const program = this.program(owner)
    const old = this.goals.get(spec.id)
    if (old && (spec.kind === 'combat' || spec.kind === 'explore' || spec.kind === 'repair') && (old.status !== 'pending' || old.activeSpec || old.spec.rawText !== spec.rawText)) throw new Error('编队新命令应使用新的目标 ID')
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
      old.facts.done = false
    } else this.goals.set(spec.id, { ownerId: program.id, spec: structuredClone(spec), status: 'pending', facts: emptyFacts() })
    if (owner.kind === 'formation') {
      for (const id of program.goalIds) if (id !== spec.id && !program.activeGoalIds.includes(id)) {
        const previous = this.goals.get(id)!
        previous.status = 'cancelled'; previous.facts.cancelReason = `已被后续命令替换：${spec.rawText}`
      }
      program.goalIds = [spec.id]
    }
    else if (!program.goalIds.includes(spec.id)) program.goalIds.push(spec.id)
    program.revision++
    delete program.compileError
    this.cancelCommand(program.id)
    return program.id
  }

  beginCompile(id: string, repair = false): CompileLease {
    const program = this.programs.get(id)
    if (!program || !this.latest || this.latest.sessionKey !== this.sessionKey) throw new Error('没有有效控制对象或对局')
    if (repair && program.status !== 'paused') throw new Error('脚本不处于暂停态')
    this.cancelCommand(id)
    const abort = new AbortController()
    const goals = program.goalIds.map(g => this.goals.get(g)!).filter(g => g && !['cancelled', 'completed', 'partial', 'failed'].includes(g.status)).map(g => structuredClone(g.spec))
    const lease: CompileLease = { ownerId: id, sessionKey: this.sessionKey, revision: program.revision, formationRevision: this.formations.revision, signal: abort.signal, repair, goals }
    this.pending.set(id, { lease, abort })
    return lease
  }

  private currentLease(lease: CompileLease): boolean {
    return this.pending.get(lease.ownerId)?.lease === lease && !lease.signal.aborted && lease.sessionKey === this.sessionKey && this.programs.get(lease.ownerId)?.revision === lease.revision && lease.formationRevision === this.formations.revision
  }
  isCompileCurrent(lease: CompileLease): boolean { return this.currentLease(lease) }

  prepareCompile(lease: CompileLease, goals: GoalSpec[]): boolean {
    if (!this.currentLease(lease)) return false
    if (goals.length !== lease.goals.length || goals.some((g, i) => g.id !== lease.goals[i]!.id || ownerId(goalOwner(g)) !== lease.ownerId)) throw new Error('预处理改变了目标归属')
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
    if (lease.repair && program.status !== 'paused') return false
    const nextIds = new Set(lease.goals.map(g => g.id))
    for (const id of program.activeGoalIds) {
      if (!nextIds.has(id)) {
        const old = this.goals.get(id)
        if (old?.status === 'active') {
          old.status = 'cancelled'
          old.facts.cancelReason = `已被后续命令替换：${lease.goals.map(goal => goal.rawText).join('；')}`
        }
      }
    }
    program.activeGoalIds = []
    for (const spec of lease.goals) {
      const goal = this.goals.get(spec.id)!
      if (['cancelled', 'completed', 'partial', 'failed'].includes(goal.status)) continue
      goal.activeSpec = structuredClone(spec)
      goal.status = 'active'
      if (!goal.facts.initialized && (spec.kind === 'combat' || spec.kind === 'deploy')) {
        const ids = spec.kind === 'combat' ? this.formations.membersOf(spec.formationId) : spec.unitIds
        goal.facts.members = this.latest!.self.filter(u => ids.includes(u.id)).map(u => ({ id: u.id, name: u.name, rx: u.rx, ry: u.ry }))
      }
      goal.facts.initialized = spec.kind !== 'combat' || goal.facts.members.length > 0
      program.activeGoalIds.push(spec.id)
    }
    program.script = { code, version: (program.script?.version ?? 0) + 1, hash: codeHash(code), ...(promptVersion ? { promptVersion } : {}) }
    program.generation++
    program.memory = {}
    program.status = program.activeGoalIds.length ? 'active' : 'idle'
    program.stats.errors = 0
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
    program.revision++
    this.cancelCommand(program.id)
    const snap = this.latest
    const spec = goal.activeSpec ?? goal.spec
    if (snap && (spec.kind === 'combat' || spec.kind === 'explore' || spec.kind === 'repair' || spec.kind === 'rally' || spec.kind === 'transport')) {
      const ids = this.goalConstraints(spec, snap).allowedUnitIds
      if (ids.length) await this.deps.submit([{ kind: 'stop', unitIds: ids }], snap, () => this.sessionKey === snap.sessionKey && goal.status === 'cancelled' && this.goals.get(id) === goal && (program.owner.kind === 'global' || !program.activeGoalIds.some(other => other !== id && this.goals.get(other)?.status === 'active')) && ids.every(unit => spec.kind === 'rally' || spec.kind === 'transport' ? !this.formations.ownerOf(unit) : this.formations.ownerOf(unit) === spec.formationId))
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

  async stop(id: string): Promise<void> {
    const program = this.programs.get(id) ?? this.programs.get(this.goals.get(id)?.ownerId ?? '')
    if (!program) return
    const goals = [...new Set([...program.goalIds, ...program.activeGoalIds])]
    this.cancelCommand(program.id)
    program.status = 'stopped'
    program.generation++
    await Promise.all(goals.map(g => this.cancelGoal(g, `${program.id} 脚本已停止`)))
  }
  pause(id: string): void {
    this.cancelCommand(id)
    const program = this.programs.get(id)
    if (program) {
      for (const spec of this.activeSpecs(program)) if (spec.kind === 'explore') this.exploration.suspend(spec.explorationId, this.latest?.tick ?? 0)
      program.status = 'paused'; program.generation++
    }
  }
  resume(id: string): void {
    this.cancelCommand(id)
    const program = this.programs.get(id)
    if (program?.script && program.status === 'paused') { program.status = 'active'; program.stats.errors = 0; program.generation++ }
  }
  async stopUnits(ids: number[]): Promise<void> {
    const owners = new Set(ids.map(id => this.formations.ownerOf(id)).filter((x): x is string => !!x).map(formationId => ownerId({ kind: 'formation', formationId })))
    const cancel: string[] = []
    for (const goal of this.goals.values()) {
      const spec = goal.activeSpec ?? goal.spec
      if (['cancelled', 'completed', 'partial', 'failed'].includes(goal.status)) continue
      const members = spec.kind === 'rally' || spec.kind === 'transport' ? spec.unitIds : spec.kind === 'formation' ? spec.request.kind === 'dissolveFormation' ? this.formations.membersOf(spec.request.formationId) : spec.request.unitIds : spec.kind === 'reinforce' ? this.latest?.self.filter(u => u.name === spec.name && ((this.formations.ownerOf(u.id) ?? null) === spec.source || this.formations.ownerOf(u.id) === spec.formationId)).map(u => u.id) ?? [] : []
      if (members.some(id => ids.includes(id))) cancel.push(spec.id)
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

  private locked(id: number): boolean { return this.handoffs.some(h => h.unitIds.includes(id)) }
  private activeSpecs(program: ProgramState): GoalSpec[] {
    return program.activeGoalIds.map(id => this.goals.get(id)).filter((g): g is GoalState => !!g && g.status === 'active' && !!g.activeSpec).map(g => g.activeSpec!)
  }

  private goalConstraints(spec: GoalSpec, snap: Snapshot): GoalConstraints {
    const base: GoalConstraints = { allowedUnitIds: [], enemyIds: snap.enemies.map(u => u.id), mapWidth: snap.mapWidth, mapHeight: snap.mapHeight, allowedActions: [] }
    const alive = (ids: number[]) => ids.filter(id => snap.self.some(u => u.id === id) && !this.locked(id))
    if (spec.kind === 'transport') return { ...base, allowedUnitIds: alive(spec.unitIds).filter(id => !this.formations.ownerOf(id)), allowedActions: ['enterTransport'], friendlyTargetIds: snap.self.filter(unit => unit.id === spec.transportId && unit.transport && unit.transport.occupied < unit.transport.capacity).map(unit => unit.id) }
    if (spec.kind === 'repair') {
      const view = this.repairPlan(spec, snap).view
      return { ...base, allowedUnitIds: alive(this.formations.membersOf(spec.formationId)).filter(id => snap.self.some(unit => unit.id === id && (spec.vehicleNames.includes(unit.name) || spec.engineerNames.includes(unit.name)))), allowedActions: ['enterTransport', 'repair', 'move', 'stop'], friendlyTargetIds: [...view.assembling.map(pair => pair.vehicleId), ...view.damaged.map(unit => unit.id)], region: { name: '维修支援', x1: 0, y1: 0, x2: snap.mapWidth - 1, y2: snap.mapHeight - 1 } }
    }
    if (spec.kind === 'explore') return { ...base, allowedUnitIds: alive(this.formations.membersOf(spec.formationId)), allowedActions: ['move', 'gather', 'stop'], region: { name: '侦察路径', x1: 0, y1: 0, x2: snap.mapWidth - 1, y2: snap.mapHeight - 1 } }
    if (spec.kind === 'combat') {
      const facts = this.goals.get(spec.id)!.facts
      return { ...base, allowedUnitIds: alive(this.formations.membersOf(spec.formationId)), allowedActions: spec.allowedActions, region: spec.region,
        ...(spec.attackRegion ? { targetRegion: spec.attackRegion, enemyIds: snap.enemies.filter(enemy => inTargetRegion(enemy.rx, enemy.ry, spec.attackRegion!)).map(enemy => enemy.id) } : {}),
        ...(spec.retreat ? { retreat: { x: spec.retreat.x, y: spec.retreat.y, active: facts.retreatTriggered } } : {}) }
    }
    if (spec.kind === 'deploy') return { ...base, allowedUnitIds: alive(spec.unitIds).filter(id => snap.self.some(u => u.id === id && u.canDeploy)), allowedActions: ['deploy'] }
    if (spec.kind === 'production') {
      const desired = this.goals.get(spec.id)?.spec
      // 减少产量属于立即收紧；增量仍需等候新代码激活。
      const quantity = desired?.kind === 'production' ? Math.min(spec.quantity, desired.quantity) : spec.quantity
      const progress = productionProgress({ ...spec, quantity }, this.production, snap)
      const allowedPlace = this.production.filter(r => r.building && !r.placed && r.state !== 'rejected' && (r.name === spec.target ? r.goalId === spec.id : spec.prerequisites.includes(r.name))).map(r => r.name)
      const productionQueueTypes = { ...Object.fromEntries(spec.prerequisites.map(name => [name, 0])), [spec.target]: spec.targetType === 2 ? 0 : spec.targetType === 3 ? 2 : spec.targetType === 1 ? 4 : 3, ...spec.queueTypes }
      const queueSpace: Record<number, number> = {}
      for (const queue of snap.production?.queues ?? []) {
        const pending = this.production.filter(r => r.state !== 'rejected' && (r.queueType ?? (r.building ? 0 : 3)) === queue.type).reduce((n, r) => n + Math.max(0, r.quantity - r.observedIds.length), 0)
        queueSpace[queue.type] = Math.max(0, queue.maxSize - Math.max(queue.size, pending))
      }
      const members = spec.formationId ? alive(progress.observed[spec.target] ?? []).filter(id => !this.formations.ownerOf(id)) : []
      const exists = spec.formationId && this.formations.list().some(f => f.id === spec.formationId)
      return { ...base, allowedProduce: [...spec.prerequisites, spec.target], allowedPlace, productionQueueTypes, queueSpace, produceRemaining: progress.remaining, allowedQueueTypes: spec.queues, resumableQueueTypes: [...this.pausedQueues].filter(([, id]) => id === spec.id).map(([q]) => q),
        ...(spec.formationId ? { management: { kind: exists ? 'transferUnits' as const : 'createFormation' as const, formationId: spec.formationId, allowedUnitIds: members, maxUnits: members.length } } : {}) }
    }
    if (spec.kind === 'rally') return { ...base, allowedUnitIds: alive(spec.unitIds).filter(id => !this.formations.ownerOf(id)), allowedActions: ['move', 'stop'], region: { name: '集结路径', x1: 0, y1: 0, x2: snap.mapWidth - 1, y2: snap.mapHeight - 1 }, destination: { x: spec.x, y: spec.y } }
    if (spec.kind === 'formation') {
      const r = spec.request
      const ids = r.kind === 'dissolveFormation' ? this.formations.membersOf(r.formationId) : r.unitIds
      const needed = r.kind === 'dissolveFormation' ? ids : ids.filter(id => this.formations.ownerOf(id) !== r.formationId)
      const allowed = alive(needed).filter(id => !spec.sourceOwners || spec.sourceOwners.some(([unit, from]) => unit === id && (this.formations.ownerOf(id) ?? null) === from))
      const kind = r.kind === 'createFormation' && this.formations.list().some(formation => formation.id === r.formationId) ? 'transferUnits' : r.kind
      return { ...base, management: { kind, formationId: r.formationId, allowedUnitIds: allowed, maxUnits: needed.length, exact: true, ...(kind === 'createFormation' && r.kind === 'createFormation' ? { force: !!r.force } : {}) } }
    }
    const target = snap.self.filter(u => u.name === spec.name && this.formations.ownerOf(u.id) === spec.formationId).length
    const unknown = new Set(this.production.filter(r => r.state === 'unknown' || r.state === 'reserved').flatMap(r => r.observedIds))
    const ids = snap.self.filter(u => u.name === spec.name && (this.formations.ownerOf(u.id) ?? null) === spec.source && !this.locked(u.id) && !unknown.has(u.id)).map(u => u.id)
    return { ...base, management: { kind: 'transferUnits', formationId: spec.formationId, allowedUnitIds: ids, maxUnits: Math.max(0, spec.targetSize - target) } }
  }

  private repairPlan(spec: import('@ra2c/contracts').RepairGoal, snap: Snapshot) {
    const members = this.formations.membersOf(spec.formationId).filter(id => !this.locked(id))
    const waiting = spec.preparationGoalIds.some(id => { const goal = this.goals.get(id); return goal && !['completed', 'partial', 'failed', 'cancelled'].includes(goal.status) }) || this.handoffs.some(handoff => handoff.unitIds.some(id => this.formations.ownerOf(id) === spec.formationId))
    const previous = structuredClone(this.goals.get(spec.id)?.facts.repair) ?? { ...emptyRepairState(), engineerIds: [...new Set([...this.goals.values()].flatMap(goal => goal.facts.repair?.engineerIds ?? []))] }
    if (this.programs.get(ownerId(goalOwner(spec)))?.status === 'paused') for (const job of previous.jobs) job.progressTick = snap.tick
    return planRepairs(spec, snap, members, previous, waiting, spec.followFormationId ? this.formations.membersOf(spec.followFormationId) : undefined)
  }

  private movementArrival(spec: GoalSpec, snap: Snapshot) {
    const destination = spec.kind === 'combat' ? spec.route?.[this.goals.get(spec.id)?.facts.routeIndex ?? 0] ?? spec.destination
      : spec.kind === 'rally' ? { x: spec.x, y: spec.y } : undefined
    if (!destination) return undefined
    const ids = new Set(spec.kind === 'combat' ? this.formations.membersOf(spec.formationId)
      : spec.kind === 'rally' ? spec.unitIds.filter(id => !this.formations.ownerOf(id)) : [])
    return assessArrival(snap.self.filter(unit => ids.has(unit.id)), destination, id => this.locked(id))
  }

  private frame(program: ProgramState, specs: GoalSpec[], snap: Snapshot, running = false): { snapshot: Snapshot; constraints: StepConstraints } {
    const goals: Record<string, GoalConstraints> = Object.create(null)
    const views: GoalView[] = []
    for (const spec of specs) {
      const facts = this.goals.get(spec.id)?.facts ?? emptyFacts()
      const constraints = this.goalConstraints(spec, snap)
      goals[spec.id] = constraints
      const progress = spec.kind === 'production' ? productionProgress(spec, this.production, snap) : undefined
      const currentSpec = spec.kind === 'combat' && spec.route ? { ...spec, destination: spec.route[Math.min(facts.routeIndex ?? 0, spec.route.length - 1)]! } : spec
      const view: GoalView = { spec: currentSpec, unitIds: constraints.management?.allowedUnitIds ?? constraints.allowedUnitIds, produceRemaining: constraints.produceRemaining ?? {}, submitted: progress?.sent ?? {}, observed: progress?.observed ?? {}, uncertain: progress?.uncertain ?? [], lossRatio: facts.lossRatio, retreatActive: facts.retreatTriggered }
      const arrival = this.movementArrival(spec, snap)
      if (arrival) view.arrival = arrival
      if (spec.kind === 'repair') view.repair = this.repairPlan(spec, snap).view
      if (spec.kind === 'explore' && this.exploration.progress.has(spec.explorationId)) {
        view.exploration = this.exploration.view(spec)
        if (!view.unitIds.length) view.blocked = '等待侦察成员实际交接就绪'
      }
      if (spec.kind === 'production' && progress) {
        const missingPrerequisites = snap.production?.available.includes(spec.target) ? [] : spec.prerequisites.filter(name => !snap.self.some(unit => unit.type === 2 && unit.name === name))
        view.productionPlan = {
          missingPrerequisites,
          pendingPrerequisites: missingPrerequisites.filter(name => (progress.sent[name] ?? 0) > (progress.observed[name]?.length ?? 0)),
          availableToProduce: (constraints.allowedProduce ?? []).filter(name => (constraints.produceRemaining?.[name] ?? 0) > 0 && snap.production?.available.includes(name) && (constraints.queueSpace?.[constraints.productionQueueTypes?.[name] ?? 0] ?? 1) > 0),
          readyToPlace: (constraints.allowedPlace ?? []).filter(name => snap.production?.queues.some(queue => queue.status === 3 && queue.items.some(item => item.name === name))),
        }
      }
      const blocked = progress?.blocked ?? facts.blocked
      if (blocked) view.blocked = blocked
      if (spec.kind === 'combat' && !this.formations.list().some(formation => formation.id === spec.formationId)) view.blocked = `等待 ${spec.formationId} 编队完成`
      if (constraints.management) view.maxUnits = constraints.management.maxUnits
      if (constraints.management?.exact && constraints.management.allowedUnitIds.length !== constraints.management.maxUnits) view.blocked = '成员或来源已变化，请重新下达管理命令'
      views.push(view)
    }
    const constraints: StepConstraints = { allowedUnitIds: [], enemyIds: snap.enemies.map(u => u.id), mapWidth: snap.mapWidth, mapHeight: snap.mapHeight, goals, ignoreInactiveGoals: running }
    const regional = specs.length > 0 && specs.every(spec => spec.kind === 'combat' && spec.attackRegion)
    const targetIds = new Set(Object.values(goals).flatMap(goal => goal.enemyIds))
    return { snapshot: { ...snap, enemies: regional ? snap.enemies.filter(enemy => targetIds.has(enemy.id)) : snap.enemies, constraints, control: { owner: program.owner, goals: views, formations: this.formations.list().map(f => ({ id: f.id, memberIds: [...f.memberIds] })) } }, constraints }
  }

  private observe(snap: Snapshot): void {
    const converted = new Set<number>()
    for (const goal of this.goals.values()) {
      const spec = goal.activeSpec
      if (spec?.kind !== 'combat') continue
      if (!goal.facts.initialized) {
        const ids = this.formations.membersOf(spec.formationId)
        goal.facts.members = snap.self.filter(unit => ids.includes(unit.id)).map(unit => ({ id: unit.id, name: unit.name, rx: unit.rx, ry: unit.ry }))
        goal.facts.initialized = goal.facts.members.length > 0
      }
      const occupied = new Set(goal.facts.members.map(m => m.id))
      let dead = 0
      for (const member of goal.facts.members) {
        let unit = snap.self.find(u => u.id === member.id)
        if (!unit) {
          const form = spec.transforms?.[member.name]
          unit = form ? snap.self.find(u => u.name === form && !occupied.has(u.id) && Math.hypot(u.rx - member.rx, u.ry - member.ry) <= 2) : undefined
          if (unit) { occupied.add(unit.id); converted.add(unit.id); member.id = unit.id }
        }
        if (unit) { member.name = unit.name; member.rx = unit.rx; member.ry = unit.ry } else dead++
      }
      goal.facts.lossRatio = goal.facts.members.length ? dead / goal.facts.members.length : 0
      if (spec.retreat && goal.facts.lossRatio > spec.retreat.lossAbove) goal.facts.retreatTriggered = true
    }
    observeProduction(this.production, this.seenUnitIds, snap, converted)
    for (const goal of this.goals.values()) {
      if (goal.status !== 'active' || !goal.activeSpec) continue
      const spec = goal.activeSpec
      if (spec.kind === 'repair') {
        const planned = this.repairPlan(spec, snap)
        // 暂停时不积累停滞时钟，恢复后重新观察位置与血量。
        if (this.programs.get(goal.ownerId)?.status === 'paused') for (const job of planned.state.jobs) job.progressTick = snap.tick
        goal.facts.repair = planned.state
        if (!planned.view.waiting && (!this.formations.membersOf(spec.formationId).some(id => snap.self.some(unit => unit.id === id)) || spec.skill && !planned.view.readyIds.length && !planned.view.assembling.length)) {
          goal.status = 'failed'; goal.facts.outcomeDetail = '维修成员或可组装组件已损失，未追加生产'
        }
      } else if (spec.kind === 'transport') {
        const transport = snap.self.find(unit => unit.id === spec.transportId)
        if (spec.unitIds.every(id => transport?.transport?.unitIds.includes(id))) this.complete(goal)
      } else if (spec.kind === 'production') {
        const progress = productionProgress(spec, this.production, snap)
        const assigned = !spec.formationId || (progress.observed[spec.target] ?? []).filter(id => snap.self.some(u => u.id === id)).every(id => this.formations.ownerOf(id) === spec.formationId && !this.locked(id))
        if (!spec.maintainPower && assigned && (progress.observed[spec.target]?.length ?? 0) >= spec.quantity && !progress.uncertain.includes(spec.target)) this.complete(goal)
      } else if (spec.kind === 'deploy') {
        if (goal.facts.members.some(m => snap.self.some(u => u.name === spec.target && Math.hypot(u.rx - m.rx, u.ry - m.ry) <= 3))) this.complete(goal)
      } else if (spec.kind === 'formation' && spec.request.kind !== 'dissolveFormation') {
        if (spec.request.unitIds.every(id => this.formations.ownerOf(id) === spec.request.formationId && !this.locked(id))) this.complete(goal)
      } else if (spec.kind === 'rally') {
        if (this.movementArrival(spec, snap)?.reached) this.complete(goal)
      } else if (spec.kind === 'combat' && spec.destination && !spec.attackRegion && spec.mode !== 'hold' && spec.mode !== 'assault') {
        if (this.movementArrival(spec, snap)?.reached) {
          if (spec.route) {
            goal.facts.routeIndex = (goal.facts.routeIndex ?? 0) + 1
            if (goal.facts.routeIndex >= spec.route.length) this.complete(goal)
          } else this.complete(goal)
        }
      }
    }
    // 旧状态恢复时，所有目标可能早已完成；不要保留无活动目标的 active 状态。
    for (const program of this.programs.values()) if (program.status === 'active' && !this.activeSpecs(program).length) program.status = 'idle'
  }
  private complete(goal: GoalState): void {
    goal.facts.done = true
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
        this.exploration.clear(); this.skillRuns.clear()
        this.production.length = 0; this.handoffs.length = 0; this.seenUnitIds.clear(); this.pausedQueues.clear()
      }
      this.session = snap.session; this.sessionKey = snap.sessionKey
      for (const unit of snap.self) this.seenUnitIds.add(unit.id)
    } else if (this.latest && snap.seq <= this.latest.seq) return
    this.latest = snap
    this.observe(snap)
    this.observeExploration(snap)
    this.syncSkillRuns()
    if (!this.draining) this.draining = this.drain().finally(() => { this.draining = undefined })
    await this.draining
  }

  private async drain(): Promise<void> {
    let consumed: Snapshot | undefined
    while (this.latest && consumed !== this.latest) {
      const snap = this.latest
      consumed = snap
      if (this.handoffs.length) await this.flushHandoffs(snap)
      for (const program of this.programs.values()) {
        if (this.latest !== snap) break
        if (program.status === 'active' && program.script) await this.step(program, snap)
      }
    }
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
      try {
        const results = ids.length ? await this.deps.submit([{ kind: 'stop', unitIds: ids }], snap, guard) : [{ ok: true }]
        if (guard() && results.length && results.every(r => r.ok)) {
          this.handoffs.splice(this.handoffs.indexOf(handoff), 1)
          const goal = this.goals.get(handoff.goalId)
          if (goal) {
            delete goal.facts.blocked
            if (goal.status !== 'cancelled' && goal.spec.kind === 'formation') this.complete(goal)
          }
        } else if (this.goals.get(handoff.goalId)) this.goals.get(handoff.goalId)!.facts.blocked = '成员交接停车尚未确认'
      } catch (err) { if (this.goals.get(handoff.goalId)) this.goals.get(handoff.goalId)!.facts.blocked = `成员交接失败: ${String(err).slice(0, 120)}` }
    }
  }

  private async manage(goal: GoalState, request: FormationRequest, snap: Snapshot): Promise<void> {
    if (this.handoffs.some(h => h.goalId === goal.spec.id)) return
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
    program.stats.errors++; program.stats.lastError = error
    if (program.stats.errors < 3) return
    program.status = 'paused'; program.generation++
    const ids = this.activeSpecs(program).flatMap(g => this.goalConstraints(g, snap).allowedUnitIds)
    if (ids.length) await this.deps.submit([{ kind: 'stop', unitIds: [...new Set(ids)] }], snap, () => program.status === 'paused' && this.programs.get(program.id) === program && this.sessionKey === snap.sessionKey)
    if (program.status === 'paused' && this.programs.get(program.id) === program && !this.hasPendingCommand(program.id)) this.deps.onProgramFaulted?.(program.id)
  }

  private async step(program: ProgramState, snap: Snapshot): Promise<void> {
    const script = program.script!
    const generation = program.generation
    const formationRevision = this.formations.revision
    const authorized = () => this.programs.get(program.id) === program && program.status === 'active' && program.generation === generation && program.script === script && this.sessionKey === snap.sessionKey
    const valid = () => authorized() && this.latest === snap && formationRevision === this.formations.revision
    const specs = this.activeSpecs(program)
    if (!specs.length) return
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
    if (!outcome.ok) { await this.fault(program, outcome.error ?? '执行失败', snap); return }
    outcome.actions = liveScriptActions(outcome.actions, frame.constraints, frame.snapshot)
    const outputError = validateScriptActions(outcome.actions, frame.constraints, frame.snapshot)
    if (outputError) { await this.fault(program, outputError, snap); return }
    for (const item of outcome.actions) {
      if (!valid()) return
      const goal = this.goals.get(item?.goalId)
      // 单目标取消/完成不使其他目标失效，也不把陈旧引用当作脚本异常。
      if (!goal || goal.ownerId !== program.id || goal.status !== 'active' || !goal.activeSpec || !program.activeGoalIds.includes(item.goalId)) continue
      const fresh = this.frame(program, [goal.activeSpec], snap, true)
      const live = liveScriptActions([item], fresh.constraints, fresh.snapshot)[0]
      if (!live) continue
      item.request = live.request
      const error = validateScriptActions([item], fresh.constraints, fresh.snapshot)
      if (error) { await this.fault(program, error, snap); return }
      const request = item.request
      if (request.kind === 'createFormation' || request.kind === 'transferUnits' || request.kind === 'dissolveFormation') {
        try { await this.manage(goal, request, snap); program.stats.actions++; program.stats.errors = 0 }
        catch (err) { goal.facts.blocked = String(err); await this.fault(program, String(err), snap) }
        // 管理请求改变成员修订，下一步用最新归属重新执行。
        return
      }
      let record: ProductionRecord | undefined
      if (request.kind === 'produce') {
        const spec = goal.activeSpec
        // 同一句话明确要求的建筑也可能先被其他目标当作前置生产；统一记到该建设目标，避免换代码后再造一遍。
        const target = spec.kind === 'production' && request.name !== spec.target ? [...this.goals.values()].find(candidate => {
          const desired = candidate.activeSpec ?? candidate.spec
          return !['cancelled', 'completed', 'partial', 'failed'].includes(candidate.status) && desired.kind === 'production' && !desired.maintainPower && desired.target === request.name
            && (productionProgress(desired, this.production, snap).remaining[request.name] ?? 0) >= request.quantity
        }) : undefined
        record = { id: randomUUID(), goalId: target?.spec.id ?? item.goalId, name: request.name, quantity: request.quantity, building: spec.kind === 'production' && (request.name !== spec.target || spec.targetType === 2), queueType: fresh.constraints.goals![item.goalId]!.productionQueueTypes![request.name]!, state: 'reserved', observedIds: [], placed: false }
        this.production.push(record)
        try { await this.deps.checkpoint() }
        catch (err) { record.state = 'rejected'; goal.facts.blocked = `生产预留保存失败: ${String(err)}`; return }
        if (!valid() || goal.status !== 'active') { record.state = 'rejected'; return }
      }
      const guard = () => valid() && goal.status === 'active' && goal.activeSpec === this.goals.get(item.goalId)?.activeSpec
      try {
        const results = await this.deps.submit([request], snap, guard)
        if (request.kind === 'place' && results.length && results.every(result => !result.ok && result.submitted === 0 && ['no-spot', 'cannot-place'].includes(result.reason ?? ''))) {
          goal.facts.blocked = `${request.name} 暂无可放置位置，保留就绪建筑并继续重试`
          program.stats.rejected++
          continue
        }
        if (request.kind !== 'produce' && results.some(result => !result.ok && ['invisible-target', 'invalid-units', 'stale-snapshot', 'stale-session'].includes(result.reason ?? ''))) continue
        if (!results.length || results.some(r => !r.ok)) {
          const notSent = !results.length || results.every(r => !r.ok && r.submitted === 0 && ['stale-session', 'stale-snapshot', 'revoked-or-no-snapshot', 'no-api'].includes(r.reason ?? ''))
          if (record) record.state = notSent ? 'rejected' : 'unknown'
          goal.facts.blocked = notSent ? '动作未发送' : '提交结果不确定，保留记录'
          program.stats.rejected++
          return
        }
        if (record) record.state = 'submitted'
        if (request.kind === 'pauseQueue' && snap.production?.queues.some(q => q.type === request.queueType && q.status !== 2)) this.pausedQueues.set(request.queueType, item.goalId)
        if (request.kind === 'resumeQueue') this.pausedQueues.delete(request.queueType)
        delete goal.facts.blocked
        program.stats.actions++
      } catch (err) {
        if (record) record.state = 'unknown'
        goal.facts.blocked = `提交结果不确定: ${String(err).slice(0, 120)}`
        return
      }
    }
    if (authorized()) { program.memory = outcome.memory; program.stats.errors = 0 }
  }
}
