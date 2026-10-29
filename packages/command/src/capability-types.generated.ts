// 由 prompts/capabilities/*.md 生成；修改定义后运行 pnpm capabilities:generate。
export const CAPABILITY_CONTRACT_VERSION = '35e4defafbd05baaef44a5c13bb307ae828c85f0ee8cee27e272a12a3491823a'
export interface CapabilityParameters {
  "base.deploy": Record<string, never>
  "base.relocate": { regionName?: string; x?: number; y?: number; unitId?: number }
  "building.repair": { selector?: string; unitIds?: number[]; quantity?: number | 'all' }
  "building.sell": { selector?: string; unitIds?: number[]; quantity?: number | 'all' }
  "combat.attack-all": { selector?: string; unitIds?: number[]; formationId?: string }
  "combat.attack": { selector?: string; unitIds?: number[]; formationId?: string; quantity?: number | 'all'; target?: "enemies" | "base" | "units" | "buildings"; targetId?: number; regionName?: string }
  "combat.clear-region": { formationId: string; regionName: string }
  "combat.hold": { formationId: string; regionName?: string; bounds?: number[]; mode?: "hold" | "assault" | "move"; retreatLoss?: number; retreatX?: number; retreatY?: number; label?: string }
  "combat.move": { formationId: string; regionName?: string; x?: number; y?: number; bounds?: number[]; label?: string; patrol?: boolean }
  "control.pause": { scope?: "formation" | "global" | "all" | "units"; formationId?: string; selector?: string; unitIds?: number[] }
  "control.resume": { scope?: "formation" | "global" | "all" | "units"; formationId?: string; selector?: string; unitIds?: number[] }
  "control.stop": { scope?: "formation" | "global" | "all" | "units"; formationId?: string; selector?: string; unitIds?: number[] }
  "economy.gather": { regionName: string; quantity?: number | 'all'; unitIds?: number[]; formationId?: string }
  "formation.assign": { formationId: string; selector?: string; quantity?: number | 'all'; unitIds?: number[] }
  "formation.cover": { formationId: string; selector?: string; quantity?: number | 'all'; memberSource?: "existing" | "auto" | "new"; unitIds?: number[]; protectedSelector?: string; protectedQuantity?: number; protectedUnitIds?: number[] }
  "formation.create": { formationId: string; selector?: string; unitIds?: number[]; force?: boolean }
  "formation.dissolve": { formationId: string }
  "formation.transfer": { formationId: string; selector?: string; quantity?: number | 'all'; unitIds?: number[]; sourceFormationId?: string }
  "formation.uncover": { formationId: string }
  "goal.cancel": { goalId: string }
  "goal.edit": { goalId: string; quantity: number }
  "management.rally": { selector?: string; unitIds?: number[]; regionName?: string; x?: number; y?: number }
  "management.reinforce": { formationId: string; target: string; targetSize: number; sourceFormationId?: string }
  "map.explore": { formationId: string; regionName?: string }
  "production.power": { reserve?: number }
  "production.produce": { target: string; quantity?: number; formationId?: string; placementDirections?: Array<"up" | "down" | "left" | "right" | "up-left" | "up-right" | "down-left" | "down-right">; placementAnchor?: string; placementRegion?: string; afterRelocation?: boolean; queues?: number[] }
  "production.rally": { selector?: string; unitIds?: number[]; quantity?: number | 'all'; regionName?: string; x?: number; y?: number }
  "skill.cancel": { runId?: string; skillId?: string; all?: boolean }
  "skill.run": { skillId: string; quantity?: number; memberSource?: "auto" | "existing" | "new"; useExisting?: boolean; formationId?: string; followFormationId?: string; regionName?: string; selector?: string; unitIds?: number[]; protectedSelector?: string; protectedQuantity?: number; protectedUnitIds?: number[] }
  "transport.enter": { unitIds: number[]; transportId: number }
  "unit.deploy": { selector?: string; unitIds?: number[]; formationId?: string; quantity?: number | 'all'; deployed?: boolean; source?: "auto" | "existing" | "production"; regionName?: string; x?: number; y?: number }
  "vehicle.repair": { formationId: string; followFormationId?: string; targetId?: number }
}
export interface ResolvedCapabilityParameters {
  "base.deploy": Record<string, never>
  "base.relocate": { regionName?: string; x?: number; y?: number; unitId?: number }
  "building.repair": { selector: string; unitIds?: number[]; quantity: number | 'all' }
  "building.sell": { selector: string; unitIds?: number[]; quantity: number | 'all' }
  "combat.attack-all": { selector?: string; unitIds?: number[]; formationId?: string }
  "combat.attack": { selector: string; unitIds?: number[]; formationId?: string; quantity: number | 'all'; target: "enemies" | "base" | "units" | "buildings"; targetId?: number; regionName?: string }
  "combat.clear-region": { formationId: string; regionName: string }
  "combat.hold": { formationId: string; regionName?: string; bounds?: number[]; mode: "hold" | "assault" | "move"; retreatLoss?: number; retreatX?: number; retreatY?: number; label?: string }
  "combat.move": { formationId: string; regionName?: string; x?: number; y?: number; bounds?: number[]; label?: string; patrol: boolean }
  "control.pause": { scope: "formation" | "global" | "all" | "units"; formationId?: string; selector: string; unitIds?: number[] }
  "control.resume": { scope: "formation" | "global" | "all" | "units"; formationId?: string; selector: string; unitIds?: number[] }
  "control.stop": { scope: "formation" | "global" | "all" | "units"; formationId?: string; selector: string; unitIds?: number[] }
  "economy.gather": { regionName: string; quantity: number | 'all'; unitIds?: number[]; formationId?: string }
  "formation.assign": { formationId: string; selector: string; quantity: number | 'all'; unitIds?: number[] }
  "formation.cover": { formationId: string; selector: string; quantity: number | 'all'; memberSource: "existing" | "auto" | "new"; unitIds?: number[]; protectedSelector?: string; protectedQuantity?: number; protectedUnitIds?: number[] }
  "formation.create": { formationId: string; selector: string; unitIds?: number[]; force: boolean }
  "formation.dissolve": { formationId: string }
  "formation.transfer": { formationId: string; selector: string; quantity: number | 'all'; unitIds?: number[]; sourceFormationId?: string }
  "formation.uncover": { formationId: string }
  "goal.cancel": { goalId: string }
  "goal.edit": { goalId: string; quantity: number }
  "management.rally": { selector: string; unitIds?: number[]; regionName?: string; x?: number; y?: number }
  "management.reinforce": { formationId: string; target: string; targetSize: number; sourceFormationId?: string }
  "map.explore": { formationId: string; regionName?: string }
  "production.power": { reserve: number }
  "production.produce": { target: string; quantity: number; formationId?: string; placementDirections?: Array<"up" | "down" | "left" | "right" | "up-left" | "up-right" | "down-left" | "down-right">; placementAnchor?: string; placementRegion?: string; afterRelocation?: boolean; queues: number[] }
  "production.rally": { selector: string; unitIds?: number[]; quantity: number | 'all'; regionName?: string; x?: number; y?: number }
  "skill.cancel": { runId?: string; skillId?: string; all: boolean }
  "skill.run": { skillId: string; quantity?: number; memberSource?: "auto" | "existing" | "new"; useExisting?: boolean; formationId?: string; followFormationId?: string; regionName?: string; selector?: string; unitIds?: number[]; protectedSelector?: string; protectedQuantity?: number; protectedUnitIds?: number[] }
  "transport.enter": { unitIds: number[]; transportId: number }
  "unit.deploy": { selector: string; unitIds?: number[]; formationId?: string; quantity: number | 'all'; deployed: boolean; source: "auto" | "existing" | "production"; regionName?: string; x?: number; y?: number }
  "vehicle.repair": { formationId: string; followFormationId?: string; targetId?: number }
}
export type CapabilityId = keyof CapabilityParameters
export type CapabilityCall = { [Id in CapabilityId]: { capability: Id; params: CapabilityParameters[Id] } }[CapabilityId]
export type ResolvedCapabilityCall = { [Id in CapabilityId]: { capability: Id; params: ResolvedCapabilityParameters[Id] } }[CapabilityId]
