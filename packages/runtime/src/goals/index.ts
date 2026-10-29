import { validAttackObjective, type GoalSpec } from '@ra2c/contracts'
import type { GoalState } from '../state.ts'
import { attack } from './attack.ts'
import { building } from './building.ts'
import { combat } from './combat.ts'
import { deploy } from './deploy.ts'
import { explore } from './explore.ts'
import { formation } from './formation.ts'
import { mining } from './mining.ts'
import { production } from './production.ts'
import { rally } from './rally.ts'
import { reinforce } from './reinforce.ts'
import { relocate } from './relocate.ts'
import { repair } from './repair.ts'
import { transport } from './transport.ts'
import { unitDeploy } from './unit-deploy.ts'
import type { GoalHandler, GoalKind, MapSize } from './types.ts'

/** 新目标必须在这里登记；不引入动态插件、隐藏顺序或运行时注册。 */
export const goalHandlers = { attack, building, combat, deploy, explore, formation, mining, production, rally, reinforce, relocate, repair, transport, unitDeploy } satisfies { [K in GoalKind]: GoalHandler<K> }
/** 规格和处理器由相同 kind 分派；类型收窄只在这个边界适配一次。 */
export function handlerFor(spec: GoalSpec): GoalHandler {
  if (!Object.hasOwn(goalHandlers, spec?.kind)) throw new Error(`未知目标类型：${spec?.kind}`)
  return goalHandlers[spec.kind] as GoalHandler
}
export function validateGoalSpec(spec: GoalSpec, map: MapSize): void {
  if (!spec || typeof spec.id !== 'string' || !spec.id || typeof spec.rawText !== 'string' || !spec.rawText) throw new Error('目标缺少 ID 或命令')
  handlerFor(spec).validateSpec(spec, map)
  if (spec.executionMode !== undefined && !['script', 'native'].includes(spec.executionMode) || spec.executionMode === 'native' && !handlerFor(spec).nativeActions) throw new Error('目标执行方式不受支持')
  if ((spec.kind === 'attack' || spec.kind === 'combat') && spec.objective && (!validAttackObjective(spec.objective) || spec.objective.search.destination && (spec.objective.search.destination.x < 0 || spec.objective.search.destination.y < 0 || spec.objective.search.destination.x >= map.mapWidth || spec.objective.search.destination.y >= map.mapHeight))) throw new Error('攻击要求非法')
}
export function validateGoalFacts(goal: GoalState, map: MapSize): void {
  const facts = goal.facts
  if (!facts || typeof facts.initialized !== 'boolean' || !Array.isArray(facts.members) || facts.members.some(member => !Number.isSafeInteger(member.id) || typeof member.name !== 'string' || !Number.isFinite(member.rx) || !Number.isFinite(member.ry)) || !Number.isFinite(facts.lossRatio) || facts.lossRatio < 0 || facts.lossRatio > 1 || typeof facts.retreatTriggered !== 'boolean') throw new Error('目标事实非法')
  const kinds = { repair: 'repair', relocation: 'relocate', mining: 'mining', attack: 'attack', building: 'building', unitDeployment: 'unitDeploy', baseDefense:'combat', routeIndex: 'combat', coverReleasedIds: 'attack', completedQuantity: 'production', placementBlocked: 'production', rallyBlocked: 'production', cancelProduction: 'production' } as const
  for (const [field, kind] of Object.entries(kinds)) if (facts[field as keyof typeof kinds] !== undefined && goal.spec.kind !== kind) throw new Error(`${field} 进度与目标不符`)
  if (facts.routeIndex !== undefined && (!Number.isSafeInteger(facts.routeIndex) || facts.routeIndex < 0) || facts.completedQuantity !== undefined && (!Number.isSafeInteger(facts.completedQuantity) || facts.completedQuantity < 0) || facts.placementBlocked !== undefined && typeof facts.placementBlocked !== 'boolean') throw new Error('目标进度非法')
  if (facts.cancelProduction !== undefined && (typeof facts.cancelProduction !== 'boolean' || goal.status !== 'cancelled')) throw new Error('生产撤销标记非法')
  if (facts.rallyBlocked !== undefined && typeof facts.rallyBlocked !== 'boolean') throw new Error('生产集结点等待标记非法')
  if (facts.nativeError !== undefined && (goal.spec.executionMode !== 'native' || typeof facts.nativeError !== 'string')) throw new Error('本机执行错误记录非法')
  if (facts.endedByBattle !== undefined && (!['victory', 'defeat'].includes(facts.endedByBattle) || !['completed', 'partial', 'failed'].includes(goal.status))) throw new Error('对局结束目标状态非法')
  if ((facts.coverMotion !== undefined || facts.coverEnded !== undefined) && goal.spec.kind !== 'combat' && goal.spec.kind !== 'attack' || facts.coverEnded !== undefined && typeof facts.coverEnded !== 'string') throw new Error('掩护进度与目标不符')
  handlerFor(goal.spec).validateFacts?.(goal, map)
}
