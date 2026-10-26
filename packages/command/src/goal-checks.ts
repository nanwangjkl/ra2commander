import { checkScoutHandoffs } from './scout-checks.ts'
import { checkRepairStages } from './repair-checks.ts'
import { checkRelocationStages } from './relocation-checks.ts'
import { checkMiningStages } from './mining-checks.ts'
import { checkAttackStages } from './attack-checks.ts'

/** 固定登记编译阶段的目标情景检查；每项自行筛选相关目标，不访问真实游戏。 */
export const goalCompileChecks = [checkScoutHandoffs, checkRepairStages, checkRelocationStages, checkMiningStages, checkAttackStages] as const
