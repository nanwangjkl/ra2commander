import { compileCommand } from '@ra2c/command'
import type { GoalSpec } from '@ra2c/contracts'
import type { OpenAICompatibleProvider } from '@ra2c/model-providers'
import type { StepExecutor } from '@ra2c/js-worker'
import type { TaskRuntime } from '@ra2c/runtime'

interface ControllerDeps {
  runtime: TaskRuntime
  executor: Pick<StepExecutor, 'run'>
  provider: () => OpenAICompatibleProvider
  prepare?: (goals: GoalSpec[], signal: AbortSignal) => Promise<GoalSpec[]>
  log?: (message: string) => void
}

/** 所有控制对象共用生成与修复流程，目标合并由运行时维护。 */
export class ProgramController {
  private repairs = new Map<string, number>()
  constructor(private readonly deps: ControllerDeps) {}

  setProvider(provider: () => OpenAICompatibleProvider): void { this.deps.provider = provider }

  async submit(goal: GoalSpec): Promise<string> {
    const id = this.deps.runtime.upsertGoal(goal)
    this.repairs.delete(id)
    return `目标 ${goal.id}：${await this.refresh(id)}`
  }

  async refresh(id: string, repair = false): Promise<string> {
    const { runtime } = this.deps
    for (;;) {
      const lease = runtime.beginCompile(id, repair)
      try {
        const goals = this.deps.prepare ? await this.deps.prepare(lease.goals, lease.signal) : lease.goals
        if (lease.signal.aborted) return '已合并到后续变更，目标仍保留'
        if (!runtime.prepareCompile(lease, goals)) continue
        const frame = runtime.compileFrame(lease)
        const program = runtime.programs.get(id)!
        const diagnostic = repair && program.script ? { code: program.script.code, error: program.stats.lastError ?? '脚本故障' } : undefined
        const output = goals.length ? await compileCommand(this.deps.provider(), { ...frame, ...(diagnostic ? { diagnostic } : {}) }, this.deps.executor, { signal: lease.signal }) : { code: 'function step(snapshot,memory){return {actions:[],memory:{}}}' }
        if (lease.signal.aborted) return '已被后续变更取代，目标仍保留'
        if (runtime.commitCompile(lease, output.code)) return `${id} v${runtime.programs.get(id)!.script!.version} 已生效`
      } catch (err) {
        if (lease.signal.aborted) return '已被停止或后续变更取代'
        if (!runtime.isCompileCurrent(lease)) continue
        runtime.failCompile(lease, String(err))
        throw err
      } finally { runtime.releaseCommand(lease) }
      // 成员在编译期间发生变化：重新绑定同一完整目标集合，不丢弃命令。
    }
  }

  fault(id: string): void {
    if (this.deps.runtime.hasPendingCommand(id)) return
    const count = (this.repairs.get(id) ?? 0) + 1
    this.repairs.set(id, count)
    if (count > 2) { this.deps.log?.(`[companion] ${id} 自动修复已达限额，保持暂停`); return }
    void this.refresh(id, true).then(message => this.deps.log?.(`[companion] 修复：${message}`)).catch(err => this.deps.log?.(`[companion] 修复失败：${String(err).slice(0, 160)}`))
  }
}
