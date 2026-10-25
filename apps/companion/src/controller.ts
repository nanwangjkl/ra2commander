import { compileCommand, CompileError, loadPrompts, type PromptLibrary, type PromptLoader } from '@ra2c/command'
import type { GoalSpec } from '@ra2c/contracts'
import type { OpenAICompatibleProvider } from '@ra2c/model-providers'
import type { StepExecutor } from '@ra2c/js-worker'
import type { CompileLease, TaskRuntime } from '@ra2c/runtime'

export interface CompilationEvent {
  stage: 'effective' | 'merged' | 'cancelled' | 'failed'
  owner: string
  sessionKey: string
  goalIds: string[]
  version?: number
  error?: string
}

interface ControllerDeps {
  runtime: TaskRuntime
  executor: Pick<StepExecutor, 'run'>
  provider: () => OpenAICompatibleProvider
  prepare?: (goals: GoalSpec[], signal: AbortSignal) => Promise<GoalSpec[]>
  log?: (message: string) => void
  prompts?: Pick<PromptLoader, 'load'>
}

interface PromptRequestOptions {
  prompts?: PromptLibrary
  onPromptVersion?: (version: string) => void
}

/** 所有控制对象共用生成与修复流程，目标合并由运行时维护。 */
export class ProgramController {
  private repairs = new Map<string, number>()
  private listeners = new Set<(event: CompilationEvent) => void>()
  constructor(private readonly deps: ControllerDeps) {}

  subscribe(listener: (event: CompilationEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(event: CompilationEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch (error) { this.deps.log?.(`编译反馈失败：${String(error)}`) }
    }
  }

  private interrupted(lease: CompileLease): string {
    const { runtime } = this.deps
    const program = runtime.programs.get(lease.ownerId)
    for (const spec of lease.goals) {
      const goal = runtime.battleKey === lease.sessionKey ? runtime.goals.get(spec.id) : undefined
      const retained = goal && goal.status !== 'cancelled' && program?.goalIds.includes(spec.id)
      const active = retained && goal.status === 'active' && JSON.stringify(goal.activeSpec) === JSON.stringify(goal.spec)
      const merged = retained && (runtime.hasPendingCommand(lease.ownerId) || (program?.revision ?? -1) > lease.revision)
      this.publish({ owner: lease.ownerId, sessionKey: lease.sessionKey, goalIds: [spec.id],
        stage: active ? 'effective' : merged ? 'merged' : 'cancelled',
        ...(active && program?.script ? { version: program.script.version } : {}),
        ...(!active ? { error: merged ? '已合并到后续脚本生成，目标仍保留' : retained ? '本次生成已停止，目标仍保留待生效' : '已停止、被新目标替换或对局已变化' } : {}),
      })
    }
    return '本次生成已停止或并入后续变更；目标状态以实际生效结果为准'
  }

  setProvider(provider: () => OpenAICompatibleProvider): void { this.deps.provider = provider }

  async submit(goal: GoalSpec): Promise<string> {
    const id = this.deps.runtime.upsertGoal(goal)
    this.repairs.delete(id)
    return `目标 ${goal.id}：${await this.refresh(id)}`
  }

  async refresh(id: string, repair = false, promptOptions: PromptRequestOptions = {}): Promise<string> {
    const { runtime } = this.deps
    const loader = this.deps.prompts ?? { load: loadPrompts }
    let prompts = promptOptions.prompts
    for (;;) {
      const lease = runtime.beginCompile(id, repair)
      try {
        // 在首次异步准备前固定版本；成员变化导致的重新绑定仍属于同一次命令。
        if (lease.goals.length) prompts ??= loader.load({
          onFallback: error => (this.deps.log ?? console.error)(`[companion] ${error.message}；沿用上一份可用提示词`),
        })
        const goals = this.deps.prepare ? await this.deps.prepare(lease.goals, lease.signal) : lease.goals
        if (lease.signal.aborted) return this.interrupted(lease)
        if (!runtime.prepareCompile(lease, goals)) continue
        const frame = runtime.compileFrame(lease)
        const program = runtime.programs.get(id)!
        const diagnostic = repair && program.script ? { code: program.script.code, error: program.stats.lastError ?? '脚本故障' } : undefined
        const output = goals.length ? await compileCommand(this.deps.provider(), { ...frame, ...(diagnostic ? { diagnostic } : {}) }, this.deps.executor, {
          signal: lease.signal,
          prompts: prompts!,
          onPromptVersion: version => {
            this.deps.log?.(`[companion] ${id} 脚本生成提示 ${version}`)
            promptOptions.onPromptVersion?.(version)
          },
        }) : { code: 'function step(snapshot,memory){return {actions:[],memory:{}}}', promptVersion: undefined }
        if (lease.signal.aborted) return this.interrupted(lease)
        if (runtime.commitCompile(lease, output.code, output.promptVersion)) {
          const program = runtime.programs.get(id)!
          const version = program.script!.version
          this.publish({ stage: 'effective', owner: id, sessionKey: lease.sessionKey, goalIds: [...program.activeGoalIds], version })
          return `${id} v${version} 已生效`
        }
      } catch (err) {
        if (lease.signal.aborted) return this.interrupted(lease)
        if (!runtime.isCompileCurrent(lease)) continue
        // 普通改令失败时旧脚本继续；不能把其中已有的有效目标也标成失败。
        const goalIds = lease.goals.filter(spec => {
          const goal = runtime.goals.get(spec.id)
          return goal && !goal.activeSpec
        }).map(spec => spec.id)
        runtime.failCompile(lease, String(err))
        const detail = err instanceof CompileError ? err.log.at(-1)?.errors.join('；') : undefined
        this.publish({ stage: 'failed', owner: id, sessionKey: lease.sessionKey, goalIds, error: `脚本生成失败：${String(err)}${detail ? `\n${detail}` : ''}` })
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
