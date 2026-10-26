// 由 prompts/capabilities/*.md 生成；修改定义后运行 pnpm capabilities:generate。
export const CAPABILITY_CONTRACT_VERSION = '447e1009e2e3c0ffada1c72906b7791e372b2807307ebc65642a004883a0b1ea'
export interface CapabilityParameters {
  "base.deploy": Record<string, never>
  "combat.attack-all": { formationId?: string }
  "combat.clear-region": { formationId: string; regionName: string }
  "combat.hold": { formationId: string; regionName?: string; bounds?: number[]; mode?: "hold" | "assault" | "move"; retreatLoss?: number; retreatX?: number; retreatY?: number; label?: string }
  "combat.move": { formationId: string; regionName?: string; x?: number; y?: number; bounds?: number[]; label?: string; patrol?: boolean }
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
  "map.explore": { formationId: string; regionName?: string }
  "production.power": { reserve?: number }
  "production.produce": { target: string; quantity?: number; formationId?: string; queues?: number[] }
  "skill.cancel": { runId?: string; skillId?: string; all?: boolean }
  "skill.run": { skillId: string; quantity?: number; memberSource?: "auto" | "existing" | "new"; useExisting?: boolean; formationId?: string; followFormationId?: string; regionName?: string }
  "transport.enter": { unitIds: number[]; transportId: number }
  "vehicle.repair": { formationId: string; followFormationId?: string; targetId?: number }
}
export interface ResolvedCapabilityParameters {
  "base.deploy": Record<string, never>
  "combat.attack-all": { formationId?: string }
  "combat.clear-region": { formationId: string; regionName: string }
  "combat.hold": { formationId: string; regionName?: string; bounds?: number[]; mode: "hold" | "assault" | "move"; retreatLoss?: number; retreatX?: number; retreatY?: number; label?: string }
  "combat.move": { formationId: string; regionName?: string; x?: number; y?: number; bounds?: number[]; label?: string; patrol: boolean }
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
  "map.explore": { formationId: string; regionName?: string }
  "production.power": { reserve: number }
  "production.produce": { target: string; quantity: number; formationId?: string; queues: number[] }
  "skill.cancel": { runId?: string; skillId?: string; all: boolean }
  "skill.run": { skillId: string; quantity?: number; memberSource?: "auto" | "existing" | "new"; useExisting?: boolean; formationId?: string; followFormationId?: string; regionName?: string }
  "transport.enter": { unitIds: number[]; transportId: number }
  "vehicle.repair": { formationId: string; followFormationId?: string; targetId?: number }
}
export type CapabilityId = keyof CapabilityParameters
export type CapabilityCall = { [Id in CapabilityId]: { capability: Id; params: CapabilityParameters[Id] } }[CapabilityId]
export type ResolvedCapabilityCall = { [Id in CapabilityId]: { capability: Id; params: ResolvedCapabilityParameters[Id] } }[CapabilityId]
