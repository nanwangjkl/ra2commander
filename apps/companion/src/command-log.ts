import { randomUUID } from 'node:crypto'
import type { CommandEvent, CommandSource, GoalExecution, GoalSpec } from '@ra2c/contracts'
import type { TaskRuntime } from '@ra2c/runtime'
import { applyCommandEvent, type CardData } from '../ui/command-card.ts'
import { BattleRecords } from './battle-records.ts'
import type { ProgramController } from './controller.ts'
export type { CommandEvent, CommandStage, CommandSource } from '@ra2c/contracts'

/**
 * 命令记录与结构化事件（阶段 2）：统一接入界面文本、终端 say 与 TCP say。
 * 事件在发生时立即推送（SSE），侧栏据此增量渲染卡片；不解析终端输出。
 * 有界内存用于实时推送；完整历史另由对局归档保存。
 */
const MAX_EVENTS = 2000

export class CommandLog {
  constructor(private archive?: BattleRecords) {}
  ensureArchive(root: string): BattleRecords {
    if (!this.archive) { this.archive = new BattleRecords(root); this.archive.importTranscripts(root) }
    return this.archive
  }
  recordTranscript(record: Record<string, unknown>): void { this.archive?.transcript(record) }
  flushEvents(): void { this.archive?.flushEvents() }
  readonly streamId = randomUUID()
  private events: CommandEvent[] = []
  private nextSeq = 1
  private readonly subscribers = new Set<(event: CommandEvent) => void>()
  private readonly controllers = new WeakSet<ProgramController>()
  private readonly bindings = new Map<string, Pick<CommandEvent, 'commandId' | 'source' | 'sessionKey'>>()
  private readonly execution = new Map<string, GoalExecution>()

  /** 后续合并版本生效时，也更新其中保留的旧命令；不靠 refresh 的回显判断成功。 */
  follow(controller: ProgramController, runtime?: TaskRuntime): void {
    if (this.controllers.has(controller)) return
    this.controllers.add(controller)
    controller.subscribe(event => {
      for (const goalId of event.goalIds) {
        const binding = this.bindings.get(goalId)
        if (!binding || binding.sessionKey !== event.sessionKey) continue
        this.emit({ ...binding, goalId, owner: event.owner, stage: event.stage,
          ...(event.version !== undefined ? { version: event.version } : {}),
          ...(event.error ? { error: event.error } : {}),
        })
      }
      if (runtime) this.syncRuntime(runtime)
    })
  }

  /** 每份既有快照处理后比对精简状态，只在发生变化时发事件。 */
  syncRuntime(runtime: TaskRuntime): void {
    for (const [goalId, binding] of this.bindings) {
      const previous = this.execution.get(goalId)
      const execution = binding.sessionKey === runtime.battleKey ? runtime.goalExecution(goalId)
        : previous?.state === 'completed' ? previous : { state: 'cancelled' as const, detail: '对局已结束或切换' }
      if (!execution || JSON.stringify(previous) === JSON.stringify(execution)) continue
      this.execution.set(goalId, execution)
      const program = runtime.programs.get(runtime.goals.get(goalId)?.ownerId ?? '')
      this.emit({ ...binding, goalId, stage: 'execution', execution,
        ...(program ? { owner: program.id } : {}),
        ...(program?.script && !['completed', 'cancelled'].includes(execution.state) ? { version: program.script.version } : {}),
      })
    }
  }

  /** 从同局归档恢复展示与目标关联；不重放命令，不将归档当作运行状态。 */
  restoreCurrent(root: string, runtime: TaskRuntime): void {
    const archive = this.ensureArchive(root), history = archive.commandHistory(runtime.battleKey)
    const existing = new Set(this.events.map(event => event.commandId))
    for (const event of history.events) if (!existing.has(event.commandId)) this.accept({ ...event, seq: this.nextSeq++ }, false)
    // 兼容启用完整事件流前的旧转写；只补足未记录的卡片和绑定。
    for (const record of history.transcripts) {
      const goals = ((record.goals ?? []) as GoalSpec[]).filter(goal => runtime.goals.has(goal.id) && !this.bindings.has(goal.id))
      const id = String(record.requestId).replace(/^restored-/, ''), visible = this.events.some(event => event.commandId === id)
      const base = { commandId: id, source: (record.source ?? 'restored') as CommandSource, sessionKey: runtime.battleKey, at: Number(record.at) || Date.now() }
      if (!visible) {
        this.accept({ ...base, seq: this.nextSeq++, stage: 'received', text: String(record.text) }, false)
        if (record.plan?.summary) this.accept({ ...base, seq: this.nextSeq++, stage: 'understood', summary: record.plan.summary }, false)
        for (const error of record.skipped ?? []) this.accept({ ...base, seq: this.nextSeq++, stage: 'skipped', error }, false)
      }
      for (const goal of goals) {
        const state = runtime.goals.get(goal.id)!
        this.accept({ ...base, seq: this.nextSeq++, stage: 'bound', goalId: goal.id, owner: state.ownerId, choice: goal.rawText }, false)
        const program = runtime.programs.get(state.ownerId)
        if (!state.activeSpec && program?.compileError) this.accept({ ...base, seq: this.nextSeq++, stage: 'failed', goalId: goal.id, owner: state.ownerId, error: program.compileError }, false)
      }
      if (!visible && ['completed', 'failed', 'cancelled'].includes(record.terminalStage)) this.accept({ ...base, seq: this.nextSeq++, stage: record.terminalStage, ...(record.terminalError ? { error: record.terminalError } : {}) }, false)
    }
    for (const commandId of new Set(this.events.map(event => event.commandId))) {
      const events = this.events.filter(event => event.commandId === commandId)
      if (events.some(event => event.goalId && runtime.goals.has(event.goalId))) continue
      let card: CardData | undefined
      events.forEach((event, index) => { card = applyCommandEvent({ ...event, seq: index + 1 }, card) })
      if (card && !['completed', 'partial-completed', 'failed', 'cancelled'].includes(card.stage)) {
        const last = events.at(-1)!
        this.emit({ commandId, source: last.source, sessionKey: runtime.battleKey, stage: 'cancelled', error: '命令处理在重启前中断，未恢复后续步骤；实际成果以最后观察为准' })
      }
    }
    this.syncRuntime(runtime)
  }

  emit(event: Omit<CommandEvent, 'seq' | 'at'> & { at?: number }): CommandEvent {
    const full: CommandEvent = { ...event, seq: this.nextSeq++, at: event.at ?? Date.now() }
    return this.accept(full, true)
  }
  private accept(full: CommandEvent, archive: boolean): CommandEvent {
    if (archive) this.archive?.event(full)
    this.events.push(full)
    if (full.stage === 'bound' && full.goalId) this.bindings.set(full.goalId, { commandId: full.commandId, source: full.source, ...(full.sessionKey ? { sessionKey: full.sessionKey } : {}) })
    if (full.stage === 'execution' && full.goalId && full.execution) this.execution.set(full.goalId, full.execution)
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS)
      const kept = new Set(this.events.map(event => event.commandId))
      for (const [id, binding] of this.bindings) if (!kept.has(binding.commandId)) { this.bindings.delete(id); this.execution.delete(id) }
    }
    for (const subscriber of this.subscribers) {
      try { subscriber(full) } catch { this.subscribers.delete(subscriber) }
    }
    return full
  }

  /** 订阅实时事件；返回退订函数。 */
  subscribe(subscriber: (event: CommandEvent) => void): () => void {
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }

  /** 断线补齐：返回序号之后的事件。 */
  since(seq: number): CommandEvent[] {
    return this.events.filter((event) => event.seq > seq)
  }

  lastSeq(): number {
    return this.nextSeq - 1
  }
}

/** 转写处理的事件发射接口（runTranscript 埋点用）。 */
export interface TraceOptions {
  commandId: string
  source: CommandSource
  log: CommandLog
}

export function newCommandId(): string {
  return `cmd-${randomUUID().slice(0, 8)}`
}
