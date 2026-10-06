import type { OpenAICompatibleProvider } from '@ra2c/model-providers'
import type { Snapshot, StepConstraints, StepOutcome } from '@ra2c/contracts'
import { compileChecks, extractCode, SYSTEM_PROMPT } from './script-contract.ts'

/** 命令的对象与地域绑定（M2 由宿主简易解析；后续接语音澄清流程）。 */
export interface CompileBinding {
  /** 授权操纵的单位 id。 */
  unitIds: number[]
  /** 战损基准（任务生效时原始成员）；缺省为 unitIds。 */
  originalMembers?: number[]
  /** 守区/目标地域。 */
  region?: { name: string; x1: number; y1: number; x2: number; y2: number }
  /** 生产任务：目标与必要前置闭包（固定程序计算，模型只负责执行步骤）。 */
  production?: { target: string; closure: string[] }
}

export interface CompileInput {
  rawText: string
  binding: CompileBinding
  /** 最近一次真实快照，用于干跑。 */
  snapshot?: Snapshot
}

export interface CompileAttemptLog {
  attempt: number
  errors: string[]
  model: string
  durationMs: number
  tokens?: number
}

export interface CompileOutcome {
  code: string
  attempts: number
  log: CompileAttemptLog[]
}

export class CompileError extends Error {
  constructor(message: string, readonly log: CompileAttemptLog[]) {
    super(message)
  }
}

/** 干跑执行器接口（由 @ra2c/js-worker 的 StepExecutor 实现；此处仅依赖接口）。 */
export interface DryRunExecutor {
  run(
    code: string,
    snapshot: unknown,
    memory: unknown,
    constraints: StepConstraints,
    timeoutMs?: number,
  ): Promise<StepOutcome>
}

function bindingPrompt(input: CompileInput): string {
  const b = input.binding
  const lines = [
    `玩家命令：「${input.rawText}」`,
    `绑定单位 id（只能操纵这些）: ${b.unitIds.join(', ')}`,
    `原始成员（战损口径基准，阵亡比例按此计算）: ${(b.originalMembers ?? b.unitIds).join(', ')}`,
  ]
  if (b.region) {
    lines.push(`授权地域「${b.region.name}」: 矩形 (${b.region.x1},${b.region.y1}) 到 (${b.region.x2},${b.region.y2})；没有授权不得离开`)
  } else {
    lines.push('无固定守区限制（按命令语义执行）')
  }
  if (input.snapshot) {
    const s = input.snapshot
    const selfSample = s.self.slice(0, 5).map((u) => `#${u.id} ${u.name}(${u.rx},${u.ry})`).join('；')
    const enemySample = s.enemies.slice(0, 5).map((u) => `#${u.id} ${u.name}(${u.rx},${u.ry})`).join('；')
    lines.push(
      `当前快照: tick=${s.tick} 资金=${Math.floor(s.credits)} 地图=${s.mapWidth}x${s.mapHeight}`,
      `己方 ${s.self.length} 单位（示例: ${selfSample}）；可见敌人 ${s.enemies.length}（示例: ${enemySample}）`,
    )
    if (b.production) {
      const p = s.production
      const queues = p ? p.queues.map((q) => `type${q.type}:${q.status}(${q.items.map((i) => `${i.name}x${i.quantity}@${Math.floor(i.progress * 100)}%`).join(',') || '空'})`).join('；') : '无数据'
      lines.push(
        `生产目标: ${b.production.target}；必要前置闭包（按顺序，只允许操作这些项目）: ${[...b.production.closure, b.production.target].join(' → ')}`,
        `生产状态: 电力 ${p ? `${p.power.drain}/${p.power.total}${p.power.isLowPower ? '（低电）' : ''}` : '?'}；队列: ${queues}`,
        `可造清单: ${p ? p.available.slice(0, 30).join(',') : '?'}`,
      )
    }
  }
  return lines.join('\n')
}

/**
 * 命令编译循环：生成 → 静态/编译检查 → 真实快照干跑 → 错误反馈修复（限次）。
 * 全部尝试失败时抛 CompileError（含各轮错误，供反馈给玩家）。
 */
export async function compileCommand(
  provider: OpenAICompatibleProvider,
  input: CompileInput,
  executor: DryRunExecutor,
  { signal, maxAttempts = 3 }: { signal?: AbortSignal; maxAttempts?: number } = {},
): Promise<CompileOutcome> {
  const log: CompileAttemptLog[] = []
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: bindingPrompt(input) },
  ]

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 验证阶段放开输出上限（截断会破坏代码块；API 端会钳制到其支持的最大值）。
    // 思考模式默认关闭：实测生成战术脚本不需要（开思考 82s、关 7s，质量相同）。
    const result = await provider.generate({ messages, signal, maxTokens: 32768, thinking: 'disabled' })
    const code = extractCode(result.text)
    let errors: string[] = []
    if (!code) {
      errors = ['输出中没有可用的 ```js 代码块或 function step 声明']
    } else {
      errors = compileChecks(code)
      if (!errors.length && input.snapshot) {
        const snap = input.snapshot
        const constraints: StepConstraints = {
          allowedUnitIds: input.binding.unitIds,
          enemyIds: snap.enemies.map((u) => u.id),
          mapWidth: snap.mapWidth,
          mapHeight: snap.mapHeight,
          ...(input.binding.production
            ? { allowedProduce: [...input.binding.production.closure, input.binding.production.target] }
            : {}),
        }
        const dry = await executor.run(code, snap, {}, constraints, 200)
        if (!dry.ok) errors = [`干跑失败: ${dry.error}`]
      }
    }
    log.push({ attempt, errors, model: result.model, durationMs: result.durationMs })
    if (!errors.length && code) return { code, attempts: attempt, log }
    if (attempt < maxAttempts) {
      messages.push({ role: 'assistant', content: result.text })
      messages.push({
        role: 'user',
        content: `校验失败，错误如下，请修复后重新输出完整脚本（只改必要部分，保持授权边界不变）：\n${errors.map((e) => `- ${e}`).join('\n')}`,
      })
    }
  }
  throw new CompileError(`编译失败（${maxAttempts} 次尝试）`, log)
}
