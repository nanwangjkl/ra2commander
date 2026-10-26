import type { ActionRequest, ActionResult, BuildingGoal, GoalView, Snapshot } from '@ra2c/contracts'

interface BuildingJob { unitId: number; attempts: number; sentAt?: number; completed?: boolean; failed?: string }
export interface BuildingState { jobs: BuildingJob[] }
export const initialBuilding = (): BuildingState => ({ jobs: [] })

/** 只开启原生扳手，不反复切换；出售以建筑实际离场确认。 */
export function planBuilding(spec: BuildingGoal, snap: Snapshot, previous: BuildingState, retainedIds = spec.unitIds) {
  const state = structuredClone(previous)
  state.jobs = state.jobs.filter(job => retainedIds.includes(job.unitId))
  for (const unitId of retainedIds) if (!state.jobs.some(job => job.unitId === unitId)) state.jobs.push({ unitId, attempts: 0 })
  const actions: ActionRequest[] = []
  let waitingFunds = 0, repairing = 0
  for (const job of state.jobs) {
    if (job.completed || job.failed) continue
    const unit = snap.self.find(unit => unit.id === job.unitId && unit.type === 2)
    if (!unit) {
      if (spec.operation === 'sell' && job.sentAt !== undefined) job.completed = true
      else job.failed = '建筑已消失或不再属于己方'
      continue
    }
    if (spec.operation === 'repair') {
      if (unit.hitPoints !== undefined && unit.maxHitPoints !== undefined && unit.hitPoints >= unit.maxHitPoints) { job.completed = true; continue }
      if (snap.credits <= 0) { waitingFunds++; continue }
      if (unit.hasWrenchRepair === true) { repairing++; continue }
      // 状态不可观测时只开一次，避免把 toggle 当成幂等接口。
      if (job.sentAt !== undefined && unit.hasWrenchRepair === undefined) { repairing++; continue }
    }
    if (job.sentAt !== undefined && snap.tick - job.sentAt < 90) continue
    if (job.attempts >= 3) { job.failed = '原生指令多次提交后仍未生效'; continue }
    actions.push({ kind: spec.operation === 'repair' ? 'repairBuilding' : 'sellBuilding', unitIds: [job.unitId] })
  }
  const completed = state.jobs.filter(job => job.completed).length, failed = state.jobs.filter(job => job.failed).length
  const total = state.jobs.length, finished = completed + failed === total
  const detail = `${spec.operation === 'repair' ? '已修复' : '已离场'}${completed}/${total}座${repairing ? `；原生维修中${repairing}座` : ''}${waitingFunds ? `；等待资金${waitingFunds}座` : ''}${failed ? `；未完成${failed}座：${[...new Set(state.jobs.flatMap(job => job.failed ? [job.failed] : []))].join('、')}` : ''}`
  const view: NonNullable<GoalView['building']> = { actions, completed, total, failed, pending: waitingFunds > 0 && !actions.length && !repairing, detail }
  return { state, view, finished, outcome: failed ? completed ? 'partial' as const : 'failed' as const : 'completed' as const }
}

/** 先记发令尝试：游戏的新快照可能早于桥的异步回执。 */
export function reserveBuilding(state: BuildingState, request: ActionRequest, tick: number) {
  if (request.kind !== 'repairBuilding' && request.kind !== 'sellBuilding') return
  for (const id of request.unitIds) {
    let job = state.jobs.find(job => job.unitId === id)
    if (!job) { job = { unitId: id, attempts: 0 }; state.jobs.push(job) }
    job.sentAt = tick; job.attempts++
  }
}

export function recordBuilding(state: BuildingState, request: ActionRequest, results: ActionResult[]) {
  if (request.kind !== 'repairBuilding' && request.kind !== 'sellBuilding') return
  for (const job of state.jobs.filter(job => request.unitIds.includes(job.unitId))) {
    if (results.some(result => result.reason === 'unsellable-building')) job.failed = '规则禁止出售'
    else if (results.length && results.every(result => !result.ok && result.submitted === 0)) { delete job.sentAt; job.attempts = Math.max(0, job.attempts - 1) }
  }
}
