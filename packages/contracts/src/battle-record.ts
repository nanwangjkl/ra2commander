import type { CommandEvent, GoalExecution } from './command-log.ts'

export type FeedbackRating = 'good' | 'partial' | 'bad'
export interface CommandFeedback {
  id: string
  at: number
  commandId: string
  rating: FeedbackRating
  note: string
  /** 用户反馈时已观察到的状态，不随后续运行改写。 */
  observed: CommandEvent[]
}
/** 游戏侧栏只读取当前命令及反馈，不加载跨局归档、提示词或代码。 */
export interface CurrentCommands {
  battleId: string | null
  sessionKey: string | null
  events: CommandEvent[]
  feedback: CommandFeedback[]
  warning: string
}
export interface BattleRecord {
  schemaVersion: 1 | 2 | 3
  id: string
  sessionKey: string
  startedAt: number
  updatedAt: number
  result?: { outcome: 'victory' | 'defeat'; tick: number; evidence: 'public-player-status' }
  events: CommandEvent[]
  transcripts: Record<string, Record<string, unknown>>
  compilations: Array<Record<string, unknown> & { id: string; goalIds: string[]; commandId?: string }>
  observations: Array<{ at: number; goals: Array<{ id: string; execution?: GoalExecution }>; [key: string]: unknown }>
  feedback: CommandFeedback[]
}
export interface BattleRecordInfo {
  id: string
  sessionKey: string
  startedAt: number
  updatedAt: number
  commands: number
  feedback: number
  issues: number
  result?: BattleRecord['result']
}
