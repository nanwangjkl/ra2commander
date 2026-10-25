import type { ActionRequest, Region, StepConstraints } from './index.ts'

export type ScriptOwner = { kind: 'global' } | { kind: 'formation'; formationId: string }
export const ownerId = (owner: ScriptOwner): string => owner.kind === 'global' ? 'global' : `formation:${owner.formationId}`

interface GoalBase { id: string; rawText: string; label?: string }
export interface CombatGoal extends GoalBase {
  kind: 'combat'
  formationId: string
  region: Region
  allowedActions: ActionRequest['kind'][]
  /** 守区可包含就位点，抵达后仍持续；缺省兼容已有移动/清敌目标。 */
  mode?: 'move' | 'hold' | 'assault'
  retreat?: { lossAbove: number; x: number; y: number }
  transforms?: Record<string, string>
  destination?: { x: number; y: number; name?: string }
  /** 同一命令内的有序路点；宿主推进进度，模型只读取本步 destination。 */
  route?: Array<{ x: number; y: number; name?: string }>
  /** 按有限路线巡逻，途中可交战，走完末站后完成。 */
  patrol?: boolean
  /** 区域清敌的选敌范围，独立于行军地域；到达 destination 不表示清敌完成。 */
  attackRegion?: import('./spatial.ts').TargetRegion
}
export interface DeployGoal extends GoalBase { kind: 'deploy'; unitIds: number[]; target: string }
export interface ProductionGoal extends GoalBase {
  kind: 'production'
  target: string
  quantity: number
  prerequisites: string[]
  queues: number[]
  targetType?: number
  queueTypes?: Record<string, number>
  formationId?: string
  /** 明确要求持续补电时，按实时电力及未完成建设的电耗计算目标总量。 */
  maintainPower?: { reserve: number; output: number }
  powerCosts?: Record<string, number>
}
export type FormationRequest =
  | { kind: 'createFormation'; formationId: string; unitIds: number[]; force?: boolean }
  | { kind: 'transferUnits'; formationId: string; unitIds: number[] }
  | { kind: 'dissolveFormation'; formationId: string }
export interface FormationGoal extends GoalBase { kind: 'formation'; request: FormationRequest; sourceOwners?: Array<[number, string | null]> }
export interface ReinforceGoal extends GoalBase {
  kind: 'reinforce'
  formationId: string
  name: string
  targetSize: number
  /** null 表示未编队单位。 */
  source: string | null
}
export interface RallyGoal extends GoalBase { kind: 'rally'; unitIds: number[]; x: number; y: number }
export type GoalSpec = CombatGoal | DeployGoal | ProductionGoal | FormationGoal | ReinforceGoal | RallyGoal
export const goalOwner = (goal: GoalSpec): ScriptOwner => goal.kind === 'combat' ? { kind: 'formation', formationId: goal.formationId } : { kind: 'global' }

export interface ScriptAction { goalId: string; request: ActionRequest | FormationRequest }
/** 本步部队主体是否抵达目的地；宿主与脚本共用，不要求全队挤到同一点。 */
export interface ArrivalState {
  reached: boolean
  radius: number
  nearby: number
  required: number
  total: number
  laggingUnitIds: number[]
}
export interface GoalView {
  spec: GoalSpec
  unitIds: number[]
  produceRemaining: Record<string, number>
  submitted: Record<string, number>
  observed: Record<string, number[]>
  uncertain: string[]
  lossRatio: number
  retreatActive: boolean
  blocked?: string
  maxUnits?: number
  arrival?: ArrivalState
  productionPlan?: {
    missingPrerequisites: string[]
    pendingPrerequisites: string[]
    availableToProduce: string[]
    readyToPlace: string[]
  }
}
export interface ControlFrame {
  owner: ScriptOwner
  goals: GoalView[]
  formations: Array<{ id: string; memberIds: number[] }>
}
export interface ManagementConstraints {
  kind: FormationRequest['kind']
  formationId: string
  allowedUnitIds: number[]
  maxUnits: number
  force?: boolean
  exact?: boolean
}
export interface GoalConstraints extends Omit<StepConstraints, 'goals'> {
  management?: ManagementConstraints
  destination?: { x: number; y: number }
}
