// 由 prompts/capabilities/*.md 生成；修改定义后运行 pnpm capabilities:generate。
export const CAPABILITY_CONTRACT_VERSION = 'e054939867838fd33f3f352dd52649b774ea4277096148e631c266f1ee4d7de3'
export interface CapabilityParameters {
  "base.deploy": Record<string, never>
  "combat.attack-all": { formationId?: string }
  "combat.clear-region": { formationId: string; regionName: string }
  "combat.hold": { formationId: string; regionName?: string; bounds?: number[]; mode?: "hold" | "assault" | "move"; retreatLoss?: number; retreatX?: number; retreatY?: number; label?: string }
  "combat.move": { formationId: string; regionName?: string; x?: number; y?: number; bounds?: number[]; label?: string }
  "control.pause": { scope?: "formation" | "global" | "all" | "units"; formationId?: string; selector?: string; unitIds?: number[] }
  "control.resume": { scope?: "formation" | "global" | "all" | "units"; formationId?: string; selector?: string; unitIds?: number[] }
  "control.stop": { scope?: "formation" | "global" | "all" | "units"; formationId?: string; selector?: string; unitIds?: number[] }
  "formation.assign": { formationId: string; selector?: string; quantity?: number | 'all'; unitIds?: number[] }
  "formation.create": { formationId: string; selector?: string; unitIds?: number[]; force?: boolean }
  "formation.dissolve": { formationId: string }
  "formation.transfer": { formationId: string; selector?: string; quantity?: number | 'all'; unitIds?: number[]; sourceFormationId?: string }
  "goal.cancel": { goalId: string }
  "goal.edit": { goalId: string; quantity: number }
  "management.rally": { selector?: string; unitIds?: number[]; regionName?: string; x?: number; y?: number }
  "management.reinforce": { formationId: string; target: string; targetSize: number; sourceFormationId?: string }
  "production.power": { reserve?: number }
  "production.produce": { target: string; quantity?: number; formationId?: string; queues?: number[] }
}
export interface ResolvedCapabilityParameters {
  "base.deploy": Record<string, never>
  "combat.attack-all": { formationId?: string }
  "combat.clear-region": { formationId: string; regionName: string }
  "combat.hold": { formationId: string; regionName?: string; bounds?: number[]; mode: "hold" | "assault" | "move"; retreatLoss?: number; retreatX?: number; retreatY?: number; label?: string }
  "combat.move": { formationId: string; regionName?: string; x?: number; y?: number; bounds?: number[]; label?: string }
  "control.pause": { scope: "formation" | "global" | "all" | "units"; formationId?: string; selector: string; unitIds?: number[] }
  "control.resume": { scope: "formation" | "global" | "all" | "units"; formationId?: string; selector: string; unitIds?: number[] }
  "control.stop": { scope: "formation" | "global" | "all" | "units"; formationId?: string; selector: string; unitIds?: number[] }
  "formation.assign": { formationId: string; selector: string; quantity: number | 'all'; unitIds?: number[] }
  "formation.create": { formationId: string; selector: string; unitIds?: number[]; force: boolean }
  "formation.dissolve": { formationId: string }
  "formation.transfer": { formationId: string; selector: string; quantity: number | 'all'; unitIds?: number[]; sourceFormationId?: string }
  "goal.cancel": { goalId: string }
  "goal.edit": { goalId: string; quantity: number }
  "management.rally": { selector: string; unitIds?: number[]; regionName?: string; x?: number; y?: number }
  "management.reinforce": { formationId: string; target: string; targetSize: number; sourceFormationId?: string }
  "production.power": { reserve: number }
  "production.produce": { target: string; quantity: number; formationId?: string; queues: number[] }
}
export type CapabilityId = keyof CapabilityParameters
export type CapabilityCall = { [Id in CapabilityId]: { capability: Id; params: CapabilityParameters[Id] } }[CapabilityId]
export type ResolvedCapabilityCall = { [Id in CapabilityId]: { capability: Id; params: ResolvedCapabilityParameters[Id] } }[CapabilityId]
