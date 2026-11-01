import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { configuredProviderNames, OpenAICompatibleProvider, providerFromEnv, type ProviderConfig } from '@ra2c/model-providers'
import type { ModelSettingsInput, ModelSettingsView } from '@ra2c/contracts'
import { atomicWrite } from './battle-storage.ts'

type Configuration = Pick<ProviderConfig, 'baseUrl' | 'model' | 'apiKey'>
interface StoredSettings { version: 2; revision: number; configuration: Configuration }
function baseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('请填写有效的 Base URL')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('Base URL 格式错误') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL 需为 HTTP(S) 服务地址，不能包含认证、查询参数或片段')
  const result = url.href.replace(/\/+$/, '')
  if (result.endsWith('/chat/completions')) throw new Error('请填写 Base URL，去掉末尾 /chat/completions')
  return result
}
function modelName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\r\n\0]/.test(value)) throw new Error('请填写有效的模型名称')
  return value.trim()
}

/** 仅保留当前一套配置；新保存覆盖旧值，在途请求继续使用旧实例。 */
export class ModelSettings {
  // 兼容现有终端调试接口，集合中最多只有 current，不保存模型配置列表。
  readonly providers = new Map<string, OpenAICompatibleProvider>()
  private readonly secrets = new Set<string>()
  private readonly path: string
  private revision = 0
  private configuration: Configuration = { baseUrl: '', model: '', apiKey: '' }
  private source: 'file' | 'env' = 'env'
  private readError = ''
  constructor(root: string, environment: NodeJS.ProcessEnv = process.env) {
    this.path = join(root, '.runtime/settings.json')
    const names = configuredProviderNames(environment)
    const fromEnvironment = (name: string) => this.validate(providerFromEnv(name, environment).config)
    for (const name of names) {
      try { this.configuration = fromEnvironment(name); break } catch { /* 可在页面补齐配置。 */ }
    }
    if (existsSync(this.path)) {
      try {
        const data = JSON.parse(readFileSync(this.path, 'utf8'))
        if (!data || !Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error('格式')
        let config: Configuration
        if (data.version === 2) config = this.validate(data.configuration)
        else if (data.version === 1 && data.providers && !Array.isArray(data.providers) && typeof data.providers === 'object' && typeof data.activeProvider === 'string') {
          const name = data.activeProvider || Object.keys(data.providers)[0] || names[0]
          config = name && Object.hasOwn(data.providers, name) ? this.validate(data.providers[name]) : name ? fromEnvironment(name) : this.configuration
        } else throw new Error('版本')
        this.configuration = config; this.revision = data.revision; this.source = 'file'
        if (data.version === 1) {
          this.revision++
          atomicWrite(this.path, JSON.stringify({ version: 2, revision: this.revision, configuration: config }, null, 2), true)
        }
      } catch { this.readError = '本机 settings.json 无法读取或转换，原配置文件已保留；修复后重启可恢复设置编辑' }
    }
    if (this.configuration.apiKey) this.secrets.add(this.configuration.apiKey)
    this.rebuild()
  }
  private validate(value: unknown): Configuration {
    if (!value || typeof value !== 'object') throw new Error('配置格式错误')
    const c = value as Configuration
    if (typeof c.apiKey !== 'string' || c.apiKey.length > 8192 || /[\r\n\0]/.test(c.apiKey)) throw new Error('Key 格式错误')
    return { baseUrl: baseUrl(c.baseUrl), model: modelName(c.model), apiKey: c.apiKey }
  }
  private rebuild(): void {
    this.providers.clear()
    if (this.configuration.apiKey) this.providers.set('current', new OpenAICompatibleProvider({ ...this.configuration, name: 'current', source: this.source, revision: this.revision }))
  }
  current = (): OpenAICompatibleProvider => {
    const provider = this.providers.get('current')
    if (!provider) throw new Error('当前模型未配置，请在设置页填写 URL、Key 和模型名称')
    return provider
  }
  view(): ModelSettingsView {
    return { revision: this.revision, warning: this.readError, baseUrl: this.configuration.baseUrl, model: this.configuration.model, hasKey: !!this.configuration.apiKey }
  }
  sanitize(error: unknown): string {
    let text = String(error)
    for (const secret of this.secrets) if (secret) text = text.split(secret).join('[已隐藏]')
    return text
  }
  private candidate(input: ModelSettingsInput): Configuration {
    if (!input) throw new Error('设置格式错误')
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 8192 || /[\r\n\0]/.test(input.apiKey))) throw new Error('Key 格式错误')
    const url = baseUrl(input.baseUrl), key = input.apiKey?.trim() ?? ''
    if (key) this.secrets.add(key)
    if (this.configuration.apiKey && url !== this.configuration.baseUrl && !key) throw new Error('更换 URL 时请填写适用的 Key')
    const configuration = { baseUrl: url, model: modelName(input.model), apiKey: key || this.configuration.apiKey }
    if (!configuration.apiKey) throw new Error('请填写 API Key')
    return configuration
  }
  save(input: ModelSettingsInput): ModelSettingsView {
    if (this.readError) throw new Error(this.readError)
    if (!input || input.revision !== this.revision) throw new Error('配置已更新，请切换页签重新读取后保存')
    const configuration = this.candidate(input)
    const next: StoredSettings = { version: 2, revision: this.revision + 1, configuration }
    mkdirSync(dirname(this.path), { recursive: true })
    atomicWrite(this.path, JSON.stringify(next, null, 2), true)
    this.configuration = configuration; this.revision = next.revision; this.source = 'file'; this.rebuild()
    return this.view()
  }
  async test(input: ModelSettingsInput, signal: AbortSignal): Promise<void> {
    const configuration = this.candidate(input)
    await new OpenAICompatibleProvider({ ...configuration, name: 'current' }).generate({ messages: [{ role: 'user', content: 'Reply OK' }], maxTokens: 8, signal, thinking: 'disabled' })
  }
}
