import type { ActionRequest, Region, StepConstraints } from './index.ts'

export type ScriptOwner = { kind: 'global' } | { kind: 'formation'; formationId: string }
export const ownerId = (owner: ScriptOwner): string => owner.kind === 'global' ? 'global' : `formation:${owner.formationId}`

export type GoalExecutionMode = 'script' | 'native'
interface GoalBase { id: string; rawText: string; label?: string; executionMode?: GoalExecutionMode; skill?: { runId: string; id: string; version: string; hash: string; instructions: string } }
/** 无标记的旧目标继续使用脚本，恢复时不悄悄改变动作来源。 */
export const goalExecutionMode = (spec: GoalSpec): GoalExecutionMode => spec.executionMode ?? 'script'
export interface ExploreGoal extends GoalBase {
  kind: 'explore'
  formationId: string
  explorationId: string
  preparationGoalId?: string
  policy: { pointSpacing: number; stallTicks: number; maxStallsPerRegion: number; coverageRatio?: number; interiorMargin?: number; retryPasses?: number; centerFirst?: boolean }
}
export interface CombatGoal extends GoalBase {
  /** 可能暂时离场且公开 API 不能确认阵亡的兵种；缺席保留命令，不自动补兵。 */
  temporaryAbsenceNames?: string[]
  memberNames?: Record<number, string>
  objective?: import('./attack-objective.ts').AttackObjective
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
  /** 防区跟随指定基地车及其展开形态；无入侵者原地待命。 */
  baseDefense?: { anchorId: number; anchorNames: string[]; position: { x: number; y: number }; region: import('./spatial.ts').TargetRegion }
}
export interface DeployGoal extends GoalBase { kind: 'deploy'; unitIds: number[]; target: string }
export interface UnitDeploymentGoal extends GoalBase {
  kind: 'unitDeploy'
  unitIds: number[]
  formationId?: string
  deployed: boolean
  transientNames?: string[]
  excludedIds?: number[]
  /** 只接收明确生产来源的产物，不凭兵种接管后来无关的新单位。 */
  sources: Array<{ goalId: string; name: string; quantity: number }>
  destination?: { x: number; y: number; name?: string }
  targetRegion?: import('./spatial.ts').TargetRegion
}
export interface AttackGoal extends GoalBase {
  temporaryAbsenceNames?: string[]
  /** 发令时已知的成员身份，支持蜘蛛离场期间改令，不扩大到同型新单位。 */
  memberNames?: Record<number, string>
  kind: 'attack'
  objective?: import('./attack-objective.ts').AttackObjective
  membership?: import('./attack-objective.ts').AttackMembership
  unitIds: number[]
  aircraftIds: number[]
  formationId?: string
  /** 旧 v4 兼容字段；新目标使用 membership 限定具体准备来源。 */
  dynamicNames?: string[]
  preparationGoalIds: string[]
  ammoCapacity: Record<string, number>
  targetKind: 'enemies' | 'base' | 'units' | 'buildings'
  targetNames: string[]
  targetId?: number
  targetRegion?: import('./spatial.ts').TargetRegion
}
export interface RelocateGoal extends GoalBase {
  kind: 'relocate'
  unitId: number
  origin: { x: number; y: number }
  vehicleName: string
  yardName: string
  destination: { x: number; y: number; name?: string }
  candidates: Array<{ x: number; y: number }>
  targetRegion?: import('./spatial.ts').TargetRegion
}
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
  /** 只在原话指定方位时设置；顺序对应本目标逐座新增建筑。 */
  placement?: import('./placement.ts').BuildingPlacement
  placementRegion?: import('./spatial.ts').TargetRegion
  afterGoalId?: string
  unlockConditions?: Array<{ name: string; reason: string; requiresExisting?: boolean }>
}
export type FormationRequest =
  | { kind: 'createFormation'; formationId: string; unitIds: number[]; force?: boolean }
  | { kind: 'transferUnits'; formationId: string; unitIds: number[] }
  | { kind: 'dissolveFormation'; formationId: string }
export interface CoverPolicy { runId: string; escortIds: number[]; escortSources?: Array<{ goalId: string; quantity: number }>; protectedSources?: string[]; gap: number; resumeGap: number; retryTicks: number; predictionTicks?: number; replanTicks?: number; version: string }
export interface FormationGoal extends GoalBase { kind: 'formation'; request: FormationRequest; sourceOwners?: Array<[number, string | null]>; cover?: CoverPolicy }
export interface ReinforceGoal extends GoalBase {
  kind: 'reinforce'
  formationId: string
  name: string
  targetSize: number
  /** null 表示未编队单位。 */
  source: string | null
}
export interface RallyGoal extends GoalBase { kind: 'rally'; unitIds: number[]; x: number; y: number }
export interface TransportGoal extends GoalBase { kind: 'transport'; unitIds: number[]; transportId: number }
export interface MiningGoal extends GoalBase {
  kind: 'mining'
  unitIds: number[]
  formationId?: string
  targetRegion: import('./spatial.ts').TargetRegion
  destination: { x: number; y: number }
}
export interface RepairGoal extends GoalBase {
  kind: 'repair'; formationId: string; vehicleNames: string[]; engineerNames: string[]; tankNames: string[]
  preparationGoalIds: string[]; quantity?: number; targetId?: number; followFormationId?: string
  policy: { retryTicks: number; stallTicks: number }
}
export interface BuildingGoal extends GoalBase {
  kind: 'building'
  operation: 'repair' | 'sell'
  unitIds: number[]
}
export type GoalSpec = CombatGoal | AttackGoal | ExploreGoal | DeployGoal | UnitDeploymentGoal | RelocateGoal | ProductionGoal | FormationGoal | ReinforceGoal | RallyGoal | TransportGoal | MiningGoal | RepairGoal | BuildingGoal
export const goalOwner = (goal: GoalSpec): ScriptOwner => goal.kind === 'combat' || goal.kind === 'explore' || goal.kind === 'repair' || (goal.kind === 'mining' || goal.kind === 'attack' || goal.kind === 'unitDeploy') && goal.formationId ? { kind: 'formation', formationId: goal.formationId! } : { kind: 'global' }

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
  cover?: { protectedIds: number[]; escortIds: number[]; slowestIds: number[]; heldIds: number[]; catchingUpIds?: number[]; detail: string }
  relocation?: { phase: 'packing' | 'moving' | 'deploying' | 'confirming' | 'completed' | 'failed'; unitId: number; destination: { x: number; y: number }; action?: ActionRequest; detail: string }
  mining?: { actions: ActionRequest[]; knownOre: number; assigned: number; total: number; detail: string }
  building?: { actions: ActionRequest[]; completed: number; total: number; failed: number; pending: boolean; detail: string }
  unitDeployment?: { actions: ActionRequest[]; completed: number; total: number; failed: number; pending: boolean; detail: string }
  attack?: { readyIds: number[]; pendingIds: number[]; attackingIds: number[]; firedIds: number[]; lostIds: number[]; unobservableIds?: number[]; totalAircraft: number; groundIds: number[]; targets: import('./index.ts').SnapshotUnit[]; preparing: boolean; detail: string }
  exploration?: { seen: number; total: number; coverageRatio: number; regions: Array<{ id: string; name: string; seen: number; total: number; satisfied: boolean; deferred: boolean }>; targets: Array<{ unitId: number; x: number; y: number; regionId: string }> }
  repair?: {
    readyIds: number[]; assembling: Array<{ engineerId: number; vehicleId: number }>
    targets: Array<{ unitId: number; targetId: number }>; damaged: Array<{ id: number; hitPoints: number; maxHitPoints: number }>
    follow?: { x: number; y: number }; waiting: boolean
  }
  productionPlan?: {
    pendingRallyIds?: number[]
    missingPrerequisites: string[]
    pendingPrerequisites: string[]
    availableToProduce: string[]
    readyToPlace: string[]
    unmetConditions?: Array<{ name: string; reason: string; requiresExisting?: boolean }>
    placement?: { completed: number; total: number; mismatchedIds: number[]; next?: import('./placement.ts').PlacementSlot }
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
  buildingActions?: ActionRequest[]
  blocked?: string
  relocationAction?: ActionRequest
  miningActions?: ActionRequest[]
  aircraftIds?: number[]
  management?: ManagementConstraints
  destination?: { x: number; y: number }
}
