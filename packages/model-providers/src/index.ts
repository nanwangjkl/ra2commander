/**
 * 云模型适配层：DeepSeek 与智谱 GLM 均为 OpenAI 兼容协议，一套客户端通吃。
 * 原生 fetch 实现（无 SDK 依赖），支持流式、取消与限次重试。
 * 取消语义：AbortSignal 触发后拒绝 Promise——迟到结果不允许激活任务，由调用方保证。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface GenerateOptions {
  messages: ChatMessage[]
  /** 覆盖 provider 默认模型。 */
  model?: string | undefined
  maxTokens?: number | undefined
  temperature?: number | undefined
  signal?: AbortSignal | undefined
  /**
   * 思考模式开关（DeepSeek/GLM 的 OpenAI 兼容扩展）。
   * 战术脚本生成实测不需要深度思考：默认思考模式 82s（其中 20k 思考 token），
   * 关闭后 7s 且质量相同。默认关闭。
   */
  thinking?: 'enabled' | 'disabled' | undefined
}

export interface GenerateResult {
  text: string
  model: string
  durationMs: number
  usage?: { promptTokens?: number | undefined; completionTokens?: number | undefined } | undefined
}

export interface ProviderConfig {
  name: string
  baseUrl: string
  apiKey: string
  model: string
  revision?: number
  source?: 'file' | 'env'
}

/** 归档只记录公开配置，不复制认证字段。 */
export function providerInfo(provider: OpenAICompatibleProvider) {
  const c = provider.config
  return c ? { name: c.name, baseUrl: c.baseUrl, model: c.model, revision: c.revision ?? 0, source: c.source ?? 'env' } : undefined
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable?: boolean,
  ) {
    super(message)
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const MAX_RETRIES = 2

export class OpenAICompatibleProvider {
  constructor(readonly config: ProviderConfig) {}

  get model(): string {
    return this.config.model
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const started = Date.now()
    const model = opts.model ?? this.config.model
    let lastError: ProviderError | undefined

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (opts.signal?.aborted) throw new ProviderError('已取消', undefined, false)
      try {
        const result = await this.requestOnce(model, opts)
        return {
          ...result,
          model,
          durationMs: Date.now() - started,
        }
      } catch (err) {
        lastError = err instanceof ProviderError ? err : new ProviderError(String(err))
        if (!lastError.retryable || attempt === MAX_RETRIES) throw lastError
        await sleep(1000 * 2 ** attempt, opts.signal)
      }
    }
    throw lastError ?? new ProviderError('unreachable')
  }

  private async requestOnce(model: string, opts: GenerateOptions): Promise<Pick<GenerateResult, 'text' | 'usage'>> {
    // 挂起保护：单请求 120s 硬超时（实测 GLM coding 端点在大 max_tokens 下可能长期不返回）。
    const timeoutSignal = AbortSignal.timeout(120_000)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal
    const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? 32768,
        temperature: opts.temperature ?? 0.2,
        stream: false,
        thinking: { type: opts.thinking ?? 'disabled' },
      }),
      signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new ProviderError(
        `HTTP ${res.status}: ${(this.config.apiKey ? body.split(this.config.apiKey).join('[已隐藏]') : body).slice(0, 200)}`,
        res.status,
        RETRYABLE_STATUS.has(res.status),
      )
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const usage = {
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
    }
    const text = data.choices?.[0]?.message?.content
    if (typeof text !== 'string') throw new ProviderError('响应缺少 content')
    return { text, usage }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new ProviderError('已取消', undefined, false))
      },
      { once: true },
    )
  })
}

/** 内置别名（兼容简写 env）；任意 OpenAI 兼容服务用 MODEL_<NAME>_* 配置接入。 */
const BUILTIN: Record<string, { baseUrl: string; model: string; legacyPrefix?: string }> = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', legacyPrefix: 'DEEPSEEK' },
  glm: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash', legacyPrefix: 'GLM' },
}

/**
 * 从环境变量构造 provider。两种配置方式（开源使用者可接任意 OpenAI 兼容服务）：
 *   MODEL_<NAME>_API_KEY / MODEL_<NAME>_BASE_URL / MODEL_<NAME>_MODEL   （通用，NAME 小写即 provider 名）
 *   <PREFIX>_API_KEY / <PREFIX>_BASE_URL / <PREFIX>_MODEL               （deepseek/glm 内置别名）
 */
export function providerFromEnv(name: string, env: NodeJS.ProcessEnv): OpenAICompatibleProvider {
  const key = name.toUpperCase()
  const builtin = BUILTIN[name]
  const apiKey =
    env[`MODEL_${key}_API_KEY`] ?? (builtin?.legacyPrefix ? env[`${builtin.legacyPrefix}_API_KEY`] : undefined)
  if (!apiKey) throw new ProviderError(`缺少 MODEL_${key}_API_KEY`, undefined, false)
  return new OpenAICompatibleProvider({
    name,
    baseUrl:
      env[`MODEL_${key}_BASE_URL`] ?? (builtin?.legacyPrefix ? env[`${builtin.legacyPrefix}_BASE_URL`] : undefined)
      ?? builtin?.baseUrl ?? '',
    apiKey,
    model:
      env[`MODEL_${key}_MODEL`] ?? (builtin?.legacyPrefix ? env[`${builtin.legacyPrefix}_MODEL`] : undefined)
      ?? builtin?.model ?? name,
  })
}

/** 扫描环境变量，返回全部已配置的 provider 名（内置别名 + MODEL_* 泛化配置）。 */
export function configuredProviderNames(env: NodeJS.ProcessEnv): string[] {
  const names = new Set<string>()
  for (const k of Object.keys(env)) {
    const m = k.match(/^MODEL_([A-Z0-9_]+)_API_KEY$/)
    if (m && env[k]) names.add(m[1]!.toLowerCase())
  }
  for (const [name, b] of Object.entries(BUILTIN)) {
    if (env[`MODEL_${name.toUpperCase()}_API_KEY`] || (b.legacyPrefix && env[`${b.legacyPrefix}_API_KEY`])) {
      names.add(name)
    }
  }
  return [...names]
}
