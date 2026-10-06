import type { ActionRequest, ActionResult, Snapshot, StepConstraints } from '@ra2c/contracts'
import { StepExecutor, codeHash } from '@ra2c/js-worker'
import { FormationRegistry } from './formation.ts'

export { FormationRegistry } from './formation.ts'
export type { Formation, CreateResult } from './formation.ts'
export { computePrerequisiteClosure } from './production.ts'
export type { RulesLookup, PrerequisiteClosure } from './production.ts'
export { persistState, restoreState } from './persist.ts'
export type { PersistedState } from './persist.ts'

export type TaskStatus = 'compiling' | 'active' | 'paused' | 'stopped' | 'replaced'

/**
 * 生产队列账本：记录每个任务暂停过的队列。
 * 任务撤权/终结时只恢复"自己暂停的、且当前仍处于暂停态"的队列——
 * 后续命令改变过的不动（需求：结束后仅恢复它自己暂停且未被改变的队列）。
 */
export class ProductionLedger {
  private pausedBy = new Map<string, Set<number>>()

  pause(taskId: string, queueType: number): void {
    const s = this.pausedBy.get(taskId) ?? new Set<number>()
    s.add(queueType)
    this.pausedBy.set(taskId, s)
  }

  resume(taskId: string, queueType: number): void {
    this.pausedBy.get(taskId)?.delete(queueType)
  }

  /** 取走该任务暂停过的队列（清账）；调用方按当前状态决定是否 resume。 */
  takePaused(taskId: string): number[] {
    const s = [...(this.pausedBy.get(taskId) ?? [])]
    this.pausedBy.delete(taskId)
    return s
  }
}

export interface TaskSpec {
  id: string
  /** 玩家原话。 */
  rawText: string
  /** 授权操纵单位（战斗任务）。 */
  unitIds: number[]
  /** 战损口径基准（任务生效时原始成员）。 */
  originalMembers: number[]
  /** 授权地域（可选）。 */
  region?: { name: string; x1: number; y1: number; x2: number; y2: number }
  /** 绑定编队（可选）：成员随编队动态变化（转编自动收窄授权），优先于 unitIds。 */
  formationId?: string
  /** 生产任务：可操作项目闭包（produce/cancel/place 授权名单）。 */
  allowedProduce?: string[]
}

export interface TaskState {
  spec: TaskSpec
  status: TaskStatus
  script?: { code: string; version: number; hash: string }
  memory: unknown
  stats: {
    steps: number
    actions: number
    rejected: number
    errors: number
    lastError?: string | undefined
    lastActionSig?: string | undefined
  }
}

export interface RuntimeDeps {
  executor: StepExecutor
  /** 动作提交通道（经桥，带会话与存活复查）。 */
  submit: (actions: ActionRequest[]) => Promise<ActionResult[]>
  /** 编队注册表（可选；任务绑定编队时用于动态成员）。 */
  formations?: FormationRegistry
  /** 任务因连续失败暂停时的回调（用于触发同授权修复）。 */
  onTaskFaulted?: (taskId: string) => void
  log?: (msg: string) => void
}

const MAX_CONSECUTIVE_ERRORS = 3

/**
 * 任务运行时：管理每条命令的任务（版本、成员、授权、故障隔离），
 * 由最新快照驱动各任务脚本步进。云生成等待期间已有任务继续运行。
 */
export class TaskRuntime {
  private session = -1
  readonly tasks = new Map<string, TaskState>()
  /** 生产队列账本：谁暂停的谁负责恢复。 */
  readonly ledger = new ProductionLedger()

  constructor(private readonly deps: RuntimeDeps) {}

  /** 部署脚本：新任务或普通改令的原子版本切换（就绪后替换，等待期旧任务继续）。 */
  deploy(spec: TaskSpec, code: string): void {
    const existing = this.tasks.get(spec.id)
    const version = existing ? (existing.script?.version ?? 0) + 1 : 1
    this.tasks.set(spec.id, {
      spec,
      status: 'active',
      script: { code, version, hash: codeHash(code) },
      memory: {},
      stats: { steps: 0, actions: 0, rejected: 0, errors: 0 },
    })
    this.deps.log?.(
      `[runtime] 任务 ${spec.id} v${version} 部署（${spec.unitIds.length} 单位）「${spec.rawText}」`,
    )
  }

  /** 停止/禁止类命令：立即撤权并尝试停住其单位；后续动作一律拒绝。恢复其暂停过的队列。 */
  async stop(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) return
    task.status = 'stopped'
    const alive = this.lastSnapshot
      ? task.spec.unitIds.filter((uid) => this.lastSnapshot!.self.some((u) => u.id === uid))
      : task.spec.unitIds
    if (alive.length) await this.deps.submit([{ kind: 'stop', unitIds: alive }])
    await this.restorePausedQueues(id)
    this.deps.log?.(`[runtime] 任务 ${id} 已撤权停止`)
  }

  /** 只恢复本任务暂停过、且当前仍处于 OnHold(2) 的队列（未被后续命令改变的不动）。 */
  private async restorePausedQueues(id: string): Promise<void> {
    const paused = this.ledger.takePaused(id)
    if (!paused.length || !this.lastSnapshot) return
    const queues = this.lastSnapshot.production?.queues ?? []
    for (const queueType of paused) {
      const q = queues.find((x) => x.type === queueType)
      if (q && q.status === 2) {
        await this.deps.submit([{ kind: 'resumeQueue', queueType }])
        this.deps.log?.(`[runtime] 任务 ${id} 结束，恢复其暂停的队列 type${queueType}`)
      }
    }
  }

  pause(id: string): void {
    const t = this.tasks.get(id)
    if (t && t.status === 'active') t.status = 'paused'
  }

  resume(id: string): void {
    const t = this.tasks.get(id)
    if (t && t.status === 'paused') {
      t.status = 'active'
      t.stats.errors = 0
    }
  }

  private lastSnapshot?: Snapshot

  /** 快照入口：会话变化使旧任务全部失效；驱动各 active 任务步进。 */
  async onSnapshot(snap: Snapshot): Promise<void> {
    if (snap.session !== this.session) {
      const old = this.session
      this.session = snap.session
      this.lastSnapshot = snap
      if (old >= 0) {
        for (const t of this.tasks.values()) t.status = 'stopped'
        this.deps.log?.(`[runtime] 对局会话 ${old} → ${snap.session}，旧任务全部失效`)
      }
      return
    }
    this.lastSnapshot = snap

    for (const task of this.tasks.values()) {
      if (task.status !== 'active' || !task.script) continue
      await this.step(task, snap)
    }
  }

  private async step(task: TaskState, snap: Snapshot): Promise<void> {
    const script = task.script
    if (!script) return
    const aliveSelf = new Set(snap.self.map((u) => u.id))
    // 编队任务：成员动态取自注册表（转编后旧任务授权自动收窄）。
    const boundIds = task.spec.formationId
      ? (this.deps.formations?.membersOf(task.spec.formationId) ?? task.spec.unitIds)
      : task.spec.unitIds
    const constraints: StepConstraints = {
      allowedUnitIds: boundIds.filter((uid) => aliveSelf.has(uid)),
      enemyIds: snap.enemies.map((u) => u.id),
      mapWidth: snap.mapWidth,
      mapHeight: snap.mapHeight,
      ...(task.spec.allowedProduce ? { allowedProduce: task.spec.allowedProduce } : {}),
    }
    // 战斗任务全灭：自然结束（生产任务无单位，不适用）。
    if (boundIds.length && !constraints.allowedUnitIds.length) {
      task.status = 'stopped'
      this.deps.log?.(`[runtime] 任务 ${task.spec.id} 无存活成员，结束`)
      return
    }

    const outcome = await this.deps.executor.run(
      script.code,
      snap,
      task.memory,
      constraints,
    )
    task.stats.steps++

    if (!outcome.ok) {
      task.stats.errors++
      task.stats.lastError = outcome.error
      this.deps.log?.(`[runtime] 任务 ${task.spec.id} step 失败(${task.stats.errors}): ${outcome.error}`)
      if (task.stats.errors >= MAX_CONSECUTIVE_ERRORS) {
        task.status = 'paused'
        if (constraints.allowedUnitIds.length) {
          await this.deps.submit([{ kind: 'stop', unitIds: constraints.allowedUnitIds }])
        }
        this.deps.log?.(`[runtime] 任务 ${task.spec.id} 连续失败，暂停（触发同授权修复）`)
        this.deps.onTaskFaulted?.(task.spec.id)
      }
      return
    }

    task.stats.errors = 0
    task.memory = outcome.memory

    // 相同订单节流：本轮动作包签名与上次完全相同则不重发（重新选敌/改目标会破签名，不受影响）。
    // 生产动作不节流：队列被玩家取消/回收后脚本需要重新下单，"重复"是合法且必要的。
    const combatActions = outcome.actions.filter((a) => 'unitIds' in a)
    const sig = combatActions.map(actionSignature).join('|')
    if (sig && sig === task.stats.lastActionSig && combatActions.length === outcome.actions.length) return
    task.stats.lastActionSig = sig

    if (!outcome.actions.length) return
    // 生产队列操作记账（撤权/终结时只恢复自己暂停的）。
    for (const a of outcome.actions) {
      if (a.kind === 'pauseQueue') this.ledger.pause(task.spec.id, a.queueType)
      else if (a.kind === 'resumeQueue') this.ledger.resume(task.spec.id, a.queueType)
    }
    const results = await this.deps.submit(outcome.actions)
    for (const r of results) {
      if (!r.ok) task.stats.rejected++
    }
    task.stats.actions += outcome.actions.length
  }
}

function actionSignature(a: ActionRequest): string {
  if ('unitIds' in a) {
    const ids = [...a.unitIds].sort((x, y) => x - y).join(',')
    if (a.kind === 'attack') return `attack:${ids}:${a.targetId}`
    if ('x' in a && 'y' in a) return `${a.kind}:${ids}:${a.x},${a.y}`
    return `${a.kind}:${ids}`
  }
  if ('name' in a) return `${a.kind}:${a.name}:${'quantity' in a ? a.quantity : ''}`
  return `${a.kind}:${a.queueType}`
}
