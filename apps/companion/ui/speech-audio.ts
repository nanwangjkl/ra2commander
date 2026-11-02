/** 编码到固定 PCM16；浏览器未采用请求采样率时在内存中重采样。 */
export function encodeSpeechWave(chunks: Float32Array[], sampleRate: number): ArrayBuffer {
  const count = chunks.reduce((n, chunk) => n + chunk.length, 0), source = new Float32Array(count)
  let offset = 0
  for (const chunk of chunks) { source.set(chunk, offset); offset += chunk.length }
  const length = Math.floor(count * 16000 / sampleRate), bytes = new ArrayBuffer(44 + length * 2), view = new DataView(bytes)
  const ascii = (at: number, text: string) => [...text].forEach((letter, i) => view.setUint8(at + i, letter.charCodeAt(0)))
  ascii(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt '); view.setUint32(16, 16, true)
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, length * 2, true)
  for (let i = 0; i < length; i++) {
    const position = i * sampleRate / 16000, at = Math.floor(position), fraction = position - at
    const value = Math.max(-1, Math.min(1, (source[at] ?? 0) * (1 - fraction) + (source[Math.min(count - 1, at + 1)] ?? 0) * fraction))
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
  }
  return bytes
}

/** 采集归当前 UI 生命周期所有；关闭或迟到授权都释放设备，取消不输出录音。 */
export class MicrophoneCapture {
  private context: AudioContext | undefined
  private stream: MediaStream | undefined
  private node: AudioWorkletNode | undefined
  private id = ''
  private chunks: Float32Array[] = []
  private frames = 0
  private closed = false
  private finished: (() => void) | undefined
  private rejected: ((error: Error) => void) | undefined
  constructor(private readonly level: (rms: number) => void, private readonly disconnected: () => void) {}
  async enable(deviceId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const cancelled = () => this.close()
    signal.addEventListener('abort', cancelled, { once: true })
    const context = this.context = new AudioContext({ sampleRate: 16000 })
    const resumed = context.resume().catch(error => { if (!this.closed) throw error })
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, video: false })
      if (this.closed || signal.aborted) { stream.getTracks().forEach(track => track.stop()); throw new Error('已取消麦克风授权') }
      this.stream = stream
      await resumed; await context.audioWorklet.addModule(new URL('./pcm-capture-worklet.js', import.meta.url))
      if (this.closed || signal.aborted) throw new Error('已取消麦克风授权')
      const node = this.node = new AudioWorkletNode(context, 'ra2c-pcm-capture', { channelCount: 1, channelCountMode: 'explicit' })
      node.onprocessorerror = () => { if (!this.closed) this.disconnected() }
      node.port.onmessage = event => {
        if (this.closed) return
        const data = event.data
        if (data.type === 'samples') {
          this.level(Number(data.rms) || 0)
          if (data.id && data.id === this.id && data.samples instanceof Float32Array && this.frames <= context.sampleRate * 30) {
            this.chunks.push(data.samples); this.frames += data.samples.length
          }
        }
        if (data.type === 'stopped' && data.id === this.id) this.finished?.()
      }
      context.createMediaStreamSource(stream).connect(node)
      // Worklet 输出保持静音，仅确保音频图持续处理，麦克风不回放。
      node.connect(context.destination)
      for (const track of stream.getAudioTracks()) track.onended = () => { if (!this.closed) this.disconnected() }
    } catch (error) { this.close(); throw error }
    finally { signal.removeEventListener('abort', cancelled) }
  }
  async start(id: string, signal: AbortSignal): Promise<void> {
    if (this.closed || !this.node || !this.context) throw new Error('请先启用麦克风')
    signal.throwIfAborted()
    await this.context.resume()
    signal.throwIfAborted()
    if (this.closed) throw new Error('麦克风已关闭')
    this.id = id; this.chunks = []; this.frames = 0
    this.node.port.postMessage({ type: 'start', id })
  }
  stop(): Promise<ArrayBuffer> {
    if (this.closed || !this.id || !this.node) return Promise.reject(new Error('录音已取消'))
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.finished = this.rejected = undefined; this.id = ''; this.chunks = []; this.frames = 0 }
      const timer = setTimeout(() => { cleanup(); reject(new Error('录音设备没有回应，请重新启用麦克风')) }, 1500)
      this.finished = () => { const bytes = encodeSpeechWave(this.chunks, this.context!.sampleRate); cleanup(); resolve(bytes) }
      this.rejected = error => { cleanup(); reject(error) }
      this.node!.port.postMessage({ type: 'stop', id: this.id })
    })
  }
  cancel(): void {
    this.node?.port.postMessage({ type: 'cancel', id: this.id })
    this.rejected?.(new Error('录音已取消')); this.id = ''; this.chunks = []; this.frames = 0
  }
  close(): void {
    if (this.closed) return
    this.closed = true; this.cancel()
    for (const track of this.stream?.getTracks() ?? []) { track.onended = null; track.stop() }
    if (this.node) { this.node.onprocessorerror = null; this.node.port.onmessage = null; this.node.port.close(); this.node.disconnect() }
    if (this.context) void this.context.close().catch(() => {})
  }
}
