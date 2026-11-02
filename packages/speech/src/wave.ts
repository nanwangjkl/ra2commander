/** 只接受浏览器采集的 16kHz 单声道 PCM16 WAV；音频只留内存。 */
export function decodeSpeechWave(bytes: Buffer): { samples: Float32Array; durationMs: number } {
  if (bytes.length < 44 || bytes.length > 960_128 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE'
    || bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error('录音格式无效，请重试')
  let format = false, audio: Buffer | undefined
  for (let p = 12; p + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', p, p + 4), length = bytes.readUInt32LE(p + 4), start = p + 8
    if (start + length > bytes.length) throw new Error('录音数据不完整')
    if (kind === 'fmt ') {
      if (format || length < 16 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1 || bytes.readUInt32LE(start + 4) !== 16000
        || bytes.readUInt32LE(start + 8) !== 32000 || bytes.readUInt16LE(start + 12) !== 2 || bytes.readUInt16LE(start + 14) !== 16) throw new Error('录音须为 16kHz 单声道 PCM16')
      format = true
    }
    if (kind === 'data') { if (audio) throw new Error('录音数据重复'); audio = bytes.subarray(start, start + length) }
    p = start + length + (length & 1)
  }
  if (!format || !audio || audio.length % 2 || audio.length < 4800 || audio.length > 960_000) throw new Error('录音须在 0.15～30 秒之间')
  const samples = new Float32Array(audio.length / 2)
  let energy = 0
  for (let i = 0; i < samples.length; i++) { const v = audio.readInt16LE(i * 2) / 32768; samples[i] = v; energy += v * v }
  if (Math.sqrt(energy / samples.length) < 0.0003) throw new Error('没有收到声音，请检查麦克风后重试')
  return { samples, durationMs: samples.length / 16 }
}
