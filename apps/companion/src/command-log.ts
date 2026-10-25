import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandEvent, CommandSource, GoalExecution, GoalSpec } from '@ra2c/contracts'
import type { TaskRuntime } from '@ra2c/runtime'
import type { ProgramController } from './controller.ts'
export type { CommandEvent, CommandStage, CommandSource } from '@ra2c/contracts'

/**
 * 命令记录与结构化事件（阶段 2）：统一接入界面文本、终端 say 与 TCP say。
 * 事件在发生时立即推送（SSE），侧栏据此增量渲染卡片；不解析终端输出。
 * 历史仅保存在内存（带总量上限），记录恢复属于阶段 3。
 */
const MAX_EVENTS = 2000

export class CommandLog {
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

  /** 本次更新重启后，复用已有转写文件恢复当前局卡片，不重放命令。 */
  restoreCurrent(root: string, runtime: TaskRuntime): void {
    const folder = join(root, '.runtime/transcripts')
    let files: Array<{ file: string; at: number }>
    try { files = readdirSync(folder).filter(file => file.endsWith('.json')).map(file => ({ file, at: statSync(join(folder, file)).mtimeMs })).sort((a, b) => a.at - b.at) } catch { return }
    for (const { file, at } of files) {
      try {
        const record = JSON.parse(readFileSync(join(folder, file), 'utf8')) as { requestId: string; text: string; at?: number; sessionKey: string; plan?: { summary?: string }; goals?: GoalSpec[]; choices?: string[]; skipped?: string[]; terminalStage?: 'completed' | 'failed' | 'cancelled'; terminalError?: string; source?: CommandSource }
        if (record.sessionKey !== runtime.battleKey || typeof record.text !== 'string' || !Array.isArray(record.goals)) continue
        const goals = record.goals.filter(goal => runtime.goals.has(goal.id) && !this.bindings.has(goal.id))
        const base = { commandId: `restored-${record.requestId || file}`, source: record.source ?? 'restored' as CommandSource, sessionKey: record.sessionKey, at: record.at ?? at }
        if (this.events.some(event => event.commandId === base.commandId)) continue
        if (!record.goals.length && ['completed', 'failed', 'cancelled'].includes(record.terminalStage ?? '')) {
          this.emit({ ...base, stage: 'received', text: record.text })
          if (record.plan?.summary) this.emit({ ...base, stage: 'understood', summary: record.plan.summary })
          for (const error of record.skipped ?? []) this.emit({ ...base, stage: 'skipped', error })
          this.emit({ ...base, stage: record.terminalStage!, ...(record.terminalError ? { error: record.terminalError } : {}) })
          continue
        }
        if (!goals.length) continue
        this.emit({ ...base, stage: 'received', text: record.text })
        const summary = record.choices?.length === record.goals.length
          ? goals.map(goal => record.choices![record.goals!.indexOf(goal)]).join('；') : record.plan?.summary
        if (summary) this.emit({ ...base, stage: 'understood', summary })
        for (const goal of goals) {
          const state = runtime.goals.get(goal.id)!
          const choice = record.choices?.length === record.goals.length ? record.choices[record.goals.indexOf(goal)] : undefined
          this.emit({ ...base, stage: 'bound', goalId: goal.id, owner: state.ownerId, choice: choice ?? goal.rawText })
          const program = runtime.programs.get(state.ownerId)
          if (!state.activeSpec && program?.compileError) this.emit({ ...base, stage: 'failed', goalId: goal.id, owner: state.ownerId, error: program.compileError })
        }
      } catch { /* 单份旧记录损坏不阻断当前对局。 */ }
    }
    this.syncRuntime(runtime)
  }

  emit(event: Omit<CommandEvent, 'seq' | 'at'> & { at?: number }): CommandEvent {
    const full: CommandEvent = { ...event, seq: this.nextSeq++, at: event.at ?? Date.now() }
    this.events.push(full)
    if (full.stage === 'bound' && full.goalId) this.bindings.set(full.goalId, { commandId: full.commandId, source: full.source, ...(full.sessionKey ? { sessionKey: full.sessionKey } : {}) })
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS)
      const kept = new Set(this.events.map(event => event.commandId))
      for (const [id, binding] of this.bindings) if (!kept.has(binding.commandId)) { this.bindings.delete(id); this.execution.delete(id) }
    }
    // 展示通道失效不能中断游戏指令。
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
