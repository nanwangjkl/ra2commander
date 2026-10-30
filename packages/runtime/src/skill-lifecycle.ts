import type { CoverPolicy, Snapshot } from '@ra2c/contracts'
import type { FormationRegistry } from './formation.ts'
import { skillGoalIds, type SkillRun } from './exploration.ts'
import type { GoalState, ProductionRecord } from './state.ts'

interface SkillLifecycleDeps {
  runs: ReadonlyMap<string, SkillRun>
  goals: ReadonlyMap<string, GoalState>
  formations: FormationRegistry
  production: readonly ProductionRecord[]
  snapshot(): Snapshot | undefined
  locked(id: number): boolean
  setCover(formationId: string, policy: CoverPolicy): void
  uncover(formationId: string): Promise<void>
  cancelProductionGoal(id: string): Promise<string>
  cancelGoal(id: string, reason?: string): Promise<void>
  log?: (message: string) => void
}

/** 只衔接 Skill 的准备目标与运行状态，不调度或提交游戏动作。 */
export class SkillLifecycle {
  constructor(private readonly deps: SkillLifecycleDeps) {}
  async cancel(id: string, superseded = false): Promise<void> {
    const run = this.deps.runs.get(id)
    if (!run || !['preparing', 'exploring', 'repairing', 'covering'].includes(run.status)) return
    if (run.kind === 'cover') {
      if (this.deps.formations.coverOf(run.formationId)?.runId === run.id) await this.deps.uncover(run.formationId)
      run.status = superseded ? 'superseded' : 'cancelled'
      for (const goalId of run.ownedPreparationGoalIds ?? run.preparationGoalIds.filter(id => this.deps.goals.get(id)?.spec.skill?.runId === run.id)) {
        if (this.deps.goals.get(goalId)?.spec.kind === 'production') await this.deps.cancelProductionGoal(goalId)
        else await this.deps.cancelGoal(goalId, '玩家取消掩护准备')
      }
      return
    }
    run.status = superseded ? 'superseded' : 'cancelled'
    run.detail = superseded ? '编队已接受新命令，停止原 Skill 后续步骤' : '玩家取消 Skill；已进入游戏队列的生产不回退'
    await Promise.all(skillGoalIds(run).map(goalId => {
      const goal = this.deps.goals.get(goalId)
      return goal && !['completed', 'partial', 'failed', 'cancelled'].includes(goal.status) ? this.deps.cancelGoal(goalId, run.detail) : Promise.resolve()
    }))
  }

  sync(): void {
    for (const run of this.deps.runs.values()) {
      if (!['preparing', 'exploring', 'repairing', 'covering'].includes(run.status)) continue
      if (run.kind === 'cover') {
        let profile = this.deps.formations.coverOf(run.formationId)
        if (run.cover && this.deps.formations.list().some(formation => formation.id === run.formationId)) {
          const assigned = new Set(run.assignedEscortIds ?? (profile?.runId === run.id ? profile.escortIds : []))
          const candidates = [...run.escortIds, ...(run.cover.escortSources ?? []).flatMap(source => this.deps.production.filter(record => record.goalId === source.goalId && record.name === (this.deps.goals.get(source.goalId)?.spec as { target?: string })?.target).flatMap(record => record.observedIds).slice(0, source.quantity))]
          const incoming = candidates.filter(id => !assigned.has(id) && this.deps.snapshot()?.self.some(unit => unit.id === id) && this.deps.formations.ownerOf(id) === run.formationId && !this.deps.locked(id))
          const kept = profile?.runId === run.id ? profile.escortIds.filter(id => this.deps.formations.ownerOf(id) === run.formationId && this.deps.snapshot()?.self.some(unit => unit.id === id)) : []
          const desired = { ...run.cover, escortIds: [...new Set([...kept, ...incoming])] }
          if (JSON.stringify(profile) !== JSON.stringify(desired)) this.deps.setCover(run.formationId, desired)
          run.assignedEscortIds = [...new Set([...assigned, ...incoming])]
          run.escortIds = [...new Set([...run.escortIds, ...incoming])]
          profile = this.deps.formations.coverOf(run.formationId)
        }
        if (profile?.runId === run.id) {
          const escorts = this.deps.snapshot()?.self.filter(unit => profile.escortIds.includes(unit.id) && this.deps.formations.ownerOf(unit.id) === run.formationId).length ?? 0
          const total = this.deps.snapshot()?.self.filter(unit => this.deps.formations.ownerOf(unit.id) === run.formationId).length ?? 0
          const preparing = run.preparationGoalIds.some(id => ['pending', 'active'].includes(this.deps.goals.get(id)?.status ?? ''))
          run.status = escorts && total > escorts ? 'covering' : preparing ? 'preparing' : 'covering'
          run.detail = `同属${run.formationId}：被掩护${total - escorts}、掩护${escorts}${preparing ? '；等待本次生产和交接，其余可用成员先行动' : escorts ? '；协同行动' : '；掩护成员已损失或准备结束，未追加生产'}`
        } else if (run.status === 'covering' || run.preparationGoalIds.some(id => this.deps.goals.get(id)?.status === 'cancelled')) { run.status = 'superseded'; run.detail = '掩护已解除或被重新安排' }
        continue
      }
      if (run.kind === 'repair-vehicle') {
        const repair = this.deps.goals.get(run.repairGoalId)
        if (repair?.status === 'cancelled') { void this.cancel(run.id, true).catch(error => this.deps.log?.(String(error))); continue }
        if (repair && ['failed', 'partial'].includes(repair.status)) { run.status = repair.status as 'failed' | 'partial'; run.detail = repair.facts.outcomeDetail ?? '维修任务结束'; continue }
        if (run.preparationGoalIds.some(id => this.deps.goals.get(id)?.status === 'cancelled')) { void this.cancel(run.id).catch(error => this.deps.log?.(String(error))); continue }
        const ready = repair?.facts.repair?.engineerIds ?? []
        const count = this.deps.snapshot()?.self.filter(unit => this.deps.formations.ownerOf(unit.id) === run.formationId && unit.transport?.unitIds.some(id => ready.includes(id))).length ?? 0
        run.status = count ? 'repairing' : 'preparing'
        run.detail = `已组装${count}/${run.quantity}辆维修车`
        continue
      }
      const explore = this.deps.goals.get(run.exploreGoalId), prepare = this.deps.goals.get(run.preparationGoalId)
      if (explore?.status === 'cancelled') { void this.cancel(run.id, true).catch(error => this.deps.log?.(String(error))); continue }
      if (explore && ['completed', 'partial', 'failed'].includes(explore.status)) {
        if (explore.status === 'completed' && prepare && !['completed', 'cancelled'].includes(prepare.status)) {
          run.detail = '探索已完成，等待本次固定数量生产及编队结束'
          continue
        }
        run.status = explore.status as 'completed' | 'partial' | 'failed'
        run.detail = explore.facts.outcomeDetail ?? '探索完成'
        if (prepare && !['completed', 'cancelled'].includes(prepare.status)) void this.deps.cancelGoal(prepare.spec.id, run.detail).catch(error => this.deps.log?.(String(error)))
      } else if (prepare?.status === 'cancelled') {
        void this.cancel(run.id).catch(error => this.deps.log?.(String(error)))
      } else {
        const ready = this.deps.snapshot()?.self.some(unit => this.deps.formations.ownerOf(unit.id) === run.formationId && !this.deps.locked(unit.id))
        run.status = ready ? 'exploring' : 'preparing'
      }
    }
  }

}
