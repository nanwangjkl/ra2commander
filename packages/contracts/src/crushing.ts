import type { SnapshotUnit } from './index.ts'

export interface CrushingRules { attackers: string[]; targets: string[] }

/** 只使用已导入的当前策略与公开单位状态，不把地面层之外的步兵当成可接触目标。 */
export function crushCompatible(unit: SnapshotUnit, target: SnapshotUnit, rules: CrushingRules | undefined): boolean {
  return !!rules && unit.type === 7 && (unit.zone === undefined || unit.zone === 0) && rules.attackers.includes(unit.name)
    && target.type === 3 && (target.zone === undefined || target.zone === 0) && rules.targets.includes(target.name)
    && !!unit.onBridge === !!target.onBridge && (target.hitPoints === undefined || target.hitPoints > 0)
}
