import type { GoalSpec, ScriptOwner } from '@ra2c/contracts'

export interface GoalFacts {
  initialized: boolean
  members: Array<{ id: number; name: string; rx: number; ry: number }>
  lossRatio: number
  retreatTriggered: boolean
  done: boolean
  blocked?: string
}
export interface GoalState {
  ownerId: string
  spec: GoalSpec
  activeSpec?: GoalSpec
  status: 'pending' | 'active' | 'completed' | 'cancelled'
  facts: GoalFacts
}
export interface ProgramState {
  id: string
  owner: ScriptOwner
  goalIds: string[]
  activeGoalIds: string[]
  revision: number
  generation: number
  status: 'idle' | 'active' | 'paused' | 'stopped'
  script?: { code: string; version: number; hash: string; promptVersion?: string }
  memory: unknown
  compileError?: string
  stats: { steps: number; actions: number; rejected: number; errors: number; lastError?: string }
}
export interface ProductionRecord {
  id: string
  goalId: string
  name: string
  quantity: number
  building: boolean
  queueType?: number
  state: 'reserved' | 'submitted' | 'unknown' | 'rejected'
  observedIds: number[]
  placed: boolean
}
export interface Handoff {
  goalId: string
  unitIds: number[]
  owners: Array<[number, string | null]>
}
export const emptyFacts = (): GoalFacts => ({ initialized: false, members: [], lossRatio: 0, retreatTriggered: false, done: false })
