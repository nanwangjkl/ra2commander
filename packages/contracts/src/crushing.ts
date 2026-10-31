import { gameAlgorithms } from './game-algorithms.ts'

export interface CrushingRules { attackers: string[]; targets: string[] }

/** 只使用已导入的当前策略与公开单位状态，不把地面层之外的步兵当成可接触目标。 */
export const crushCompatible = gameAlgorithms.crushCompatible
