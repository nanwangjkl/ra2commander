import { inTargetRegion, type ActionRequest, type ActionResult } from '@ra2c/contracts'
import type { GoalContext } from './goals/types.ts'

interface DeploymentJob {
  unitId: number; completed?: boolean; failed?: string
  joined?: boolean
  step?: 'move' | 'deploy' | 'undeploy'; attempts: number; sentAt?: number
  x?: number; y?: number; progressAt?: number
}
export interface UnitDeploymentState { jobs: DeploymentJob[] }
export const initialUnitDeployment = (): UnitDeploymentState => ({ jobs: [] })
export function deploymentIds(ctx: GoalContext<'unitDeploy'>): number[] {
  return [...new Set([...ctx.spec.unitIds, ...ctx.spec.sources.flatMap(source => ctx.production.filter(record => record.goalId === source.goalId && record.name === source.name && record.state !== 'rejected').flatMap(record => record.observedIds).slice(0, source.quantity))])].filter(id => !ctx.spec.excludedIds?.includes(id))
}

/** 姿态按实际状态确认；短时部署确认一次即结束，不因自动站起再次触发技能。 */
export function planUnitDeployment(ctx: GoalContext<'unitDeploy'>) {
  const { spec, snap } = ctx, state = structuredClone(ctx.goal.facts.unitDeployment ?? initialUnitDeployment())
  const ids = deploymentIds(ctx)
  state.jobs = state.jobs.filter(job => ids.includes(job.unitId))
  for (const unitId of ids) if (!state.jobs.some(job => job.unitId === unitId)) state.jobs.push({ unitId, attempts: 0 })
  const actions: ActionRequest[] = []
  let waiting = 0, moving = 0, absent = 0
  for (const source of spec.sources) {
    const count = ctx.production.filter(record => record.goalId === source.goalId && record.name === source.name && record.state !== 'rejected').flatMap(record => record.observedIds).length
    const missing = Math.max(0, source.quantity - count)
    if (['completed', 'partial', 'failed', 'cancelled'].includes(ctx.goals.get(source.goalId)?.status ?? 'failed')) absent += missing
    else waiting += missing
  }
  for (const job of state.jobs) {
    if (job.completed || job.failed) continue
    const unit = snap.self.find(unit => unit.id === job.unitId)
    if (!unit) { job.failed = '成员已损失或离场'; continue }
    const owner = ctx.formations.ownerOf(unit.id)
    if (owner && owner !== spec.formationId) { job.failed = '成员已转交其他编队'; continue }
    if (spec.formationId && owner === spec.formationId) job.joined = true
    if (spec.formationId && job.joined && !owner) { job.failed = '成员已离开原编队'; continue }
    if (ctx.locked(unit.id) || spec.formationId && owner !== spec.formationId) { waiting++; continue }
    if (typeof unit.isDeployed !== 'boolean' || !unit.canDeploy) { waiting++; continue }
    const arrived = !spec.destination || Math.hypot(unit.rx - spec.destination.x, unit.ry - spec.destination.y) <= 3 && (!spec.targetRegion || inTargetRegion(unit.rx, unit.ry, spec.targetRegion))
    if (arrived && unit.isDeployed === spec.deployed) { job.completed = true; continue }
    if (job.progressAt === undefined || job.x !== unit.rx || job.y !== unit.ry || snap.tick < job.progressAt) {
      job.x = unit.rx; job.y = unit.ry; job.progressAt = snap.tick
      if (job.step === 'move') job.attempts = 0
    }
    const step = !arrived ? unit.isDeployed ? 'undeploy' : 'move' : spec.deployed ? 'deploy' : 'undeploy'
    if (job.step !== step) { job.step = step; job.attempts = 0; delete job.sentAt }
    if (step === 'move') moving++
    if (job.sentAt !== undefined) {
      if (snap.tick < job.sentAt) job.sentAt = snap.tick
      if (snap.tick - job.sentAt < 90 || step === 'move' && !unit.isIdle && snap.tick - job.progressAt < 600) continue
    }
    if (job.attempts >= (step === 'deploy' && spec.transientNames?.includes(unit.name) ? 1 : 3)) { job.failed = step === 'deploy' && spec.transientNames?.includes(unit.name) ? '短时部署已提交但未捕获状态确认，不重复施放' : `${step === 'move' ? '移动' : '姿态切换'}重试已用尽，未确认完成`; continue }
    actions.push(step === 'move' ? { kind: 'move', unitIds: [unit.id], x: spec.destination!.x, y: spec.destination!.y } : { kind: 'deploy', unitIds: [unit.id], deployed: step === 'deploy' })
  }
  const sourceIds = spec.sources.flatMap(source => ctx.production.filter(record => record.goalId === source.goalId && record.name === source.name && record.state !== 'rejected').flatMap(record => record.observedIds).slice(0, source.quantity))
  const total = spec.unitIds.length + spec.sources.reduce((n, source) => n + source.quantity, 0) - new Set(sourceIds.filter(id => spec.excludedIds?.includes(id))).size
  const completed = state.jobs.filter(job => job.completed).length, failed = state.jobs.filter(job => job.failed).length + absent
  const detail = `${spec.deployed ? '已部署' : '已解除部署'}${completed}/${total}个${waiting ? `；等待生产、集结交接或公开姿态${waiting}个` : ''}${moving ? `；前往${spec.destination?.name ?? '指定位置'}${moving}个` : ''}${failed ? `；未完成${failed}个：${[...new Set(state.jobs.flatMap(job => job.failed ? [job.failed] : [])), ...(absent ? ['生产来源已结束，未产生足额成员'] : [])].join('、')}` : ''}`
  return { state, view: { actions, completed, total, failed, pending: waiting > 0 && !actions.length, detail }, finished: completed + failed >= total && waiting === 0,
    outcome: failed ? completed ? 'partial' as const : 'failed' as const : 'completed' as const }
}
export function reserveDeployment(state: UnitDeploymentState, action: ActionRequest, tick: number): void {
  if (action.kind !== 'move' && action.kind !== 'deploy') return
  for (const job of state.jobs) if (action.unitIds.includes(job.unitId)) { job.sentAt = tick; job.attempts++ }
}
export function recordDeployment(state: UnitDeploymentState, action: ActionRequest, results: ActionResult[]): void {
  if (action.kind !== 'deploy' && action.kind !== 'move') return
  if (results.some(result => result.reason === 'deployment-state-unavailable')) for (const job of state.jobs) if (action.unitIds.includes(job.unitId)) job.failed = '公开 API 无可确认的部署姿态，本轮不支持此类展开'
}
