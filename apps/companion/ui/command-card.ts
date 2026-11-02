import type { CommandEvent, CommandSource, CommandStage, GoalExecution } from '../../../packages/contracts/src/command-log.ts'

export interface CardGoal {
  choice: string
  owner?: string
  stage: CommandStage
  executionMode?: CommandEvent['executionMode']
  version?: number
  error: string
  execution?: GoalExecution
}
export interface CardData {
  stage: CommandStage | GoalExecution['state'] | 'partial' | 'partial-completed'
  source: CommandSource
  at: number
  text: string
  summary: string
  goals: Map<string, CardGoal>
  skipped: Set<string>
  error: string
  lastSeq: number
}

export function applyCommandEvent(event: CommandEvent, previous?: CardData): CardData {
  const data = previous ?? { stage: 'received', source: event.source, at: event.at, text: event.text ?? '', summary: '', goals: new Map(), skipped: new Set(), error: '', lastSeq: -1 }
  if (event.seq <= data.lastSeq) return data
  if (event.seq > 0.5 && data.lastSeq <= 0.5) data.error = ''
  data.lastSeq = event.seq
  if (event.text) data.text = event.text
  if (event.summary) data.summary = event.summary
  if (event.stage === 'received' && event.source !== 'voice') data.at = event.at
  if (event.stage === 'skipped') data.skipped.add(event.error ?? '无法执行')
  else if (event.goalId || event.owner) {
    if (event.goalId && !data.goals.has(event.goalId)) {
      data.goals.set(event.goalId, { choice: event.choice ?? event.goalId, stage: 'bound', error: '', ...(event.owner ? { owner: event.owner } : {}) })
    }
    for (const [id, goal] of data.goals) {
      if (event.goalId ? id !== event.goalId : goal.owner !== event.owner || event.executionMode && (goal.executionMode ?? 'script') !== event.executionMode) continue
      if (event.executionMode && goal.executionMode && event.executionMode !== goal.executionMode) delete goal.execution
      if (event.stage === 'execution') goal.execution = event.execution
      else goal.stage = event.stage
      if (event.choice) goal.choice = event.choice
      if (event.owner) goal.owner = event.owner
      if (event.executionMode) goal.executionMode = event.executionMode
      if (goal.executionMode === 'native') delete goal.version
      else if (event.version !== undefined) goal.version = event.version
      if (event.stage !== 'execution') goal.error = event.stage === 'merged' ? '' : event.error ?? ''
    }
  } else {
    data.stage = event.stage
    if (event.stage === 'failed' || event.stage === 'cancelled') {
      data.error = event.error ?? ''
      for (const goal of data.goals.values()) {
        // 合并目标仍在等待新版本；一条解析请求结束不撤销它。
        if (['bound', 'binding', 'generating'].includes(goal.stage)) { goal.stage = event.stage; goal.error = event.error ?? '' }
      }
    }
  }
  if (data.goals.size) {
    const stages = [...data.goals.values()].map(goal => goal.execution?.state ?? goal.stage)
    const effective = stages.filter(stage => stage === 'effective').length
    const succeeded = stages.some(stage => ['effective', 'pending', 'running', 'continuous', 'completed'].includes(stage))
    if (stages.every(stage => stage === 'completed')) { data.stage = data.skipped.size ? 'partial-completed' : 'completed'; data.error = '' }
    else if (stages.some(stage => ['bound', 'binding', 'generating'].includes(stage))) data.stage = 'generating'
    else if (stages.includes('merged')) data.stage = 'merged'
    else if (stages.includes('faulted')) data.stage = 'faulted'
    else if (stages.includes('blocked')) data.stage = 'blocked'
    else if (stages.includes('paused')) data.stage = 'paused'
    else if (stages.includes('partial') || stages.includes('failed') || stages.includes('cancelled')) data.stage = succeeded || stages.includes('partial')
      ? stages.every(stage => ['completed', 'partial', 'failed', 'cancelled'].includes(stage)) ? 'partial-completed' : 'partial'
      : stages.includes('failed') ? 'failed' : 'cancelled'
    else if (stages.includes('running')) data.stage = data.skipped.size ? 'partial' : 'running'
    else if (stages.includes('continuous')) data.stage = data.skipped.size ? 'partial' : 'continuous'
    else if (stages.includes('pending')) data.stage = 'pending'
    else if (effective === stages.length) {
      data.error = ''
      data.stage = data.skipped.size ? 'partial' : 'effective'
    } else data.stage = 'running'
  }
  if (!data.goals.size && data.stage === 'completed' && data.skipped.size) data.stage = 'partial-completed'
  return data
}
