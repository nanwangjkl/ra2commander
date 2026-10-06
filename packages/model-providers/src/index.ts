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
        const text = await this.requestOnce(model, opts)
        return {
          text,
          model,
          durationMs: Date.now() - started,
          usage: this.lastUsage,
        }
      } catch (err) {
        lastError = err instanceof ProviderError ? err : new ProviderError(String(err))
        if (!lastError.retryable || attempt === MAX_RETRIES) throw lastError
        await sleep(1000 * 2 ** attempt, opts.signal)
      }
    }
    throw lastError ?? new ProviderError('unreachable')
  }

  private lastUsage?: GenerateResult['usage']

  private async requestOnce(model: string, opts: GenerateOptions): Promise<string> {
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
      }),
      signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new ProviderError(
        `HTTP ${res.status}: ${body.slice(0, 200)}`,
        res.status,
        RETRYABLE_STATUS.has(res.status),
      )
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    this.lastUsage = {
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
    }
    const text = data.choices?.[0]?.message?.content
    if (typeof text !== 'string') throw new ProviderError('响应缺少 content')
    return text
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

/** 从环境变量构造 provider：DEEPSEEK_API_KEY / GLM_API_KEY 等。 */
export function providerFromEnv(name: 'deepseek' | 'glm', env: NodeJS.ProcessEnv): OpenAICompatibleProvider {
  const prefix = name === 'deepseek' ? 'DEEPSEEK' : 'GLM'
  const apiKey = env[`${prefix}_API_KEY`]
  if (!apiKey) throw new ProviderError(`缺少 ${prefix}_API_KEY`, undefined, false)
  return new OpenAICompatibleProvider({
    name,
    baseUrl: env[`${prefix}_BASE_URL`] ?? (name === 'deepseek' ? 'https://api.deepseek.com' : 'https://open.bigmodel.cn/api/paas/v4'),
    apiKey,
    model: env[`${prefix}_MODEL`] ?? (name === 'deepseek' ? 'deepseek-chat' : 'glm-5.3-flash'),
  })
}
