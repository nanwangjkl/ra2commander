import { randomUUID } from 'node:crypto'

/**
 * 命令记录与结构化事件（阶段 2）：统一接入界面文本、终端 say 与 TCP say。
 * 事件在发生时立即推送（SSE），侧栏据此增量渲染卡片；不解析终端输出。
 * 历史仅保存在内存（带总量上限），记录恢复属于阶段 3。
 */
export type CommandStage =
  | 'received'    // 已收到（原话入库）
  | 'understanding' // 理解中（模型解析中）
  | 'understood'  // 理解完成（含摘要）
  | 'binding'     // 目标绑定中
  | 'bound'       // 单个目标绑定完成（含实际选择）
  | 'skipped'     // 单个操作无法绑定（含原因）
  | 'generating'  // 脚本生成中
  | 'effective'   // 脚本已生效（代码开始运行；运行反馈属阶段 3）
  | 'failed'      // 失败（模型/网络/解析/生成/绑定）
  | 'cancelled'   // 被后续命令取代或对局变化取消

export type CommandSource = 'sidebar' | 'cli'

export interface CommandEvent {
  commandId: string
  /** 全局递增序号；SSE 用 Last-Event-ID 断线补齐。 */
  seq: number
  at: number
  stage: CommandStage
  source: CommandSource
  text?: string
  /** 理解摘要（understood）。 */
  summary?: string
  /** 目标关联（bound/skipped/effective/failed 可带）。 */
  goalId?: string
  choice?: string
  error?: string
  /** 受影响的控制对象（effective/failed 可带）。 */
  owner?: string
}

const MAX_EVENTS = 2000

export class CommandLog {
  private events: CommandEvent[] = []
  private nextSeq = 1
  private readonly subscribers = new Set<(event: CommandEvent) => void>()

  emit(event: Omit<CommandEvent, 'seq' | 'at'> & { at?: number }): CommandEvent {
    const full: CommandEvent = { ...event, seq: this.nextSeq++, at: event.at ?? Date.now() }
    this.events.push(full)
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
    for (const subscriber of this.subscribers) subscriber(full)
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
