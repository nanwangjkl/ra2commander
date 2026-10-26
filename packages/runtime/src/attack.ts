import { matchingAttackTargets, attackMembership, type ActionRequest, type ActionResult, type AttackGoal, type GoalView, type Snapshot } from '@ra2c/contracts'

interface AttackMember {
  unitId: number
  aircraft: boolean
  phase: 'pending' | 'ready' | 'attacking' | 'fired' | 'lost' | 'released'
  lastAmmo?: number
  lastCooldown?: number
  acceptedAt?: number
  firedAt?: number
}
export interface AttackState { members: AttackMember[] }
export const initialAttack = (): AttackState => ({ members: [] })

/** 只依据本次已接受的攻击和真实弹药/武器变化确认出击，不用接口成功代替开火。 */
export function planAttack(spec: AttackGoal, snap: Snapshot, ids: number[], previous: AttackState, preparing: boolean, retainedIds = spec.unitIds) {
  const state = structuredClone(previous)
  state.members = state.members.filter(member => retainedIds.includes(member.unitId))
  const selected = retainedIds
  for (const id of selected) if (!state.members.some(member => member.unitId === id)) state.members.push({ unitId: id, aircraft: snap.self.find(unit => unit.id === id)?.type === 1 || spec.aircraftIds.includes(id), phase: 'pending' })
  const readyIds: number[] = [], pendingIds: number[] = [], attackingIds: number[] = [], firedIds: number[] = [], lostIds: number[] = [], groundIds: number[] = []
  for (const member of state.members) {
    const unit = snap.self.find(unit => unit.id === member.unitId)
    if (!['fired', 'lost', 'released'].includes(member.phase)) {
      if (!unit) member.phase = preparing ? 'pending' : 'lost'
      else if (!ids.includes(unit.id)) member.phase = preparing ? 'pending' : 'released'
      else if (!member.aircraft) member.phase = 'ready'
      else {
        const capacity = spec.ammoCapacity[unit.name] ?? 1
        const cooldown = unit.primaryWeapon?.cooldownTicks ?? unit.secondaryWeapon?.cooldownTicks
        const fired = member.acceptedAt !== undefined && (unit.ammo !== undefined && member.lastAmmo !== undefined && unit.ammo < member.lastAmmo
          || cooldown !== undefined && member.lastCooldown !== undefined && cooldown > member.lastCooldown)
        if (fired) { member.phase = 'fired'; member.firedAt = snap.tick }
        else if (capacity > 0 && (unit.ammo === undefined || unit.ammo < capacity)) member.phase = 'pending'
        else if (member.phase !== 'attacking' || unit.isIdle && snap.tick - (member.acceptedAt ?? snap.tick) >= 60) member.phase = 'ready'
        if (unit.ammo !== undefined) member.lastAmmo = unit.ammo
        if (cooldown !== undefined) member.lastCooldown = cooldown
      }
    }
    if (member.phase === 'fired') firedIds.push(member.unitId)
    else if (member.phase === 'lost' || member.phase === 'released') lostIds.push(member.unitId)
    else if (member.phase === 'pending') pendingIds.push(member.unitId)
    else if (member.phase === 'attacking') attackingIds.push(member.unitId)
    else { readyIds.push(member.unitId); if (!member.aircraft) groundIds.push(member.unitId) }
  }
  const targets = attackTargets(spec, snap)
  const totalAircraft = state.members.filter(member => member.aircraft).length
  const emptyPreparation = !state.members.length && attackMembership(spec).kind === 'prepared'
  const detail = emptyPreparation && !preparing ? '本次准备目标已结束，但没有可接管的匹配成员，未追加生产' : `${totalAircraft ? `已投弹${firedIds.length}/${totalAircraft}架；等待装弹/交接${pendingIds.length}架；出击中${attackingIds.length}架` : `指挥${readyIds.length}个现有单位攻击`}${preparing ? '；等待本次编队准备完成' : ''}${lostIds.length ? `；损失或转交${lostIds.length}个成员` : ''}${!targets.length ? '；等待发现匹配敌人' : ''}`
  const view: NonNullable<GoalView['attack']> = { readyIds, pendingIds, attackingIds, firedIds, lostIds, totalAircraft, groundIds, targets, preparing, detail }
  const finished = !preparing && (state.members.length > 0 || emptyPreparation) && state.members.every(member => ['fired', 'lost', 'released'].includes(member.phase))
  return { state, view, finished, outcome: emptyPreparation ? 'failed' as const : lostIds.length ? firedIds.length ? 'partial' as const : 'failed' as const : 'completed' as const }
}

export function attackTargets(spec: AttackGoal, snap: Snapshot) {
  return matchingAttackTargets(spec, snap.enemies)
}

export function recordAttack(state: AttackState, request: ActionRequest, results: ActionResult[], snap: Snapshot): void {
  if (request.kind !== 'attack' || !results.some(result => result.ok)) return
  for (const id of request.unitIds) {
    const unit = snap.self.find(unit => unit.id === id)
    let member = state.members.find(member => member.unitId === id)
    if (!member && unit?.type === 1) { member = { unitId: id, aircraft: true, phase: 'ready' }; state.members.push(member) }
    if (!member?.aircraft || !unit || member.phase === 'fired') continue
    member.acceptedAt = snap.tick; member.phase = 'attacking'
    if (unit.ammo !== undefined) member.lastAmmo = unit.ammo
    const cooldown = unit.primaryWeapon?.cooldownTicks ?? unit.secondaryWeapon?.cooldownTicks
    if (cooldown !== undefined) member.lastCooldown = cooldown
  }
}
