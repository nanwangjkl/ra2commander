import { resolve } from 'node:path'
import { resolveSpeechModelDir, verifySpeechModel } from '@ra2c/speech'

const root = resolve(import.meta.dirname, '../../..')
const result = await verifySpeechModel(resolveSpeechModelDir(root, process.env.RA2C_SPEECH_MODEL_DIR))
console.log(`语音模型校验通过：${result.id}，${result.files} 个文件，${result.bytes} 字节\n${result.folder}`)
