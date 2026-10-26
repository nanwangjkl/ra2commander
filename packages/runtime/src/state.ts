import type { GoalSpec, ScriptOwner } from '@ra2c/contracts'

export interface CommonGoalFacts {
  initialized: boolean
  members: Array<{ id: number; name: string; rx: number; ry: number }>
  lossRatio: number
  retreatTriggered: boolean
  blocked?: string
  cancelReason?: string
  outcomeDetail?: string
}
/** 保持 v4 字段兼容，按目标类型列明进度归属。 */
export interface GoalProgress {
  routeIndex?: number
  /** 已完成生产被追加总量时，保留前次完成事实供待生效/失败状态展示。 */
  completedQuantity?: number
  placementBlocked?: boolean
  repair?: import('./repair.ts').RepairState
  relocation?: import('./relocation.ts').RelocationState
  mining?: import('./mining.ts').MiningState
  attack?: import('./attack.ts').AttackState
  building?: import('./building.ts').BuildingState
}
export interface GoalFactKeys {
  combat: 'routeIndex'
  production: 'completedQuantity' | 'placementBlocked'
  repair: 'repair'
  relocate: 'relocation'
  mining: 'mining'
  attack: 'attack'
  building: 'building'
  explore: never
  deploy: never
  formation: never
  reinforce: never
  rally: never
  transport: never
}
export type GoalFacts<K extends GoalSpec['kind'] = GoalSpec['kind']> = CommonGoalFacts & Pick<GoalProgress, GoalFactKeys[K]>

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
export const emptyFacts = (): GoalFacts => ({ initialized: false, members: [], lossRatio: 0, retreatTriggered: false })
