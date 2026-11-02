import { resolve } from 'node:path'
import { prepareSpeechModel } from '@ra2c/speech'

const root = resolve(import.meta.dirname, '../../..')
const result = await prepareSpeechModel(root, { progress: console.log,
  ...(process.env.RA2C_SPEECH_MODEL_DIR ? { target: process.env.RA2C_SPEECH_MODEL_DIR } : {}) })
console.log(`识别模型已就绪：${result.folder}`)
