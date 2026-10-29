import type { AttackGoal, CombatGoal, GoalSpec } from './control.ts'
import type { SnapshotUnit } from './index.ts'
import { inTargetRegion, validTargetRegion, type TargetRegion } from './spatial.ts'

/** 攻击什么、在哪里寻找以及何时结束分别表达，兼容不同成员执行方式。 */
export interface AttackObjective {
  coordination?: 'focus' | 'independent'
  target: { kind: 'enemies' | 'base' | 'units' | 'buildings'; names: string[]; id?: number; region?: TargetRegion; unitNames?: string[]; unitTypes?: number[]; domain?: 'air' | 'ground' }
  search: { kind: 'visible' | 'region' | 'map'; destination?: { x: number; y: number; name?: string } }
  completion: { ground: 'continuous'; aircraft: 'single-shot' }
}
export type AttackMembership = { kind: 'selected' } | { kind: 'prepared'; goalIds: string[]; names: string[]; limit?: number }
export function attackObjective(spec: GoalSpec): AttackObjective | undefined {
  if (spec.kind !== 'attack' && spec.kind !== 'combat') return undefined
  if (spec.objective) return spec.objective
  if (spec.kind === 'attack') return { target: { kind: spec.targetKind, names: spec.targetNames, ...(spec.targetId !== undefined ? { id: spec.targetId } : {}), ...(spec.targetRegion ? { region: spec.targetRegion } : {}) }, search: { kind: 'visible' }, completion: { ground: 'continuous', aircraft: 'single-shot' } }
  if (spec.destination && !spec.attackRegion || spec.mode === 'hold' || spec.mode === 'assault') return undefined
  if (!spec.allowedActions.includes('attack') && !spec.allowedActions.includes('attackMove')) return undefined
  return { target: { kind: 'enemies', names: [], ...(spec.attackRegion ? { region: spec.attackRegion } : {}) }, search: { kind: spec.attackRegion ? 'region' : 'map', ...(spec.destination ? { destination: spec.destination } : {}) }, completion: { ground: 'continuous', aircraft: 'single-shot' } }
}
/** 旧字段供现有生成代码兼容读取，宿主以 objective 为唯一攻击要求来源。 */
export function normalizeAttackGoal<T extends GoalSpec>(spec: T): T {
  if ((spec.kind === 'attack' || spec.kind === 'combat') && spec.objective && !validAttackObjective(spec.objective)) return spec
  const objective = attackObjective(spec)
  if (!objective || (spec.kind !== 'attack' && spec.kind !== 'combat')) return spec
  if (spec.kind === 'attack') {
    const { targetId: _id, targetRegion: _region, ...rest } = spec
    return { ...rest, objective, targetKind: objective.target.kind, targetNames: objective.target.names, ...(objective.target.id !== undefined ? { targetId: objective.target.id } : {}), ...(objective.target.region ? { targetRegion: objective.target.region } : {}) } as T
  }
  const { attackRegion: _region, ...rest } = spec
  return { ...rest, objective, ...(objective.search.destination ? { destination: objective.search.destination } : {}), ...(objective.target.region ? { attackRegion: objective.target.region } : {}) } as T
}
export function matchingAttackTargets(spec: AttackGoal | CombatGoal, enemies: readonly SnapshotUnit[]): SnapshotUnit[] {
  const objective = attackObjective(spec)
  if (!objective) return [...enemies]
  const target = objective.target
  return enemies.filter(unit => (target.id === undefined || unit.id === target.id) && (!target.region || inTargetRegion(unit.rx, unit.ry, target.region))
    && (!target.domain || isAirborne(unit) === (target.domain === 'air'))
    && (!target.unitNames && !target.unitTypes || !!target.unitNames?.includes(unit.name) || !!target.unitTypes?.includes(unit.type))
    && (target.kind === 'enemies' || target.kind === 'base' && target.names.includes(unit.name) || target.kind === 'buildings' && unit.type === 2 || target.kind === 'units' && [1, 3, 7].includes(unit.type)))
}
export function validAttackObjective(value: AttackObjective): boolean {
  return !!value && !!value.target && ['enemies', 'base', 'units', 'buildings'].includes(value.target.kind) && Array.isArray(value.target.names) && value.target.names.every(name => typeof name === 'string' && !!name)
    && (value.target.id === undefined || Number.isSafeInteger(value.target.id)) && (!value.target.region || validTargetRegion(value.target.region))
    && (value.target.domain === undefined || ['air', 'ground'].includes(value.target.domain))
    && (value.coordination === undefined || ['focus','independent'].includes(value.coordination))
    && (value.target.unitNames === undefined || Array.isArray(value.target.unitNames) && value.target.unitNames.length > 0 && value.target.unitNames.every(name => typeof name === 'string' && !!name))
    && (value.target.unitTypes === undefined || Array.isArray(value.target.unitTypes) && value.target.unitTypes.length > 0 && value.target.unitTypes.every(type => [1, 2, 3, 7].includes(type)))
    && !!value.search && ['visible', 'region', 'map'].includes(value.search.kind) && (value.search.kind !== 'region' || !!value.target.region)
    && (!value.search.destination || Number.isSafeInteger(value.search.destination.x) && Number.isSafeInteger(value.search.destination.y))
    && value.completion?.ground === 'continuous' && value.completion.aircraft === 'single-shot'
}

export const isAirborne = (unit: SnapshotUnit): boolean => unit.zone === 1 || unit.type === 1
/** 只按公开武器空地能力选敌；距离和接近仍由游戏处理，缺少武器信息时不拒绝行动。 */
export function canAttackTarget(unit: SnapshotUnit, target: SnapshotUnit): boolean {
  const weapons = [unit.primaryWeapon, unit.secondaryWeapon].filter(weapon => !!weapon)
  return !weapons.length || weapons.some(weapon => isAirborne(target) ? weapon.aa : weapon.ag)
}

/** 缺少新成员来源字段的 v4 目标按已捕获的准备目标兼容读取。 */
export function attackMembership(spec: AttackGoal): AttackMembership {
  return spec.membership ?? (spec.dynamicNames ? { kind: 'prepared', goalIds: spec.preparationGoalIds, names: spec.dynamicNames } : { kind: 'selected' })
}
