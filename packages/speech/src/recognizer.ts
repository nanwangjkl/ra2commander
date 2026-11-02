import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { hasSpeechModelFiles } from './model.ts'

export interface SpeechRecognizer {
  status(): { state: 'missing' | 'loading' | 'ready' | 'error' | 'closed'; error: string }
  start(): Promise<void>
  transcribe(samples: Float32Array, signal: AbortSignal): Promise<{ text: string; recognitionMs: number }>
  close(): void
}
interface Pending { resolve: (result: { text: string; recognitionMs: number }) => void; reject: (error: Error) => void }

/** 原生推理独立于实时调度；子进程常驻，音频和识别结果都不写磁盘。 */
export class LocalSpeechRecognizer implements SpeechRecognizer {
  private child: ChildProcess | undefined
  private loading: Promise<void> | undefined
  private cancelLoading: (() => void) | undefined
  private state: ReturnType<SpeechRecognizer['status']>['state'] = 'missing'
  private error = ''
  private readonly pending = new Map<string, Pending>()
  constructor(readonly modelDir: string) {}
  status() { return { state: this.state, error: this.error } }
  start(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    if (this.loading) return this.loading
    if (this.state === 'closed') return Promise.reject(new Error('语音识别已关闭'))
    if (!hasSpeechModelFiles(this.modelDir)) {
      this.state = 'missing'; this.error = '识别模型未安装，请先运行 pnpm speech:install'
      return Promise.reject(new Error(this.error))
    }
    this.state = 'loading'; this.error = ''
    this.loading = new Promise<void>((resolve, reject) => {
      const child = fork(new URL('./worker.mjs', import.meta.url), [this.modelDir], { serialization: 'advanced', execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      this.child = child
      // 原生库的诊断只保留少量尾部，避免把大型内部日志推给界面。
      let diagnostic = '', initialized = false
      child.stderr?.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-1200) })
      const failed = (message: string) => {
        if (this.child !== child) return
        clearTimeout(timer); this.child = undefined; this.state = 'error'; this.error = message
        this.cancelLoading = undefined
        child.kill(); reject(new Error(message))
        for (const pending of this.pending.values()) pending.reject(new Error(message))
        this.pending.clear()
      }
      const timer = setTimeout(() => failed('本地识别器加载超时，请在设置中重新加载'), 30_000); timer.unref()
      this.cancelLoading = () => { clearTimeout(timer); reject(new Error('语音识别已关闭')) }
      child.on('error', error => failed(`本地识别器启动失败：${error.message}`))
      child.on('exit', () => failed(`本地识别器退出，请重新加载${diagnostic ? `：${diagnostic.split('\n').filter(Boolean).at(-1)?.slice(0, 180)}` : ''}`))
      child.on('message', (message: any) => {
        if (this.child !== child) return
        if (message.type === 'ready') { initialized = true; clearTimeout(timer); this.cancelLoading = undefined; this.state = 'ready'; resolve(); return }
        if (message.type === 'fatal') { failed(String(message.error)); return }
        if (!initialized || typeof message.id !== 'string') return
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(String(message.error)))
        else pending.resolve({ text: String(message.text ?? '').replace(/<\|[^|]*\|>/g, '').trim(), recognitionMs: Number(message.recognitionMs) || 0 })
      })
    }).finally(() => { this.loading = undefined })
    return this.loading
  }
  async transcribe(samples: Float32Array, signal: AbortSignal) {
    signal.throwIfAborted(); await this.start(); signal.throwIfAborted()
    if (this.pending.size >= 4) throw new Error('正在识别多条语音，请稍后重试')
    return new Promise<{ text: string; recognitionMs: number }>((resolve, reject) => {
      const id = randomUUID(), child = this.child!
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
      const abort = () => { this.pending.delete(id); cleanup(); reject(new Error('已取消语音识别')) }
      const timer = setTimeout(() => {
        this.pending.delete(id); cleanup(); reject(new Error('本地语音识别超时，请重新加载识别器'))
        if (this.child === child) child.kill()
      }, 45_000); timer.unref()
      this.pending.set(id, { resolve: value => { cleanup(); resolve(value) }, reject: error => { cleanup(); reject(error) } })
      signal.addEventListener('abort', abort, { once: true })
      child.send({ id, samples }, error => { if (error) { const pending = this.pending.get(id); this.pending.delete(id); pending?.reject(error) } })
    })
  }
  close(): void {
    if (this.state === 'closed') return
    const child = this.child
    this.cancelLoading?.(); this.cancelLoading = undefined
    this.state = 'closed'; this.error = ''; this.child = undefined
    for (const pending of this.pending.values()) pending.reject(new Error('语音识别已关闭'))
    this.pending.clear(); child?.kill()
  }
}
