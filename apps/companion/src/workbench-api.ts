import type { IncomingMessage, ServerResponse } from 'node:http'
import { CommandLog, newCommandId } from './command-log.ts'

interface ApiOptions {
  log: CommandLog
  ready: () => boolean
  submit: (text: string, commandId: string) => Promise<unknown>
  status: () => Promise<string>
}

/** 工作台接口及其长连接的生命周期；退出时不能让 SSE 心跳残留进程。 */
export class WorkbenchApi {
  private readonly clients = new Set<() => void>()
  private closing = false
  constructor(private readonly options: ApiOptions) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? '/', 'https://127.0.0.1').pathname
    if (!['/commander/say', '/commander/events', '/commander/status'].includes(path)) return false
    const json = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }
    if (this.closing) { json(503, { error: '伴随程序正在退出' }); return true }
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
      void Promise.resolve().then(() => this.options.submit(text, commandId)).catch(error => {
        const last = this.options.log.since(0).filter(event => event.commandId === commandId).at(-1)
        if (!last || !['failed', 'cancelled'].includes(last.stage)) this.options.log.emit({ commandId, source: 'sidebar', stage: 'failed', error: String(error) })
      })
      return true
    }
    if (req.method !== 'GET') { json(405, { error: '请使用 GET' }); return true }
    if (path === '/commander/status') { json(200, { game: await this.options.status() }); return true }

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
    for (const close of this.clients) close()
  }
}
