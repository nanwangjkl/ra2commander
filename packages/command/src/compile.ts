import type { OpenAICompatibleProvider } from '@ra2c/model-providers'
import type { Snapshot, StepConstraints, StepOutcome } from '@ra2c/contracts'
import { compileChecks, extractCode } from './script-contract.ts'
import { loadPrompts, type PromptLibrary } from './prompt-loader.ts'

export interface CompileInput {
  snapshot: Snapshot
  constraints: StepConstraints
  diagnostic?: { code: string; error: string }
}
export interface CompileAttemptLog { attempt: number; errors: string[]; model: string; durationMs: number; promptVersion: string; promptTopics: string[]; tokens?: number }
export interface CompileOutcome { code: string; attempts: number; log: CompileAttemptLog[]; promptVersion: string }
export interface CompileTrace {
  stage: 'request' | 'response' | 'validation'
  attempt: number
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  response?: { text: string; model: string; durationMs: number; usage?: unknown }
  code?: string
  errors?: string[]
  promptVersion: string
  promptTopics: string[]
}
export class CompileError extends Error {
  constructor(message: string, readonly log: CompileAttemptLog[], readonly promptVersion: string) { super(message) }
}
export interface DryRunExecutor {
  run(code: string, snapshot: unknown, memory: unknown, constraints: StepConstraints, timeoutMs?: number): Promise<StepOutcome>
}

/** 生成某个控制对象的完整新版本；干跑不接触游戏或运行时事实。 */
export async function compileCommand(
  provider: OpenAICompatibleProvider,
  input: CompileInput,
  executor: DryRunExecutor,
  { signal, maxAttempts = 3, prompts, onPromptFallback, onPromptVersion, onTrace }: { signal?: AbortSignal; maxAttempts?: number; prompts?: PromptLibrary; onPromptFallback?: (error: Error) => void; onPromptVersion?: (version: string) => void; onTrace?: (trace: CompileTrace) => void } = {},
): Promise<CompileOutcome> {
  const snap = input.snapshot
  if (!snap.control) throw new Error('缺少控制对象与完整目标集合')
  const promptLibrary = prompts ?? loadPrompts(onPromptFallback ? { onFallback: onPromptFallback } : {})
  const log: CompileAttemptLog[] = []
  const goals = snap.control.goals.map(goal => goal.spec)
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: promptLibrary.compileFor(goals, !!input.diagnostic) },
    // 分区几何留在宿主校验；模型只需分区名称、目的地和已筛选的目标，避免重复传输轮廓。
    { role: 'user', content: JSON.stringify({ control: snap.control, constraints: input.constraints, production: snap.production, tick: snap.tick, credits: snap.credits, mapWidth: snap.mapWidth, mapHeight: snap.mapHeight, self: snap.self.slice(0, 5), enemies: snap.enemies.slice(0, 5) }, (key, value) => key === 'polygons' ? undefined : value) },
  ]
  if (input.diagnostic) {
    messages.push({ role: 'assistant', content: input.diagnostic.code })
    messages.push({ role: 'user', content: promptLibrary.render('repair', { error: input.diagnostic.error }) })
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    signal?.throwIfAborted()
    const recovery = !!input.diagnostic || attempt > 1
    messages[0]!.content = promptLibrary.compileFor(goals, recovery)
    onPromptVersion?.(promptLibrary.version)
    const trace = (value: Pick<CompileTrace, 'stage'> & Partial<CompileTrace>) => onTrace?.({ attempt, promptVersion: promptLibrary.version, promptTopics: promptLibrary.tactics.select('compile', goals, recovery).map(tactic => tactic.id), ...value })
    trace({ stage: 'request', messages: structuredClone(messages) })
    const result = await provider.generate({ messages, signal, maxTokens: 32768, thinking: 'disabled' })
    trace({ stage: 'response', response: result })
    signal?.throwIfAborted()
    const code = extractCode(result.text)
    let errors = code ? compileChecks(code) : ['没有可用的 function step 或 js 代码块']
    if (code && !errors.length) {
      const dry = await executor.run(code, snap, {}, input.constraints, 200)
      signal?.throwIfAborted()
      if (!dry.ok) errors = [dry.error ?? '干跑失败']
    }
    log.push({ attempt, errors, model: result.model, durationMs: result.durationMs, promptVersion: promptLibrary.version, promptTopics: promptLibrary.tactics.select('compile', goals, recovery).map(tactic => tactic.id), ...(result.usage?.completionTokens ? { tokens: result.usage.completionTokens } : {}) })
    trace({ stage: 'validation', ...(code ? { code } : {}), errors })
    if (code && !errors.length) return { code, attempts: attempt, log, promptVersion: promptLibrary.version }
    messages.push({ role: 'assistant', content: result.text }, { role: 'user', content: promptLibrary.render('validationFeedback', { errors: errors.join('; ') }) })
  }
  throw new CompileError('脚本编译失败', log, promptLibrary.version)
}
