import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { decodeSpeechWave, LocalSpeechRecognizer, type SpeechRecognizer } from '../packages/speech/src/index.ts'
import { encodeSpeechWave } from '../apps/companion/ui/speech-audio.ts'
import { VoiceCommands } from '../apps/companion/src/voice-commands.ts'
import { SpeechSettings } from '../apps/companion/src/speech-settings.ts'
import { CommandLog } from '../apps/companion/src/command-log.ts'
import { WorkbenchApi } from '../apps/companion/src/workbench-api.ts'
import { applyCommandEvent } from '../apps/companion/ui/command-card.ts'
import { TranscriptQueue } from '../apps/companion/src/transcript-queue.ts'

const wave = (rate = 16000) => Buffer.from(encodeSpeechWave([Float32Array.from({ length: rate / 2 }, (_, i) => Math.sin(i / 10) * 0.1)], rate))
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function recognizer() {
  const waiting: Array<(text: string) => void> = []
  const engine: SpeechRecognizer = { status: () => ({ state: 'ready', error: '' }), start: async () => {}, close: () => {},
    transcribe: async () => new Promise(resolve => { waiting.push(text => resolve({ text, recognitionMs: 20 })) }) }
  return { engine, waiting }
}

test('录音转换和校验保留时长，拒绝静音、错误格式和过长音频；没有模型时明确提示', async () => {
  assert.equal(decodeSpeechWave(wave()).durationMs, 500)
  assert.equal(decodeSpeechWave(wave(48000)).durationMs, 500)
  assert.throws(() => decodeSpeechWave(Buffer.from(encodeSpeechWave([new Float32Array(8000)], 16000))), /没有收到声音/)
  assert.throws(() => decodeSpeechWave(wave().subarray(0, 40)), /格式无效/)
  const wrong = wave(); wrong.writeUInt32LE(44100, 24)
  assert.throws(() => decodeSpeechWave(wrong), /16kHz/)
  assert.throws(() => decodeSpeechWave(Buffer.alloc(1_000_000)), /格式无效/)
  const engine = new LocalSpeechRecognizer('/ra2c-missing-test-model')
  try { await assert.rejects(engine.start(), /speech:install/); assert.equal(engine.status().state, 'missing') } finally { engine.close() }
})

test('语音从录音开始复用一个 ID，只把最终转写提交一次；取消、换局、退出使迟到结果失效', async () => {
  const log = new CommandLog(), asr = recognizer(), submitted: Array<{ text: string; id: string; source: string }> = []
  let session = 'game-a'
  const queue = new TranscriptQueue()
  const voice = new VoiceCommands({ log, sessionKey: () => session, recognizer: () => asr.engine,
    reserve: () => { const turn = queue.register(session); return { signal: turn.signal, finish: () => turn.finish() } },
    submit: async (text, id, source) => { submitted.push({ text, id, source }) } })
  try {
    voice.start('normal'); voice.audio('normal', wave())
    assert.equal(log.since(0).filter(event => event.commandId === 'normal').at(-1)!.stage, 'transcribing')
    assert.throws(() => voice.audio('normal', wave()), /不会重复执行/)
    asr.waiting.shift()!('5辆灰熊坦克编入1队'); await turn()
    assert.deepEqual(submitted, [{ text: '5辆灰熊坦克编入1队', id: 'normal', source: 'voice' }])
    const events = log.since(0).filter(event => event.commandId === 'normal')
    assert.deepEqual(events.map(event => event.stage), ['recording', 'transcribing', 'received'])
    assert.equal(events.at(-1)!.speech!.recognitionMs, 20)
    let card = applyCommandEvent(events[0]!); const started = card.at
    card = applyCommandEvent({ ...events.at(-1)!, at: started + 5000 }, card)
    assert.equal(card.at, started, '同一语音卡片保持录音开始时间')
    voice.cancel('normal'); assert.equal(log.since(0).at(-1)!.stage, 'received', '已交接命令不被录音取消误伤')
    voice.cancel('cancel-first'); assert.throws(() => voice.start('cancel-first'), /取消/)
    voice.start('cancelled'); voice.audio('cancelled', wave()); voice.cancel('cancelled')
    asr.waiting.shift()!('摧毁全部敌人'); await turn()
    voice.start('changed'); voice.audio('changed', wave()); session = 'game-b'
    asr.waiting.shift()!('进攻三楼右下'); await turn()
    assert.equal(log.since(0).at(-1)!.stage, 'cancelled')
    voice.start('stopped'); voice.audio('stopped', wave())
    queue.interrupt(() => true, '停止全部', undefined, true)
    asr.waiting.shift()!('所有坦克进攻敌方基地'); await turn()
    assert.equal(submitted.length, 1, '识别中的语音也受现有优先停止规则约束，迟到转写不能恢复攻击')
    voice.start('closed'); voice.audio('closed', wave()); voice.close()
    asr.waiting.shift()!('展开基地'); await turn()
    assert.equal(submitted.length, 1)
  } finally { voice.close() }
})

test('语音配置独立保存，修订冲突与非法按键不覆盖文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-speech-settings-')), speech = new SpeechSettings(root, {})
  try {
    const view = speech.view()
    speech.save({ ...view, key: 'F8', deviceId: 'fixture-microphone' })
    const path = join(root, '.runtime/speech/settings.json'), bytes = readFileSync(path, 'utf8')
    assert.equal(JSON.parse(bytes).version, 2)
    assert.equal(Object.hasOwn(JSON.parse(bytes), 'modelDir'), false, '语音偏好不保存模型路径')
    assert.throws(() => speech.save(view), /已更新/)
    assert.throws(() => speech.save({ ...speech.view(), key: 'Enter' as never }), /格式错误/)
    assert.equal(readFileSync(path, 'utf8'), bytes)
    const restored = new SpeechSettings(root, {})
    try { assert.equal(restored.view().key, 'F8'); assert.equal(restored.view().deviceId, 'fixture-microphone') } finally { restored.close() }
    const original = JSON.parse(bytes)
    writeFileSync(path, JSON.stringify({ ...original, version: 1, modelDir: '/old-ui-model-path' }))
    const legacy = new SpeechSettings(root, { RA2C_SPEECH_MODEL_DIR: '/developer-model' })
    try {
      assert.equal(legacy.view().key, 'F8'); assert.equal(legacy.view().deviceId, 'fixture-microphone')
      assert.equal(legacy.view().modelDir, '/developer-model', '旧页面路径不覆盖开发者环境变量')
      legacy.save(legacy.view()); assert.equal(Object.hasOwn(JSON.parse(readFileSync(path, 'utf8')), 'modelDir'), false)
    } finally { legacy.close() }
  } finally { speech.close(); rmSync(root, { recursive: true, force: true }) }
})

class Response extends EventEmitter {
  status = 0; destroyed = false; writableEnded = false; body = ''
  writeHead(status: number) { this.status = status }
  end(body = '') { this.body = body; this.writableEnded = true }
}
const request = (path: string, body?: Buffer | string, origin?: string) => Object.assign(Readable.from(body === undefined ? [] : [body]),
  { url: path, method: body === undefined ? 'GET' : 'POST', headers: { host: '127.0.0.1:8787', ...(origin ? { origin } : {}) } }) as IncomingMessage

test('语音接口与文本共用提交，录音失败不下令，不跨源接收且退出取消识别', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-voice-api-')), speech = new SpeechSettings(root, {}), asr = recognizer(), log = new CommandLog()
  speech.recognizer = asr.engine
  const submitted: string[] = [], api = new WorkbenchApi({ speech, log, ready: () => true, status: async () => 'ready',
    submit: async (text, id, source) => { submitted.push(`${source}:${id}:${text}`) } })
  const call = async (path: string, body?: Buffer | string, origin?: string) => { const response = new Response(); await api.handle(request(path, body, origin), response as never); return response }
  const id = 'cmd-12345678'
  try {
    assert.equal((await call(`/commander/voice/${id}/start`, '{}', 'https://outside.example')).status, 403)
    assert.equal((await call(`/commander/voice/${id}/start`, '{}')).status, 202)
    assert.equal((await call(`/commander/voice/${id}/audio`, wave())).status, 202)
    asr.waiting.shift()!('展开基地'); await turn()
    assert.deepEqual(submitted, [`voice:${id}:展开基地`])
    assert.equal((await call(`/commander/voice/${id}/audio`, wave())).status, 400)
    const failed = 'cmd-12345679'
    await call(`/commander/voice/${failed}/start`, '{}'); assert.equal((await call(`/commander/voice/${failed}/audio`, Buffer.alloc(44))).status, 400)
    assert.equal(log.since(0).filter(event => event.commandId === failed).at(-1)!.stage, 'failed')
    assert.equal((await call('/commander/say', JSON.stringify({ commandId: 'cmd-12345670', text: '造电厂' }))).status, 202)
    await turn(); assert.equal(submitted.length, 2)
    await call('/commander/voice/cmd-12345671/start', '{}'); await call('/commander/voice/cmd-12345671/audio', wave())
    api.close(); asr.waiting.shift()!('摧毁全部敌人'); await turn()
    assert.equal(submitted.length, 2)
  } finally { api.close(); rmSync(root, { recursive: true, force: true }) }
})
