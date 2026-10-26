import type { GoalExecutionMode } from '@ra2c/contracts'

/** 按能力回退固定流程；默认只影响新目标，旧脚本不自动迁移。 */
const flags = { building: 'RA2C_BUILDING_EXECUTOR', mining: 'RA2C_MINING_EXECUTOR', relocate: 'RA2C_RELOCATION_EXECUTOR' } as const
export type FixedGoalKind = keyof typeof flags
export function fixedGoalExecutionMode(kind: FixedGoalKind): GoalExecutionMode {
  const flag = flags[kind], mode = process.env[flag] ?? 'native'
  if (mode !== 'native' && mode !== 'script') throw new Error(`${flag} 只支持 native 或 script`)
  return mode
}
export function scriptedFixedKinds(): FixedGoalKind[] {
  return (Object.keys(flags) as FixedGoalKind[]).filter(kind => fixedGoalExecutionMode(kind) === 'script')
}
