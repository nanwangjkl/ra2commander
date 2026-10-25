/** 工作台只接收命令阶段事件，不接收逐帧战场数据。 */
export type CommandStage = 'received' | 'understanding' | 'understood' | 'binding' | 'bound'
  | 'skipped' | 'generating' | 'merged' | 'effective' | 'failed' | 'cancelled' | 'execution' | 'completed'
export type CommandSource = 'sidebar' | 'cli' | 'restored'

/** 由宿主运行时事实生成；脚本提交成功不等于目标完成。 */
export interface GoalExecution {
  state: 'running' | 'continuous' | 'completed' | 'partial' | 'failed' | 'blocked' | 'paused' | 'faulted' | 'cancelled'
  detail?: string
  progress?: { completed: number; total: number; label?: string }
}

export interface CommandEvent {
  commandId: string
  seq: number
  at: number
  stage: CommandStage
  source: CommandSource
  text?: string
  summary?: string
  goalId?: string
  choice?: string
  error?: string
  owner?: string
  sessionKey?: string
  version?: number
  execution?: GoalExecution
}
