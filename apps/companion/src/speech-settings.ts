import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { LocalSpeechRecognizer, resolveSpeechModelDir, type SpeechRecognizer } from '@ra2c/speech'
import { SPEECH_KEYS, type SpeechSettingsInput, type SpeechSettingsView } from '@ra2c/contracts'
import { atomicWrite } from './battle-storage.ts'

export class SpeechSettings {
  private readonly path: string
  private config: SpeechSettingsInput
  private warning = ''
  private readonly modelOverride: string
  recognizer: SpeechRecognizer
  constructor(private readonly root: string, environment: NodeJS.ProcessEnv = process.env) {
    this.path = join(root, '.runtime/speech/settings.json')
    this.modelOverride = environment.RA2C_SPEECH_MODEL_DIR || ''
    this.config = { revision: 0, deviceId: '', key: 'Backquote' }
    if (existsSync(this.path)) {
      try {
        const data = JSON.parse(readFileSync(this.path, 'utf8'))
        if (![1, 2].includes(data.version) || !Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error('格式')
        this.config = { ...this.validate(data), revision: data.revision }
      } catch { this.warning = '语音配置无法读取，原文件已保留；修复后重启可恢复设置编辑' }
    }
    this.recognizer = new LocalSpeechRecognizer(this.modelDir)
  }
  get modelDir(): string { return resolveSpeechModelDir(this.root, this.modelOverride) }
  private validate(input: SpeechSettingsInput): SpeechSettingsInput {
    if (!input || !Object.hasOwn(SPEECH_KEYS, input.key) || typeof input.deviceId !== 'string' || input.deviceId.length > 2048) throw new Error('语音设置格式错误')
    return { revision: input.revision, deviceId: input.deviceId, key: input.key }
  }
  view(): SpeechSettingsView { return { ...this.config, modelDir: this.modelDir, warning: this.warning, engine: this.recognizer.status() } }
  save(input: SpeechSettingsInput): SpeechSettingsView {
    if (this.warning) throw new Error(this.warning)
    if (!input || input.revision !== this.config.revision) throw new Error('语音设置已更新，请重新切换设置页后保存')
    const next = { ...this.validate(input), revision: this.config.revision + 1 }
    mkdirSync(dirname(this.path), { recursive: true })
    atomicWrite(this.path, JSON.stringify({ version: 2, ...next }, null, 2), true)
    this.config = next
    return this.view()
  }
  reload(): void {
    this.recognizer.close(); this.recognizer = new LocalSpeechRecognizer(this.modelDir)
    void this.recognizer.start().catch(() => {})
  }
  close(): void { this.recognizer.close() }
}
