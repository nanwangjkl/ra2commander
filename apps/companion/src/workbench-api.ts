import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { CommandLog, newCommandId } from './command-log.ts'
import type { BattleRecords } from './battle-records.ts'
import type { FeedbackRating, ModelSettingsInput } from '@ra2c/contracts'
import type { ModelSettings } from './model-settings.ts'
import type { BattleDownloads } from './battle-downloads.ts'
import type { SpeechSettings } from './speech-settings.ts'
import { VoiceCommands } from './voice-commands.ts'
import type { SpeechSettingsInput } from '@ra2c/contracts'

interface ApiOptions {
  log: CommandLog
  ready: () => boolean
  submit: (text: string, commandId: string, source: 'sidebar' | 'voice') => Promise<unknown>
  status: () => Promise<string>
  records?: BattleRecords
  models?: ModelSettings
  downloads?: BattleDownloads
  speech?: SpeechSettings
  reserveVoice?: (id: string) => { signal: AbortSignal; finish: () => void }
}

/** 工作台接口及其长连接的生命周期；退出时不能让 SSE 心跳残留进程。 */
export class WorkbenchApi {
  private readonly clients = new Set<() => void>()
  private closing = false
  private readonly voice?: VoiceCommands
  constructor(private readonly options: ApiOptions) {
    if (options.speech) this.voice = new VoiceCommands({ log: options.log, sessionKey: () => options.records?.currentCommands().sessionKey ?? null,
      recognizer: () => options.speech!.recognizer, submit: options.submit, reserve: options.reserveVoice })
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? '/', 'https://127.0.0.1').pathname
    if (!['/commander/say', '/commander/events', '/commander/status', '/commander/commands', '/commander/feedback', '/commander/records', '/commander/history', '/commander/settings', '/commander/settings/test', '/commander/speech', '/commander/speech/reload'].includes(path) && !path.startsWith('/commander/records/') && !path.startsWith('/commander/exports/') && !path.startsWith('/commander/voice/')) return false
    const json = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }
    if (this.closing) { json(503, { error: '伴随程序正在退出' }); return true }
    if (req.method === 'POST' && req.headers.origin) {
      try { if (req.headers.origin === 'null' || new URL(req.headers.origin).host !== req.headers.host) throw new Error('origin') }
      catch { json(403, { error: '请从当前工作台提交' }); return true }
    }
    if (path === '/commander/speech' || path === '/commander/speech/reload') {
      const speech = this.options.speech
      if (!speech) { json(503, { error: '语音模块尚未就绪' }); return true }
      if (req.method === 'GET' && path === '/commander/speech') { json(200, speech.view()); return true }
      if (req.method !== 'POST') { json(405, { error: '请使用 POST' }); return true }
      try {
        if (path.endsWith('/reload')) { this.voice?.cancelAll('识别器重新加载，已取消未提交语音'); speech.reload(); json(200, speech.view()) }
        else { const input = await readJson(req) as SpeechSettingsInput; const view = speech.save(input); this.voice?.cancelAll('语音设置已更新，已取消未提交语音'); json(200, view) }
      } catch (error) { json(400, { error: String(error) }) }
      return true
    }
    if (path.startsWith('/commander/voice/')) {
      if (req.method !== 'POST') { json(405, { error: '请使用 POST' }); return true }
      const match = /^\/commander\/voice\/(cmd-[a-f0-9-]{8,36})\/(start|audio|cancel)$/.exec(path), voice = this.voice
      if (!match || !voice) { json(404, { error: '语音入口不可用' }); return true }
      try {
        const [, id, action] = match
        if (action === 'cancel') {
          const input = await readJson(req) as { reason?: unknown }
          voice.cancel(id!, typeof input?.reason === 'string' ? input.reason : undefined)
        } else {
          if (!this.options.ready()) throw new Error('伴随程序尚未就绪')
          if (action === 'start') voice.start(id!)
          else {
            const chunks: Buffer[] = []; let bytes = 0
            try {
              for await (const chunk of req) {
                bytes += Buffer.byteLength(chunk)
                if (bytes > 960_128) throw new Error('录音过长，请分句下令')
                chunks.push(Buffer.from(chunk))
              }
              voice.audio(id!, Buffer.concat(chunks))
            } catch (error) { voice.cancel(id!, '录音上传失败，已取消'); throw error }
          }
        }
        json(202, { commandId: id })
      } catch (error) { json(400, { error: String(error) }) }
      return true
    }
    if (path === '/commander/settings' || path === '/commander/settings/test') {
      const models = this.options.models
      if (!models) { json(503, { error: '模型设置尚未就绪' }); return true }
      if (req.method === 'GET' && path === '/commander/settings') { json(200, models.view()); return true }
      if (req.method !== 'POST') { json(405, { error: '请使用 POST' }); return true }
      const lifetime = new AbortController(), close = () => lifetime.abort()
      res.once('close', close); this.clients.add(close)
      try {
        const input = await readJson(req) as ModelSettingsInput
        if (path.endsWith('/test')) {
          await models.test(input, AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]))
          if (!lifetime.signal.aborted) json(200, { ok: true })
        } else json(200, models.save(input))
      }
      catch (error) { if (!res.destroyed) json(400, { error: models.sanitize(error) }) }
      finally { this.clients.delete(close); res.off('close', close) }
      return true
    }
    if (path === '/commander/history') {
      if (req.method !== 'GET') { json(405, { error: '请使用 GET' }); return true }
      if (!this.options.records) { json(503, { error: '对局记录尚未就绪' }); return true }
      const active = await this.options.status().then(status => status === 'ready', () => true)
      json(200, { records: this.options.records.history(active), warning: this.options.records.warning }); return true
    }
    const exportRequest = /^\/commander\/records\/(battle-[a-f0-9]{24})\/export$/.exec(path)
    if (exportRequest) {
      if (req.method !== 'POST') { json(405, { error: '请使用 POST' }); return true }
      try {
        const records = this.options.records, active = await this.options.status().then(status => status === 'ready', () => true)
        if (!records || !this.options.downloads) throw new Error('调试包服务尚未就绪')
        if (active && records.currentId === exportRequest[1] && !records.list().find(record => record.id === exportRequest[1])?.result) throw new Error('当前对局仍在进行，请结束或退出对局后下载')
        records.flush()
        json(202, this.options.downloads.start(exportRequest[1]!))
      } catch (error) { json(400, { error: String(error) }) }
      return true
    }
    if (path.startsWith('/commander/exports/')) {
      if (req.method !== 'GET') { json(405, { error: '请使用 GET' }); return true }
      const match = /^\/commander\/exports\/([a-f0-9-]{36})(\/download)?$/.exec(path)
      const downloads = this.options.downloads, job = match && downloads?.status(match[1]!)
      if (!match || !job || !downloads) { json(404, { error: '找不到调试包，请重新下载' }); return true }
      if (!match[2]) { json(200, job); return true }
      let release = () => {}
      const cancel = () => res.destroy()
      try {
        const file = downloads.acquire(match[1]!)
        release = file.release
        this.clients.add(cancel)
        res.writeHead(200, { 'content-type': 'application/zip', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="${file.filename}"` })
        await pipeline(createReadStream(file.path), res)
      } catch (error) { if (!res.headersSent) json(400, { error: String(error) }); else res.destroy() }
      finally { this.clients.delete(cancel); release() }
      return true
    }
    if (path === '/commander/feedback') {
      if (req.method !== 'POST') { json(405, { error: '请使用 POST' }); return true }
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk)
        if (bytes > 32_768) { json(413, { error: '反馈过长' }); return true }
        chunks.push(Buffer.from(chunk))
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { battleId: string; commandId: string; rating: FeedbackRating; note: string }
        if (!value || typeof value.battleId !== 'string' || typeof value.commandId !== 'string' || typeof value.rating !== 'string' || typeof value.note !== 'string') throw new Error('反馈格式错误')
        if (!this.options.records) throw new Error('对局记录尚未就绪')
        json(200, { feedback: this.options.records.feedback(value.battleId, value.commandId, value.rating, value.note) })
      } catch (error) { json(400, { error: String(error) }) }
      return true
    }
    if (path === '/commander/records' || path.startsWith('/commander/records/')) {
      if (req.method !== 'GET') { json(405, { error: '请使用 GET' }); return true }
      const records = this.options.records
      if (!records) { json(503, { error: '对局记录尚未就绪' }); return true }
      try {
        if (path === '/commander/records') { json(200, { currentId: records.currentId, records: records.list(), warning: records.warning }); return true }
        const match = /^\/commander\/records\/(battle-[a-f0-9]{24})(?:\/(summary\.md|record\.json))?$/.exec(path)
        if (match?.[2] === 'summary.md') {
          const summary = records.summary(match[1]!, true)
          if (!summary) { json(404, { error: '找不到对局记录' }); return true }
          res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="${match[1]!}.md"` })
          res.end(summary)
          return true
        }
        const record = match && records.read(match[1]!)
        if (!record) { json(404, { error: '找不到对局记录' }); return true }
        if (match![2] === 'record.json') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="${record.id}.json"` })
          res.end(JSON.stringify(record, null, 2))
        } else json(200, record)
      } catch (error) { json(500, { error: `读取对局记录失败：${String(error)}` }) }
      return true
    }
    if (path === '/commander/say') {
      if (req.method !== 'POST') { json(405, { error: '请使用 POST' }); return true }
      if (!this.options.ready()) { json(503, { error: '伴随程序尚未就绪' }); return true }
      if (req.headers.origin && req.headers.origin !== 'null' && new URL(req.headers.origin).host !== req.headers.host) { json(403, { error: '命令须从当前工作台提交' }); return true }
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk)
        if (bytes > 65_536) { json(413, { error: '命令文本过长' }); return true }
        chunks.push(Buffer.from(chunk))
      }
      let parsed: { text?: unknown; commandId?: unknown } | null
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof parsed } catch { json(400, { error: '命令格式错误' }); return true }
      if (!parsed || typeof parsed.text !== 'string' || !parsed.text.trim()) { json(400, { error: '缺少命令文本' }); return true }
      if (parsed.commandId !== undefined && (typeof parsed.commandId !== 'string' || !/^cmd-[a-f0-9-]{8,36}$/.test(parsed.commandId))) { json(400, { error: '命令 ID 无效' }); return true }
      const commandId = typeof parsed.commandId === 'string' ? parsed.commandId : newCommandId()
      if (this.options.log.since(0).some(event => event.commandId === commandId)) { json(409, { error: '该命令已经提交' }); return true }
      this.options.log.emit({ commandId, text: parsed.text, source: 'sidebar', stage: 'received' })
      json(202, { commandId })
      const text = parsed.text
      void Promise.resolve().then(() => this.options.submit(text, commandId, 'sidebar')).catch(error => {
        const last = this.options.log.since(0).filter(event => event.commandId === commandId).at(-1)
        if (!last || !['failed', 'cancelled'].includes(last.stage)) this.options.log.emit({ commandId, source: 'sidebar', stage: 'failed', error: String(error) })
      })
      return true
    }
    if (req.method !== 'GET') { json(405, { error: '请使用 GET' }); return true }
    if (path === '/commander/status') {
      try { json(200, { game: await this.options.status() }) }
      catch (error) { json(503, { error: `游戏连接暂时不可用：${String(error)}` }) }
      return true
    }
    if (path === '/commander/commands') {
      try { json(200, this.options.records?.currentCommands() ?? { battleId: null, sessionKey: null, events: this.options.log.since(0), feedback: [], warning: '' }) }
      catch (error) { json(500, { error: `读取当前命令失败：${String(error)}` }) }
      return true
    }

    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.flushHeaders()
    const { log } = this.options
    const [stream, cursor] = String(req.headers['last-event-id'] ?? '').split(':')
    const seq = stream === log.streamId && Number.isSafeInteger(Number(cursor)) && Number(cursor) >= 0 ? Number(cursor) : 0
    const write = (value: string) => { if (!res.destroyed && !res.writableEnded) res.write(value) }
    const send = (event: ReturnType<CommandLog['emit']>) => write(`id: ${log.streamId}:${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
    for (const event of log.since(seq)) send(event)
    const unsubscribe = log.subscribe(send)
    const heartbeat = setInterval(() => write(': ping\n\n'), 25_000)
    heartbeat.unref()
    const close = () => { clearInterval(heartbeat); unsubscribe(); this.clients.delete(close); if (!res.writableEnded) res.end() }
    this.clients.add(close)
    res.once('close', close)
    return true
  }

  close(): void {
    this.closing = true
    this.voice?.close()
    this.options.speech?.close()
    for (const close of this.clients) close()
    this.options.downloads?.close()
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk)
    if (bytes > 32_768) throw new Error('设置内容过长')
    chunks.push(Buffer.from(chunk))
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new Error('请求格式错误') }
}
