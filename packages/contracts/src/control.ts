import type { ActionRequest, Region, StepConstraints } from './index.ts'

export type ScriptOwner = { kind: 'global' } | { kind: 'formation'; formationId: string }
export const ownerId = (owner: ScriptOwner): string => owner.kind === 'global' ? 'global' : `formation:${owner.formationId}`

interface GoalBase { id: string; rawText: string; label?: string }
export interface CombatGoal extends GoalBase {
  kind: 'combat'
  formationId: string
  region: Region
  allowedActions: ActionRequest['kind'][]
  retreat?: { lossAbove: number; x: number; y: number }
  transforms?: Record<string, string>
}
export interface ProductionGoal extends GoalBase {
  kind: 'production'
  target: string
  quantity: number
  prerequisites: string[]
  queues: number[]
  targetType?: number
  queueTypes?: Record<string, number>
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
export type GoalSpec = CombatGoal | ProductionGoal | FormationGoal | ReinforceGoal | RallyGoal
export const goalOwner = (goal: GoalSpec): ScriptOwner => goal.kind === 'combat' ? { kind: 'formation', formationId: goal.formationId } : { kind: 'global' }

export interface ScriptAction { goalId: string; request: ActionRequest | FormationRequest }
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
