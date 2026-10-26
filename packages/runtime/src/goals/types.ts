import type { ActionRequest, ActionResult, GoalConstraints, GoalExecution, GoalSpec, GoalView, Snapshot } from '@ra2c/contracts'
import type { FormationRegistry } from '../formation.ts'
import type { ExplorationStore } from '../exploration.ts'
import type { GoalFacts, GoalState, Handoff, ProductionRecord, ProgramState } from '../state.ts'

export type GoalKind = GoalSpec['kind']
type Specs = { [K in GoalKind]: Extract<GoalSpec, { kind: K }> }
export type Spec<K extends GoalKind> = Specs[K]
export type MapSize = Pick<Snapshot, 'mapWidth' | 'mapHeight'>
/** 处理器只接触目标事实与公开观察；编译、调度、交接和提交由协调器负责。 */
export interface GoalContext<K extends GoalKind = GoalKind> {
  spec: Spec<K>
  goal: Omit<GoalState, 'facts'> & { facts: GoalFacts<K> }
  snap: Snapshot
  goals: ReadonlyMap<string, GoalState>
  programs: ReadonlyMap<string, ProgramState>
  formations: FormationRegistry
  production: readonly ProductionRecord[]
  pausedQueues: ReadonlyMap<number, string>
  handoffs: readonly Handoff[]
  exploration: ExplorationStore
  locked(id: number): boolean
  hasPlannedFormation(id: string): boolean
}
export interface GoalProjection { constraints: GoalConstraints; view: GoalView }
export interface GoalHandler<K extends GoalKind = GoalKind> {
  validateSpec(spec: Spec<K>, map: MapSize): void
  validateLive?(context: GoalContext<K>): void
  validateFacts?(goal: GoalState, map: MapSize): void
  initialize?(context: GoalContext<K>): void
  /** 在产物观察之前识别变形 ID，避免把变形产物误记成新生产。 */
  track?(context: GoalContext<K>): number[]
  observe?(context: GoalContext<K>): { stopIds: number[] } | void
  /** 探索在同轮生产与交接目标观察之后结算。 */
  observeLast?: boolean
  project(context: GoalContext<K>): GoalProjection
  execution?(context: GoalContext<K>, projection: GoalProjection): GoalExecution | undefined
  terminalExecution?(context: GoalContext<K>): GoalExecution | undefined
  progress?(context: GoalContext<K>, view: GoalView): Pick<GoalExecution, 'progress' | 'detail'>
  continuous?(context: GoalContext<K>): boolean
  managedMembers?(context: GoalContext<K>): number[]
  stopMembers?(context: GoalContext<K>): number[]
  pause?(context: GoalContext<K>): void
  beforeSubmit?(context: GoalContext<K>, request: ActionRequest): void
  /** true 表示该类目标已经处理本回执，协调器不再把它计为通用故障。 */
  afterSubmit?(context: GoalContext<K>, request: ActionRequest, results: ActionResult[]): boolean | void
}
