import { decodeSpeechWave, SPEECH_MODEL, type SpeechRecognizer } from '@ra2c/speech'
import type { CommandLog } from './command-log.ts'

interface VoiceCommand {
  state: 'recording' | 'transcribing' | 'submitted' | 'cancelled' | 'failed'
  sessionKey: string | null
  abort: AbortController
  expiry: NodeJS.Timeout
  release?: () => void
}
interface VoiceOptions {
  log: CommandLog
  sessionKey: () => string | null
  recognizer: () => SpeechRecognizer
  submit: (text: string, id: string, source: 'voice') => Promise<unknown>
  reserve?: ((id: string) => { signal: AbortSignal; finish: () => void }) | undefined
}

/** 语音只负责最终转写的交接；取消和换局使迟到识别结果失效，不建立另一套决策链。 */
export class VoiceCommands {
  private readonly commands = new Map<string, VoiceCommand>()
  private closed = false
  constructor(private readonly options: VoiceOptions) {}
  private emit(id: string, command: VoiceCommand, event: Parameters<CommandLog['emit']>[0]) {
    this.options.log.emit({ ...event, commandId: id, source: 'voice', ...(command.sessionKey ? { sessionKey: command.sessionKey } : {}) })
  }
  private terminal(id: string, command: VoiceCommand) {
    clearTimeout(command.expiry)
    command.expiry = setTimeout(() => { if (this.commands.get(id) === command) this.commands.delete(id) }, 5 * 60_000); command.expiry.unref()
  }
  start(id: string): void {
    if (this.closed) throw new Error('语音入口正在退出')
    if (this.commands.has(id) || this.options.log.since(0).some(event => event.commandId === id)) throw new Error('这条语音已经接收或取消，请重新录音')
    if ([...this.commands.values()].filter(command => ['recording', 'transcribing'].includes(command.state)).length >= 4) throw new Error('正在处理多条语音，请稍后重试')
    const status = this.options.recognizer().status()
    if (status.state !== 'ready') throw new Error(status.error || '本地识别器尚未就绪，请在设置中检查')
    const command: VoiceCommand = { state: 'recording', sessionKey: this.options.sessionKey(), abort: new AbortController(), expiry: setTimeout(() => this.cancel(id, '录音超时，已取消'), 35_000) }
    command.expiry.unref(); this.commands.set(id, command)
    this.emit(id, command, { commandId: id, source: 'voice', stage: 'recording', speech: { model: SPEECH_MODEL } })
  }
  audio(id: string, bytes: Buffer): void {
    const command = this.commands.get(id)
    if (!command || command.state !== 'recording') throw new Error('这条录音已接收或取消，不会重复执行')
    try {
      const audio = decodeSpeechWave(bytes)
      const reserved = this.options.reserve?.(id)
      const interrupted = () => this.cancel(id, '已被后续控制指令取消，未提交迟到语音')
      if (reserved) {
        reserved.signal.addEventListener('abort', interrupted, { once: true })
        command.release = () => { reserved.signal.removeEventListener('abort', interrupted); reserved.finish() }
      }
      command.state = 'transcribing'; clearTimeout(command.expiry)
      command.expiry = setTimeout(() => this.cancel(id, '识别超时，已取消'), 50_000); command.expiry.unref()
      this.emit(id, command, { commandId: id, source: 'voice', stage: 'transcribing', speech: { model: SPEECH_MODEL, audioMs: audio.durationMs } })
      if (reserved?.signal.aborted) { interrupted(); return }
      const recognizer = this.options.recognizer()
      void recognizer.transcribe(audio.samples, command.abort.signal).then(result => {
        if (command.abort.signal.aborted || command.state !== 'transcribing' || this.closed) return
        if (command.sessionKey !== this.options.sessionKey()) { this.cancel(id, '对局已经切换，这条语音已取消'); return }
        if (!/[\p{L}\p{N}]/u.test(result.text)) throw new Error('没有识别出命令，请重新说话')
        command.state = 'submitted'; this.terminal(id, command)
        this.emit(id, command, { commandId: id, source: 'voice', stage: 'received', text: result.text,
          speech: { model: SPEECH_MODEL, audioMs: audio.durationMs, recognitionMs: result.recognitionMs } })
        return this.options.submit(result.text, id, 'voice')
      }).catch(error => {
        if (command.abort.signal.aborted || this.closed) return
        command.state = 'failed'; this.terminal(id, command)
        this.emit(id, command, { commandId: id, source: 'voice', stage: 'failed', error: String(error) })
      }).finally(() => { command.release?.(); delete command.release })
    } catch (error) {
      command.state = 'failed'; this.terminal(id, command)
      command.release?.(); delete command.release
      this.emit(id, command, { commandId: id, source: 'voice', stage: 'failed', error: String(error) }); throw error
    }
  }
  cancel(id: string, reason = '已取消这次语音'): void {
    let command = this.commands.get(id)
    if (!command) {
      // 取消可先于迟到的 start 到达，留下短期取消标记，不复活旧录音。
      command = { state: 'cancelled', sessionKey: this.options.sessionKey(), abort: new AbortController(), expiry: setTimeout(() => {}, 0) }
      this.commands.set(id, command); this.terminal(id, command); return
    }
    if (!['recording', 'transcribing'].includes(command.state)) return
    command.state = 'cancelled'; command.abort.abort(); command.release?.(); delete command.release; this.terminal(id, command)
    this.emit(id, command, { commandId: id, source: 'voice', stage: 'cancelled', error: reason.slice(0, 200) })
  }
  cancelAll(reason: string): void { for (const id of this.commands.keys()) this.cancel(id, reason) }
  close(): void {
    if (this.closed) return
    this.cancelAll('语音入口断开，这次录音已取消'); this.closed = true
    for (const command of this.commands.values()) clearTimeout(command.expiry)
    this.commands.clear()
  }
}
