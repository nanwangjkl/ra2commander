export {}
declare class AudioWorkletProcessor { readonly port: MessagePort }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void

class PcmCapture extends AudioWorkletProcessor {
  private id = ''
  private buffer = new Float32Array(2048)
  private length = 0
  constructor() {
    super()
    this.port.onmessage = event => {
      const { type, id } = event.data
      if (type === 'start') { this.id = id; this.length = 0 }
      if (id !== this.id) return
      if (type === 'stop') { this.flush(); this.id = ''; this.port.postMessage({ type: 'stopped', id }) }
      if (type === 'cancel') { this.id = ''; this.length = 0 }
    }
  }
  private flush() {
    if (!this.length) return
    const samples = this.buffer.slice(0, this.length)
    let energy = 0
    for (const value of samples) energy += value * value
    this.port.postMessage({ type: 'samples', id: this.id, rms: Math.sqrt(energy / samples.length), ...(this.id ? { samples } : {}) }, this.id ? [samples.buffer] : [])
    this.length = 0
  }
  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0]
    if (!input) return true
    for (const value of input) { this.buffer[this.length++] = value; if (this.length === this.buffer.length) this.flush() }
    return true
  }
}
registerProcessor('ra2c-pcm-capture', PcmCapture)
