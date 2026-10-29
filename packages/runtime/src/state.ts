import type { GoalSpec, ScriptOwner } from '@ra2c/contracts'

export interface CommonGoalFacts {
  initialized: boolean
  members: Array<{ id: number; name: string; rx: number; ry: number }>
  lossRatio: number
  retreatTriggered: boolean
  blocked?: string
  cancelReason?: string
  outcomeDetail?: string
  nativeError?: string
  endedByBattle?: 'victory' | 'defeat'
}
/** 保持 v4 字段兼容，按目标类型列明进度归属。 */
export interface GoalProgress {
  routeIndex?: number
  coverMotion?: import('./cover.ts').CoverMotion
  coverEnded?: string
  /** 解除掩护后继续原攻击的原掩护成员；不扩大到其他编队或后来无关产物。 */
  coverReleasedIds?: number[]
  /** 已完成生产被追加总量时，保留前次完成事实供待生效/失败状态展示。 */
  completedQuantity?: number
  placementBlocked?: boolean
  rallyBlocked?: boolean
  cancelProduction?: boolean
  repair?: import('./repair.ts').RepairState
  relocation?: import('./relocation.ts').RelocationState
  mining?: import('./mining.ts').MiningState
  attack?: import('./attack.ts').AttackState
  building?: import('./building.ts').BuildingState
  unitDeployment?: import('./unit-deployment.ts').UnitDeploymentState
  baseDefense?: import('./base-defense.ts').BaseDefenseState
}
export interface GoalFactKeys {
  combat: 'routeIndex' | 'coverMotion' | 'coverEnded' | 'baseDefense'
  production: 'completedQuantity' | 'placementBlocked' | 'rallyBlocked' | 'cancelProduction'
  repair: 'repair'
  relocate: 'relocation'
  mining: 'mining'
  attack: 'attack' | 'coverMotion' | 'coverEnded' | 'coverReleasedIds'
  building: 'building'
  unitDeploy: 'unitDeployment'
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
  /** 脚本目标修订；本机目标增改不使无关编译失效。 */
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
  /** 实际队列减少确认的累计撤销量，不改写原始提交量。 */
  cancelledQuantity?: number
  cancellation?: {
    state: 'prepared' | 'sent' | 'unknown' | 'confirmed'
    quantity: number
    before: number
    queueType: number
    seq: number
    tick: number
    observed: number
    knownIds: number[]
    born: number
    removed?: number
  }
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
