import { attackMembership, type AttackGoal, type Snapshot } from '@ra2c/contracts'
import type { GoalState, ProductionRecord } from './state.ts'
import type { AttackState } from './attack.ts'

/** 固定 ID 与有来源的待加入成员分开；来源完成后保留其已观察产物，不按兵种无限吸收。 */
export function attackRoster(spec: AttackGoal, goals: ReadonlyMap<string, GoalState>, production: readonly ProductionRecord[], snap: Snapshot, previous?: AttackState): number[] {
  const membership = attackMembership(spec)
  if (membership.kind === 'selected') return spec.unitIds
  const eligible = (id: number) => snap.self.some(unit => unit.id === id && membership.names.includes(unit.name) && !!(unit.primaryWeapon || unit.secondaryWeapon))
  const additions = membership.goalIds.flatMap(id => {
    const goal = goals.get(id)
    if (!goal || goal.status === 'cancelled') return []
    const source = goal.activeSpec ?? goal.spec
    if (source.kind === 'formation' && source.request.kind !== 'dissolveFormation' && source.request.formationId === spec.formationId) return source.request.unitIds.filter(eligible)
    if (source.kind === 'production' && source.formationId === spec.formationId && membership.names.includes(source.target)) return production.filter(record => record.goalId === id && record.name === source.target && record.state !== 'rejected').flatMap(record => record.observedIds).filter(eligible)
    return []
  })
  const ids = [...new Set([...spec.unitIds, ...(previous?.members.map(member => member.unitId) ?? []), ...additions])]
  return membership.limit === undefined ? ids : ids.slice(0, membership.limit)
}

export function validateAttackSources(spec: AttackGoal, goals: ReadonlyMap<string, GoalState>): void {
  if (spec.membership?.kind !== 'prepared') return
  for (const id of spec.membership.goalIds) {
    const source = goals.get(id)?.spec
    if (!source || !spec.preparationGoalIds.includes(id) || !(source.kind === 'production' && source.formationId === spec.formationId || source.kind === 'formation' && source.request.kind !== 'dissolveFormation' && source.request.formationId === spec.formationId)) throw new Error('攻击成员来源与准备目标不符')
  }
}
