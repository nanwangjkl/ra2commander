import { createRequire } from 'node:module'
import { join } from 'node:path'

process.on('disconnect', () => process.exit())
try {
  const require = createRequire(import.meta.url), sherpa = require('sherpa-onnx-node'), manifest = require('../model-manifest.json'), folder = process.argv[2]
  const file = role => join(folder, manifest.files.find(file => file.role === role).path)
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: manifest.runtime.sampleRate, featureDim: 80 },
    modelConfig: { senseVoice: { model: file('model'), language: manifest.runtime.language, useInverseTextNormalization: 1 },
      tokens: file('tokens'), numThreads: 2, provider: 'cpu', debug: 0 },
  })
  process.on('message', message => {
    const start = performance.now()
    try {
      const stream = recognizer.createStream()
      stream.acceptWaveform({ sampleRate: manifest.runtime.sampleRate, samples: message.samples })
      recognizer.decode(stream)
      process.send?.({ id: message.id, text: recognizer.getResult(stream).text, recognitionMs: Math.round(performance.now() - start) })
    } catch (error) { process.send?.({ id: message.id, error: String(error) }) }
  })
  process.send?.({ type: 'ready' })
} catch (error) { process.send?.({ type: 'fatal', error: `本地识别器加载失败：${String(error)}` }); process.exitCode = 1 }
