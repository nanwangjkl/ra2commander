import type { GoalSpec, ScriptOwner } from '@ra2c/contracts'

export interface GoalFacts {
  initialized: boolean
  members: Array<{ id: number; name: string; rx: number; ry: number }>
  lossRatio: number
  retreatTriggered: boolean
  done: boolean
  /** 已完成生产被追加总量时，保留前次完成事实供待生效/失败状态展示。 */
  completedQuantity?: number
  blocked?: string
  cancelReason?: string
  routeIndex?: number
  outcomeDetail?: string
  repair?: import('./repair.ts').RepairState
  placementBlocked?: boolean
  relocation?: import('./relocation.ts').RelocationState
  mining?: import('./mining.ts').MiningState
  attack?: import('./attack.ts').AttackState
}
export interface GoalState {
  ownerId: string
  spec: GoalSpec
  activeSpec?: GoalSpec
  status: 'pending' | 'active' | 'completed' | 'partial' | 'failed' | 'cancelled'
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
  placement?: import('@ra2c/contracts').BuildingPlacement
  placementRegion?: import('@ra2c/contracts').TargetRegion
  placementResults?: Array<{ unitId: number; x: number; y: number; elevation?: number; matched: boolean }>
}
export interface Handoff {
  goalId: string
  unitIds: number[]
  owners: Array<[number, string | null]>
}
export const emptyFacts = (): GoalFacts => ({ initialized: false, members: [], lossRatio: 0, retreatTriggered: false, done: false })
