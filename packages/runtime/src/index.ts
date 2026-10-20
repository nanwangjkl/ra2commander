import { validateActions, inRegion, type ActionRequest, type ActionResult, type ActionContext, type Snapshot, type StepConstraints, type Region } from '@ra2c/contracts'
import { codeHash, type StepExecutor } from '@ra2c/js-worker'
import { FormationRegistry } from './formation.ts'

export { FormationRegistry } from './formation.ts'
export type { Formation, CreateResult } from './formation.ts'
export { computePrerequisiteClosure } from './production.ts'
export type { RulesLookup, PrerequisiteClosure } from './production.ts'
export { persistState, restoreState } from './persist.ts'
export type { PersistedState } from './persist.ts'

export type TaskStatus = 'active' | 'paused' | 'stopped'

export class ProductionLedger {
  private owner = new Map<number, string>()
  pause(taskId: string, queue: number): void { this.owner.set(queue, taskId) }
  resume(_taskId: string, queue: number): void { this.owner.delete(queue) }
  takePaused(taskId: string): number[] {
    const queues = [...this.owner].filter(([, id]) => id === taskId).map(([q]) => q)
    for (const q of queues) this.owner.delete(q)
    return queues
  }
  clear(): void { this.owner.clear() }
  export(): Array<[number, string]> { return [...this.owner] }
  restore(entries: Array<[number, string]>): void { this.owner = new Map(entries) }
  pausedFor(taskId: string): number[] { return [...this.owner].filter(([, owner]) => owner === taskId).map(([q]) => q) }
}

export interface TaskSpec {
  id: string
  rawText: string
  unitIds: number[]
  originalMembers: number[]
  region?: Region
  formationId?: string
  allowedActions?: ActionRequest['kind'][]
  allowedProduce?: string[]
  produceLimits?: Record<string, number>
  allowedQueueTypes?: number[]
  retreat?: { lossAbove: number; x: number; y: number }
  transforms?: Record<string, string>
}

export interface TaskState {
  spec: TaskSpec
  status: TaskStatus
  generation: number
  script?: { code: string; version: number; hash: string }
  memory: unknown
  authority: {
    produced: Record<string, number>
    retreatTriggered: boolean
    lossRatio: number
    members: Array<{ id: number; name: string; rx: number; ry: number }>
  }
  stats: { steps: number; actions: number; rejected: number; errors: number; lastError?: string | undefined; lastActionSig?: string | undefined }
}

export interface CommandLease {
  readonly id: string
  readonly session: number
  readonly sessionKey: string
  readonly signal: AbortSignal
  readonly formationRevision: number
  readonly unitIds: readonly number[]
  readonly repairTask?: TaskState
}

export interface RuntimeDeps {
  executor: Pick<StepExecutor, 'run'>
  /** guard 在每次向浏览器发送前同步调用，避免批次中间撤权后继续发送。 */
  submit: (actions: ActionRequest[], context: ActionContext, guard: () => boolean) => Promise<ActionResult[]>
  formations?: FormationRegistry
  onTaskFaulted?: (taskId: string) => void
  log?: (msg: string) => void
}

export class TaskRuntime {
  private session = -1
  private sessionKey = ''
  private retiredSessions = new Set<string>()
  private lastSnapshot?: Snapshot
  private draining?: Promise<void> | undefined
  private pending = new Map<string, { lease: CommandLease; abort: AbortController }>()
  readonly tasks = new Map<string, TaskState>()
  readonly ledger = new ProductionLedger()

  constructor(private readonly deps: RuntimeDeps) {}

  get battleKey(): string { return this.sessionKey }

  beginCommand(id: string, context: ActionContext, repair = false, unitIds?: number[]): CommandLease {
    if (context.session !== this.session || context.sessionKey !== this.sessionKey) throw new Error('命令所属对局已失效')
    this.cancelCommand(id)
    const abort = new AbortController()
    const task = this.tasks.get(id)
    if (repair && (!task || task.status !== 'paused')) throw new Error('任务不处于故障暂停态')
    const lease: CommandLease = { id, session: context.session, sessionKey: context.sessionKey, signal: abort.signal, unitIds: [...(unitIds ?? task?.spec.unitIds ?? [])], formationRevision: this.deps.formations?.revision ?? 0, ...(repair && task ? { repairTask: task } : {}) }
    this.pending.set(id, { lease, abort })
    return lease
  }

  cancelCommand(id: string): void {
    this.pending.get(id)?.abort.abort()
    this.pending.delete(id)
  }

  releaseCommand(lease: CommandLease): void {
    if (this.pending.get(lease.id)?.lease === lease) this.cancelCommand(lease.id)
  }

  cancelAllCommands(): void {
    for (const id of this.pending.keys()) this.cancelCommand(id)
  }

  hasPendingCommand(id: string): boolean { return this.pending.has(id) }
  pendingCommandIds(): string[] { return [...this.pending.keys()] }

  async stopUnits(unitIds: number[]): Promise<void> {
    const selected = new Set(unitIds)
    for (const { lease } of this.pending.values()) {
      if (lease.unitIds.some(id => selected.has(id))) this.cancelCommand(lease.id)
    }
    // 同步撤销所有相关任务，再异步等待停车回执。
    const stops = [...this.tasks.values()].filter(task => task.status !== 'stopped' && this.boundIds(task).some(id => selected.has(id))).map(task => this.stop(task.spec.id))
    await Promise.all(stops)
  }

  commitCommand(lease: CommandLease, spec: TaskSpec, code: string): boolean {
    if (this.pending.get(lease.id)?.lease !== lease || lease.signal.aborted || lease.session !== this.session || lease.sessionKey !== this.sessionKey || spec.id !== lease.id || lease.formationRevision !== (this.deps.formations?.revision ?? 0)) return false
    if (lease.repairTask && (this.tasks.get(lease.id) !== lease.repairTask || lease.repairTask.status !== 'paused')) return false
    const previous = lease.repairTask
    const currentSpec = previous?.spec ?? { ...spec, originalMembers: spec.originalMembers.filter(id => this.lastSnapshot?.self.some(u => u.id === id)) }
    this.deploy(currentSpec, code)
    if (previous) {
      const task = this.tasks.get(spec.id)!
      task.authority = previous.authority
      // 修复沿用战损、回撤阶段与生产累计额度，memory 交给新脚本重新观测。
    }
    return true
  }

  deploy(spec: TaskSpec, code: string): void {
    if (spec.unitIds.length && !spec.region) throw new Error('战斗任务必须显式绑定授权地域')
    const snap = this.lastSnapshot
    const point = (x: number, y: number) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && (!snap || (x < snap.mapWidth && y < snap.mapHeight))
    if (spec.region && (!point(spec.region.x1, spec.region.y1) || !point(spec.region.x2, spec.region.y2) || spec.region.x1 > spec.region.x2 || spec.region.y1 > spec.region.y2)) throw new Error('授权地域非法')
    if (spec.retreat && !point(spec.retreat.x, spec.retreat.y)) throw new Error('回撤地点非法')
    if (spec.retreat && (!spec.region || spec.retreat.lossAbove < 0 || spec.retreat.lossAbove >= 1 || !Number.isFinite(spec.retreat.lossAbove))) throw new Error('回撤条件非法')
    if (Object.values(spec.produceLimits ?? {}).some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('生产额度非法')
    for (const other of this.tasks.values()) {
      if (other.spec.id !== spec.id && other.status !== 'stopped' && this.boundIds(other).some(id => spec.unitIds.includes(id))) throw new Error(`单位已被任务 ${other.spec.id} 授权占用，请先停止或明确转编`)
    }
    const existing = this.tasks.get(spec.id)
    if (existing) existing.status = 'stopped'
    this.cancelCommand(spec.id)
    const snapshot = this.lastSnapshot
    const version = (existing?.script?.version ?? 0) + 1
    this.tasks.set(spec.id, {
      spec: structuredClone(spec), status: 'active', generation: 0, script: { code, version, hash: codeHash(code) }, memory: {},
      authority: { produced: Object.create(null) as Record<string, number>, retreatTriggered: false, lossRatio: 0, members: spec.originalMembers.map(id => {
        const u = snapshot?.self.find(u => u.id === id)
        return { id, name: u?.name ?? '', rx: u?.rx ?? 0, ry: u?.ry ?? 0 }
      }) },
      stats: { steps: 0, actions: 0, rejected: 0, errors: 0 },
    })
    this.deps.log?.(`[runtime] 任务 ${spec.id} v${version} 部署「${spec.rawText}」`)
  }

  private boundIds(task: TaskState): number[] {
    return task.spec.formationId
      ? this.deps.formations?.membersOf(task.spec.formationId) ?? []
      : task.spec.unitIds.filter(id => !this.deps.formations?.ownerOf(id))
  }

  async stop(id: string): Promise<void> {
    this.cancelCommand(id)
    const task = this.tasks.get(id)
    if (!task) return
    task.status = 'stopped'
    task.generation++
    const snap = this.lastSnapshot
    if (!snap) return
    const alive = this.boundIds(task).filter(id => snap.self.some(u => u.id === id))
    const guard = () => this.tasks.get(id) === task && task.status === 'stopped' && this.sessionKey === snap.sessionKey
    if (alive.length) await this.deps.submit([{ kind: 'stop', unitIds: alive }], snap, guard)
    for (const queueType of this.ledger.takePaused(id)) {
      const latest = this.lastSnapshot
      if (latest?.production?.queues.some(q => q.type === queueType && q.status === 2) && guard()) {
        await this.deps.submit([{ kind: 'resumeQueue', queueType }], latest, guard)
      }
    }
  }

  pause(id: string): void {
    this.cancelCommand(id)
    const task = this.tasks.get(id)
    if (task?.status === 'active') { task.status = 'paused'; task.generation++ }
  }

  resume(id: string): void {
    this.cancelCommand(id)
    const task = this.tasks.get(id)
    if (task?.status === 'paused') { task.status = 'active'; task.stats.errors = 0; task.generation++ }
  }

  adoptSession(session: number, sessionKey: string): void { this.session = session; this.sessionKey = sessionKey }

  async onSnapshot(snap: Snapshot): Promise<void> {
    if (this.retiredSessions.has(snap.sessionKey)) return
    if (snap.sessionKey !== this.sessionKey) {
      if (this.sessionKey) {
        this.retiredSessions.add(this.sessionKey)
        for (const id of this.pending.keys()) this.cancelCommand(id)
        for (const task of this.tasks.values()) task.status = 'stopped'
        this.deps.formations?.clear()
        this.ledger.clear()
      }
      this.session = snap.session
      this.sessionKey = snap.sessionKey
    } else if (this.lastSnapshot && snap.seq <= this.lastSnapshot.seq) return
    this.lastSnapshot = snap
    // 最新快照替换待处理状态，不并行推进同一份 task.memory。
    if (!this.draining) {
      this.draining = this.drain().finally(() => { this.draining = undefined })
    }
    await this.draining
  }

  private async drain(): Promise<void> {
    let consumed: Snapshot | undefined
    while (this.lastSnapshot && consumed !== this.lastSnapshot) {
      const snap = this.lastSnapshot
      consumed = snap
      for (const task of this.tasks.values()) {
        if (this.lastSnapshot !== snap) break
        if (task.status === 'active' && task.script) await this.step(task, snap)
      }
    }
  }

  private constraints(task: TaskState, snap: Snapshot): StepConstraints {
    const occupied = new Set(task.authority.members.map(m => m.id))
    let dead = 0
    for (const member of task.authority.members) {
      let unit = snap.self.find(u => u.id === member.id)
      if (!unit) {
        const form = task.spec.transforms?.[member.name]
        unit = form ? snap.self.find(u => u.name === form && !occupied.has(u.id) && Math.hypot(u.rx - member.rx, u.ry - member.ry) <= 2) : undefined
        if (unit) { occupied.add(unit.id); member.id = unit.id }
      }
      if (unit) { member.name = unit.name; member.rx = unit.rx; member.ry = unit.ry } else dead++
    }
    const retreat = task.spec.retreat
    task.authority.lossRatio = task.authority.members.length ? dead / task.authority.members.length : 0
    if (retreat && task.authority.lossRatio > retreat.lossAbove) task.authority.retreatTriggered = true
    const remaining = Object.fromEntries(Object.entries(task.spec.produceLimits ?? {}).map(([name, limit]) => [name, Math.max(0, limit - (Object.hasOwn(task.authority.produced, name) ? task.authority.produced[name]! : 0))]))
    return {
      allowedUnitIds: this.boundIds(task).filter(id => snap.self.some(u => u.id === id)),
      enemyIds: snap.enemies.map(u => u.id), mapWidth: snap.mapWidth, mapHeight: snap.mapHeight,
      allowedProduce: task.spec.allowedProduce ?? [], produceRemaining: remaining,
      allowedQueueTypes: task.spec.allowedQueueTypes ?? [], allowedActions: task.spec.allowedActions ?? [],
      resumableQueueTypes: this.ledger.pausedFor(task.spec.id),
      ...(task.spec.region ? { region: task.spec.region } : {}),
      ...(retreat ? { retreat: { x: retreat.x, y: retreat.y, active: task.authority.retreatTriggered } } : {}),
    }
  }

  private async step(task: TaskState, snap: Snapshot): Promise<void> {
    const script = task.script!
    const generation = task.generation
    const formationRevision = this.deps.formations?.revision ?? 0
    const authorized = () => this.tasks.get(task.spec.id) === task && task.status === 'active' && task.generation === generation && task.script === script && this.sessionKey === snap.sessionKey
    const valid = () => authorized() && this.lastSnapshot === snap && formationRevision === (this.deps.formations?.revision ?? 0)
    const constraints = this.constraints(task, snap)
    if (task.spec.unitIds.length && !constraints.allowedUnitIds.length) { task.status = 'stopped'; return }
    // 纠正原生 Attack/Gather 造成的地域偏移，不依赖生成脚本主动上报。
    if (task.spec.region && !task.authority.retreatTriggered) {
      const region = task.spec.region
      const outside = snap.self.filter(u => constraints.allowedUnitIds.includes(u.id) && !inRegion(u.rx, u.ry, region))
      if (outside.length) {
        const actions: ActionRequest[] = [{ kind: 'stop', unitIds: outside.map(u => u.id) }, ...outside.map(u => ({ kind: 'move' as const, unitIds: [u.id], x: Math.max(region.x1, Math.min(region.x2, u.rx)), y: Math.max(region.y1, Math.min(region.y2, u.ry)) }))]
        await this.deps.submit(actions, snap, valid)
        this.deps.log?.(`[runtime] 任务 ${task.spec.id} 纠正 ${outside.length} 个单位的地域偏移`)
        return
      }
    }
    const input = { ...snap, execution: { retreatActive: task.authority.retreatTriggered, lossRatio: task.authority.lossRatio, produceRemaining: constraints.produceRemaining ?? {} } }
    const outcome = await this.deps.executor.run(script.code, input, task.memory, constraints)
    if (!valid()) return
    task.stats.steps++
    // 执行器的返回值不携带权限；宿主使用最新归属再次验证。
    const error = outcome.ok ? validateActions(outcome.actions, this.constraints(task, snap), snap) : outcome.error ?? '执行失败'
    if (error) {
      task.stats.lastError = error
      task.stats.errors++
      if (task.stats.errors >= 3) {
        task.status = 'paused'
        task.generation++
        const alive = this.constraints(task, snap).allowedUnitIds
        if (alive.length) await this.deps.submit([{ kind: 'stop', unitIds: alive }], snap, () => this.tasks.get(task.spec.id) === task && task.status === 'paused' && this.sessionKey === snap.sessionKey)
        if (this.tasks.get(task.spec.id) === task && task.status === 'paused' && this.sessionKey === snap.sessionKey && !this.hasPendingCommand(task.spec.id)) this.deps.onTaskFaulted?.(task.spec.id)
      }
      return
    }
    task.stats.errors = 0
    for (const action of outcome.actions) {
      if (!valid()) return
      const fresh = this.constraints(task, snap)
      const denied = validateActions([action], fresh, snap)
      if (denied) { task.stats.rejected++; task.stats.lastError = denied; return }
      // 发送前保留额度。静默拒绝/断连不自动退款，防止不确定结果造成超造。
      const before = action.kind === 'produce' && Object.hasOwn(task.authority.produced, action.name) ? task.authority.produced[action.name]! : 0
      if (action.kind === 'produce') Object.defineProperty(task.authority.produced, action.name, { value: before + action.quantity, writable: true, enumerable: true, configurable: true })
      let results: ActionResult[]
      try { results = await this.deps.submit([action], snap, valid) }
      catch (err) { task.stats.rejected++; task.stats.lastError = `提交结果不确定: ${String(err).slice(0, 100)}`; return }
      if (!results.length || results.some(r => !r.ok)) {
        const notSent = !results.length || results.every(r => !r.ok && r.submitted === 0 && ['stale-session', 'stale-snapshot', 'revoked-or-no-snapshot', 'no-api'].includes(r.reason ?? ''))
        if (action.kind === 'produce' && notSent) task.authority.produced[action.name] = before
        task.stats.rejected++
        task.stats.lastError = notSent ? `动作未发送: ${results[0]?.reason ?? '已撤权'}` : '提交结果不确定，保留生产额度防止超造'
        this.deps.log?.(`[runtime] 任务 ${task.spec.id} ${task.stats.lastError}`)
        return
      }
      if (action.kind === 'pauseQueue' && snap.production?.queues.some(q => q.type === action.queueType && q.status !== 2)) this.ledger.pause(task.spec.id, action.queueType)
      if (action.kind === 'resumeQueue') this.ledger.resume(task.spec.id, action.queueType)
      task.stats.actions++
    }
    // 已确认的动作需要保留对应进度；同局新采样不抹掉已下单记录。
    if (authorized()) task.memory = outcome.memory
  }
}
