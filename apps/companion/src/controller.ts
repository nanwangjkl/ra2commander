import { compileCommand, CompileError, loadPrompts, type PromptLibrary, type PromptLoader } from '@ra2c/command'
import { goalExecutionMode, type GoalSpec } from '@ra2c/contracts'
import type { OpenAICompatibleProvider } from '@ra2c/model-providers'
import type { StepExecutor } from '@ra2c/js-worker'
import type { CompileLease, TaskRuntime } from '@ra2c/runtime'
import { randomUUID } from 'node:crypto'
import { productionExecution } from './execution-modes.ts'

export interface CompilationEvent {
  stage: 'effective' | 'merged' | 'cancelled' | 'failed'
  owner: string
  sessionKey: string
  goalIds: string[]
  executionMode?: 'script' | 'native'
  version?: number
  error?: string
}

interface ControllerDeps {
  runtime: TaskRuntime
  /** 候选脚本检查专用，应用启动时与实战执行器分开创建。 */
  executor: Pick<StepExecutor, 'run'>
  provider: () => OpenAICompatibleProvider
  prepare?: (goals: GoalSpec[], signal: AbortSignal, prompts: PromptLibrary, ruleCache?: Map<string, Promise<unknown>>) => Promise<GoalSpec[]>
  log?: (message: string) => void
  prompts?: Pick<PromptLoader, 'load'>
  recordCompilation?: (event: Record<string, unknown> & { id: string; sessionKey: string; owner: string; goalIds: string[]; commandId?: string }) => void
}

interface PromptRequestOptions {
  prompts?: PromptLibrary
  onPromptVersion?: (version: string) => void
  commandId?: string
  ruleCache?: Map<string, Promise<unknown>>
}

/** 所有控制对象共用生成与修复流程，目标合并由运行时维护。 */
export class ProgramController {
  private repairs = new Map<string, { sessionKey: string; revision: number; count: number }>()
  private listeners = new Set<(event: CompilationEvent) => void>()
  private nativePreparations = new Map<string, { spec: GoalSpec; signal: AbortSignal; promise: Promise<string> }>()
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
        ...(!active && !merged ? { error: retained ? '本次生成已停止，目标仍保留待生效' : '已停止、被新目标替换或对局已变化' } : {}),
      })
    }
    return '本次生成已停止或并入后续变更；目标状态以实际生效结果为准'
  }

  setProvider(provider: () => OpenAICompatibleProvider): void { this.deps.provider = provider }

  async submit(goal: GoalSpec): Promise<string> {
    goal = productionExecution(goal)
    const id = this.deps.runtime.upsertGoal(goal)
    this.repairs.delete(id)
    return `目标 ${goal.id}：${goalExecutionMode(goal) === 'native' ? await this.prepareNative(id) : await this.refresh(id)}`
  }

  async prepareNative(id: string, options: PromptRequestOptions & { goalIds?: readonly string[] } = {}): Promise<string> {
    const { runtime } = this.deps
    this.activateNative(id)
    const goals = [...runtime.goals.values()].filter(goal => goal.ownerId === id && goal.spec.kind === 'production' && goalExecutionMode(goal.spec) === 'native' && ['pending', 'active'].includes(goal.status)
      && (!options.goalIds || options.goalIds.includes(goal.spec.id)) && JSON.stringify(goal.spec) !== JSON.stringify(goal.activeSpec))
    if (!goals.length) return `${id} 本机执行已生效`
    const prompts = options.prompts ?? (this.deps.prompts ?? { load: loadPrompts }).load()
    const cache = options.ruleCache ?? new Map<string, Promise<unknown>>()
    const tasks = goals.map(goal => {
      const previous = this.nativePreparations.get(goal.spec.id)
      if (previous?.spec === goal.spec && !previous.signal.aborted) return previous.promise
      const lease = runtime.beginNativePreparation(goal.spec.id)
      const promise = Promise.resolve().then(async () => {
        let onAbort: (() => void) | undefined
        try {
          lease.signal.throwIfAborted()
          const interrupted = new Promise<never>((_, reject) => {
            onAbort = () => reject(lease.signal.reason)
            lease.signal.addEventListener('abort', onAbort, { once: true })
          })
          const prepared = await Promise.race([this.deps.prepare ? this.deps.prepare([structuredClone(lease.spec)], lease.signal, prompts, cache) : Promise.resolve([lease.spec]), interrupted])
          if (!runtime.isNativePreparationCurrent(lease)) return `${lease.spec.id} 准备已中止或被更新`
          if (prepared.length !== 1 || !runtime.commitNativePreparation(lease, prepared[0]!)) throw new Error('生产准备结果不匹配')
          this.activateNative(id)
          return `${lease.spec.id} 本机执行已生效`
        } catch (error) {
          if (!runtime.isNativePreparationCurrent(lease)) return `${lease.spec.id} 准备已中止或被更新`
          runtime.failNativePreparation(lease, error)
          this.publish({ stage: 'failed', owner: id, sessionKey: lease.sessionKey, goalIds: [lease.spec.id], executionMode: 'native', error: `生产准备失败：${String(error)}` })
          return `${lease.spec.id} 生产准备失败：${String(error)}`
        } finally {
          if (onAbort) lease.signal.removeEventListener('abort', onAbort)
          runtime.releaseNativePreparation(lease)
          if (this.nativePreparations.get(lease.spec.id)?.spec === lease.spec) this.nativePreparations.delete(lease.spec.id)
        }
      })
      this.nativePreparations.set(lease.spec.id, { spec: lease.spec, signal: lease.signal, promise })
      return promise
    })
    return (await Promise.all(tasks)).join('；')
  }

  activateNative(id: string): string {
    const goalIds = this.deps.runtime.activateNativeGoals(id)
    if (goalIds.length) {
      this.publish({ stage: 'effective', owner: id, sessionKey: this.deps.runtime.battleKey, goalIds, executionMode: 'native' })
      this.deps.log?.(`[companion] ${id} 本机执行：${goalIds.join(', ')}`)
    }
    return goalIds.length ? `${id} 本机执行已生效` : ''
  }

  useScriptExecution(kinds: readonly GoalSpec['kind'][]): void {
    const runtime = this.deps.runtime
    for (const goalId of runtime.useScriptExecution(kinds)) {
      this.publish({ stage: 'merged', owner: runtime.goals.get(goalId)!.ownerId, sessionKey: runtime.battleKey, goalIds: [goalId], executionMode: 'script' })
    }
  }

  async refresh(id: string, repair = false, promptOptions: PromptRequestOptions = {}): Promise<string> {
    const { runtime } = this.deps
    if (!repair) { this.repairs.delete(id); this.activateNative(id) }
    const loader = this.deps.prompts ?? { load: loadPrompts }
    let prompts = promptOptions.prompts
    for (;;) {
      const lease = runtime.beginCompile(id, repair)
      if (!lease.goals.length) { runtime.releaseCommand(lease); return `${id} 无待生成的脚本目标` }
      const compilationId = randomUUID()
      const record = (event: Record<string, unknown>) => {
        try { this.deps.recordCompilation?.({ id: compilationId, sessionKey: lease.sessionKey, owner: id, goalIds: lease.goals.map(goal => goal.id), ...(promptOptions.commandId ? { commandId: promptOptions.commandId } : {}), repair, ...event }) }
        catch (error) { this.deps.log?.(`脚本归档失败：${String(error)}`) }
      }
      record({ stage: 'started' })
      try {
        // 在首次异步准备前固定版本；成员变化导致的重新绑定仍属于同一次命令。
        if (lease.goals.length) prompts ??= loader.load({
          onFallback: error => (this.deps.log ?? console.error)(`[companion] ${error.message}；沿用上一份可用提示词`),
        })
        const goals = this.deps.prepare && lease.goals.length ? await this.deps.prepare(lease.goals, lease.signal, prompts!, promptOptions.ruleCache) : lease.goals
        if (lease.signal.aborted) { record({ stage: 'discarded', reason: '准备被中止' }); return this.interrupted(lease) }
        if (!runtime.prepareCompile(lease, goals)) { record({ stage: 'discarded', reason: '成员变化，重新绑定' }); continue }
        const frame = runtime.compileFrame(lease)
        const program = runtime.programs.get(id)!
        const diagnostic = repair && program.script ? { code: program.script.code, error: program.stats.lastError ?? '脚本故障', context: runtime.recoveryContext(id) } : undefined
        const output = goals.length ? await compileCommand(this.deps.provider(), { ...frame, ...(diagnostic ? { diagnostic } : {}) }, this.deps.executor, {
          signal: lease.signal,
          prompts: prompts!,
          onTrace: trace => record({ ...trace }),
          onPromptVersion: version => {
            this.deps.log?.(`[companion] ${id} 脚本生成提示 ${version}`)
            promptOptions.onPromptVersion?.(version)
          },
        }) : { code: 'function step(snapshot,memory){return {actions:[],memory:{}}}', promptVersion: undefined }
        if (lease.signal.aborted) { record({ stage: 'discarded', reason: '生成被中止' }); return this.interrupted(lease) }
        if (runtime.commitCompile(lease, output.code, output.promptVersion)) {
          const program = runtime.programs.get(id)!
          const version = program.script!.version
          record({ stage: 'effective', version, code: output.code, promptVersion: output.promptVersion })
          this.publish({ stage: 'effective', owner: id, sessionKey: lease.sessionKey, goalIds: lease.goals.map(goal => goal.id), version, executionMode: 'script' })
          return `${id} v${version} 已生效`
        }
        record({ stage: 'discarded', reason: '目标或成员变化，候选未生效' })
      } catch (err) {
        record({ stage: lease.signal.aborted ? 'discarded' : 'failed', error: String(err) })
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

  fault(id: string, reason?: string): void {
    if (this.deps.runtime.hasPendingCommand(id)) return
    const runtime = this.deps.runtime, program = runtime.programs.get(id)
    if (!program?.script || !['active', 'paused'].includes(program.status) || !program.activeGoalIds.some(goalId => { const goal = runtime.goals.get(goalId); return goal?.status === 'active' && goal.activeSpec && goalExecutionMode(goal.activeSpec) === 'script' })) return
    const previous = this.repairs.get(id)
    const count = (previous?.sessionKey === runtime.battleKey && previous.revision === program.revision ? previous.count : 0) + 1
    if (count > 2) {
      if (previous?.count === 2) this.deps.log?.(`[companion] ${id} 自动修复已达限额，等待新命令`)
      this.repairs.set(id, { sessionKey: runtime.battleKey, revision: program.revision, count })
      return
    }
    this.repairs.set(id, { sessionKey: runtime.battleKey, revision: program.revision, count })
    if (reason) { program.stats.lastError = `执行停滞：${reason}`; this.deps.log?.(`[companion] ${id} ${program.stats.lastError}，开始诊断`) }
    void this.refresh(id, true).then(message => this.deps.log?.(`[companion] 修复：${message}`)).catch(err => this.deps.log?.(`[companion] 修复失败：${String(err).slice(0, 160)}`))
  }
}
