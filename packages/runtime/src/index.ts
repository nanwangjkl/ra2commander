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

  constructor(private readonly deps: RuntimeDeps) { this.formations = deps.formations ?? new FormationRegistry() }
  get battleKey(): string { return this.sessionKey }
  get snapshot(): Snapshot | undefined { return this.latest }
  hasPendingCommand(id: string): boolean { return this.pending.has(id) }
  pendingCommandIds(): string[] { return [...this.pending.keys()] }

  /** 提供已有执行事实的精简视图；不改变目标，也不把动作提交当作完成。 */
  goalExecution(id: string): GoalExecution | undefined {
    const goal = this.goals.get(id)
    if (!goal) return undefined
    if (goal.status === 'completed') return { state: 'completed' }
    if (goal.status === 'cancelled') return { state: 'cancelled', detail: '目标已取消或被替换' }
    const program = this.programs.get(goal.ownerId)
    const spec = goal.activeSpec
    if (!spec && goal.status === 'pending' && goal.facts.completedQuantity !== undefined) return { state: 'completed', detail: `前次${goal.facts.completedQuantity}个已完成，新增总量待生效` }
    if (!spec || !program?.activeGoalIds.includes(id) || !this.latest) return program?.status === 'paused' ? { state: 'paused', detail: '目标保留，脚本已暂停' } : undefined
    if (program.status === 'paused') return program.stats.errors >= 3 && program.stats.lastError
      ? { state: 'faulted', detail: `脚本运行出错，已暂停：${program.stats.lastError}` } : { state: 'paused', detail: '脚本已暂停' }
    if (program.status === 'stopped') return { state: 'cancelled', detail: '脚本已停止' }
    const view = this.frame(program, [spec], this.latest).snapshot.control!.goals[0]!
    const progress = spec.kind === 'production' && !spec.maintainPower
      ? { completed: Math.min(spec.quantity, view.observed[spec.target]?.length ?? 0), total: spec.quantity } : undefined
    const detail = view.blocked ?? (view.uncertain.length ? `提交结果待确认：${view.uncertain.join('、')}` : undefined)
    if (detail) return { state: 'blocked', detail, ...(progress ? { progress } : {}) }
    const continuous = (spec.kind === 'production' && !!spec.maintainPower) || spec.kind === 'reinforce' || (spec.kind === 'combat' && (spec.mode === 'hold' || spec.mode === 'assault' || (!spec.destination && !spec.attackRegion)))
    return { state: continuous ? 'continuous' : 'running', ...(progress ? { progress } : {}) }
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
    if (goal.kind === 'combat') {
      if (!this.formations.list().some(f => f.id === goal.formationId)) throw new Error('编队不存在，请先建队')
      const r = goal.region
      if (!r || !point(r.x1, r.y1) || !point(r.x2, r.y2) || r.x1 > r.x2 || r.y1 > r.y2) throw new Error('授权地域非法')
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
    if (old && spec.kind === 'combat') throw new Error('编队新命令应使用新的目标 ID')
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
      for (const id of program.goalIds) if (id !== spec.id && !program.activeGoalIds.includes(id)) this.goals.get(id)!.status = 'cancelled'
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
    const goals = program.goalIds.map(g => this.goals.get(g)!).filter(g => g && g.status !== 'cancelled' && g.status !== 'completed').map(g => structuredClone(g.spec))
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
        if (old?.status === 'active') old.status = 'cancelled'
      }
    }
    program.activeGoalIds = []
    for (const spec of lease.goals) {
      const goal = this.goals.get(spec.id)!
      if (goal.status === 'cancelled' || goal.status === 'completed') continue
      goal.activeSpec = structuredClone(spec)
      goal.status = 'active'
      if (!goal.facts.initialized && (spec.kind === 'combat' || spec.kind === 'deploy')) {
        const ids = spec.kind === 'combat' ? this.formations.membersOf(spec.formationId) : spec.unitIds
        goal.facts.members = this.latest!.self.filter(u => ids.includes(u.id)).map(u => ({ id: u.id, name: u.name, rx: u.rx, ry: u.ry }))
      }
      goal.facts.initialized = true
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

  async cancelGoal(id: string): Promise<void> {
    const goal = this.goals.get(id)
    if (!goal || goal.status === 'cancelled') return
    goal.status = 'cancelled'
    const program = this.programs.get(goal.ownerId)!
    program.goalIds = program.goalIds.filter(g => g !== id)
    program.activeGoalIds = program.activeGoalIds.filter(g => g !== id)
    if (program.status === 'active' && !this.activeSpecs(program).length) program.status = 'idle'
    program.revision++
    this.cancelCommand(program.id)
    const snap = this.latest
    const spec = goal.activeSpec ?? goal.spec
    if (snap && (spec.kind === 'combat' || spec.kind === 'rally')) {
      const ids = this.goalConstraints(spec, snap).allowedUnitIds
      if (ids.length) await this.deps.submit([{ kind: 'stop', unitIds: ids }], snap, () => this.sessionKey === snap.sessionKey && goal.status === 'cancelled' && this.goals.get(id) === goal && ids.every(unit => spec.kind === 'combat' ? this.formations.ownerOf(unit) === spec.formationId : !this.formations.ownerOf(unit)))
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
    await Promise.all(goals.map(g => this.cancelGoal(g)))
  }
  pause(id: string): void {
    this.cancelCommand(id)
    const program = this.programs.get(id)
    if (program) { program.status = 'paused'; program.generation++ }
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
      if (goal.status === 'cancelled' || goal.status === 'completed') continue
      const members = spec.kind === 'rally' ? spec.unitIds : spec.kind === 'formation' ? spec.request.kind === 'dissolveFormation' ? this.formations.membersOf(spec.request.formationId) : spec.request.unitIds : spec.kind === 'reinforce' ? this.latest?.self.filter(u => u.name === spec.name && ((this.formations.ownerOf(u.id) ?? null) === spec.source || this.formations.ownerOf(u.id) === spec.formationId)).map(u => u.id) ?? [] : []
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
      const allowed = alive(ids).filter(id => !spec.sourceOwners || spec.sourceOwners.some(([unit, from]) => unit === id && (this.formations.ownerOf(id) ?? null) === from))
      return { ...base, management: { kind: r.kind, formationId: r.formationId, allowedUnitIds: allowed, maxUnits: ids.length, exact: true, ...(r.kind === 'createFormation' ? { force: !!r.force } : {}) } }
    }
    const target = snap.self.filter(u => u.name === spec.name && this.formations.ownerOf(u.id) === spec.formationId).length
    const unknown = new Set(this.production.filter(r => r.state === 'unknown' || r.state === 'reserved').flatMap(r => r.observedIds))
    const ids = snap.self.filter(u => u.name === spec.name && (this.formations.ownerOf(u.id) ?? null) === spec.source && !this.locked(u.id) && !unknown.has(u.id)).map(u => u.id)
    return { ...base, management: { kind: 'transferUnits', formationId: spec.formationId, allowedUnitIds: ids, maxUnits: Math.max(0, spec.targetSize - target) } }
  }

  private frame(program: ProgramState, specs: GoalSpec[], snap: Snapshot, running = false): { snapshot: Snapshot; constraints: StepConstraints } {
    const goals: Record<string, GoalConstraints> = Object.create(null)
    const views: GoalView[] = []
    for (const spec of specs) {
      const facts = this.goals.get(spec.id)?.facts ?? emptyFacts()
      const constraints = this.goalConstraints(spec, snap)
      goals[spec.id] = constraints
      const progress = spec.kind === 'production' ? productionProgress(spec, this.production, snap) : undefined
      const view: GoalView = { spec, unitIds: constraints.management?.allowedUnitIds ?? constraints.allowedUnitIds, produceRemaining: constraints.produceRemaining ?? {}, submitted: progress?.sent ?? {}, observed: progress?.observed ?? {}, uncertain: progress?.uncertain ?? [], lossRatio: facts.lossRatio, retreatActive: facts.retreatTriggered }
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
      if (spec.kind === 'production') {
        const progress = productionProgress(spec, this.production, snap)
        const assigned = !spec.formationId || (progress.observed[spec.target] ?? []).filter(id => snap.self.some(u => u.id === id)).every(id => this.formations.ownerOf(id) === spec.formationId && !this.locked(id))
        if (!spec.maintainPower && assigned && (progress.observed[spec.target]?.length ?? 0) >= spec.quantity && !progress.uncertain.includes(spec.target)) this.complete(goal)
      } else if (spec.kind === 'deploy') {
        if (goal.facts.members.some(m => snap.self.some(u => u.name === spec.target && Math.hypot(u.rx - m.rx, u.ry - m.ry) <= 3))) this.complete(goal)
      } else if (spec.kind === 'rally') {
        const units = snap.self.filter(u => spec.unitIds.includes(u.id))
        if (units.length && units.every(u => Math.hypot(u.rx - spec.x, u.ry - spec.y) <= 1)) this.complete(goal)
      } else if (spec.kind === 'combat' && spec.destination && !spec.attackRegion && spec.mode !== 'hold' && spec.mode !== 'assault') {
        const members = this.formations.membersOf(spec.formationId)
        const units = snap.self.filter(unit => members.includes(unit.id))
        // 同一格不能容纳整个编队；以所有存活成员进入目的地附近相邻格确认到达。
        const radius = Math.max(2, Math.ceil(Math.sqrt(units.length)))
        if (units.length && units.every(unit => !this.locked(unit.id) && Math.hypot(unit.rx - spec.destination!.x, unit.ry - spec.destination!.y) <= radius)) this.complete(goal)
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
        this.production.length = 0; this.handoffs.length = 0; this.seenUnitIds.clear(); this.pausedQueues.clear()
      }
      this.session = snap.session; this.sessionKey = snap.sessionKey
      for (const unit of snap.self) this.seenUnitIds.add(unit.id)
    } else if (this.latest && snap.seq <= this.latest.seq) return
    this.latest = snap
    this.observe(snap)
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
        for (const id of [...program.activeGoalIds, ...program.goalIds]) { const g = this.goals.get(id); if (g) g.status = 'cancelled' }
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
        record = { id: randomUUID(), goalId: item.goalId, name: request.name, quantity: request.quantity, building: spec.kind === 'production' && (request.name !== spec.target || spec.targetType === 2), queueType: fresh.constraints.goals![item.goalId]!.productionQueueTypes![request.name]!, state: 'reserved', observedIds: [], placed: false }
        this.production.push(record)
        try { await this.deps.checkpoint() }
        catch (err) { record.state = 'rejected'; goal.facts.blocked = `生产预留保存失败: ${String(err)}`; return }
        if (!valid() || goal.status !== 'active') { record.state = 'rejected'; return }
      }
      const guard = () => valid() && goal.status === 'active' && goal.activeSpec === this.goals.get(item.goalId)?.activeSpec
      try {
        const results = await this.deps.submit([request], snap, guard)
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
