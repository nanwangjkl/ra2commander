import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import type { IncomingMessage } from 'node:http'
import type { ModelSettingsInput } from '../packages/contracts/src/index.ts'
import { providerInfo } from '../packages/model-providers/src/index.ts'
import { ModelSettings } from '../apps/companion/src/model-settings.ts'
import { BattleRecords } from '../apps/companion/src/battle-records.ts'
import { WorkbenchApi } from '../apps/companion/src/workbench-api.ts'
import { CommandLog } from '../apps/companion/src/command-log.ts'
import { BattleDownloads } from '../apps/companion/src/battle-downloads.ts'
import { openBattleZip } from '../apps/companion/src/battle-zip.ts'

const env = { MODEL_LOCAL_API_KEY: 'fixture-env-secret', MODEL_LOCAL_BASE_URL: 'http://localhost:8080/v1', MODEL_LOCAL_MODEL: 'old-model' }
const input = (store: ModelSettings, override: Partial<ModelSettingsInput> = {}): ModelSettingsInput => ({ baseUrl: env.MODEL_LOCAL_BASE_URL, model: 'new-model', revision: store.view().revision, ...override })

test('模型设置仅保存当前一套，覆盖切换、空 Key 保留与失败回滚，兼容 env 和旧配置迁移', () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-model-settings-'))
  try {
    const settings = new ModelSettings(root, env), old = settings.current()
    assert.equal(settings.view().baseUrl, env.MODEL_LOCAL_BASE_URL)
    assert.doesNotMatch(JSON.stringify(settings.view()), /fixture-env-secret|apiKey|providers|activeProvider/)
    assert.doesNotMatch(JSON.stringify(providerInfo(old)), /fixture-env-secret/)
    settings.save(input(settings, { apiKey: 'fixture-file-secret' }))
    assert.equal(old.config.apiKey, env.MODEL_LOCAL_API_KEY, '已有实例不被热改写')
    settings.save(input(settings, { apiKey: '', model: 'kept-key' }))
    assert.equal(settings.current().config.apiKey, 'fixture-file-secret')
    assert.throws(() => settings.save(input(settings, { baseUrl: 'https://another.example/v1' })), /更换 URL/)
    assert.throws(() => settings.save(input(settings, { revision: 0 })), /配置已更新/)
    const restarted = new ModelSettings(root, env)
    assert.equal(restarted.current().model, 'kept-key')
    const path = join(root, '.runtime/settings.json')
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
    restarted.save(input(restarted, { baseUrl: 'https://fixture.example/v1', apiKey: 'fixture-other-secret', model: 'other-model' }))
    const stored = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(stored.version, 2); assert.equal(stored.configuration.model, 'other-model')
    assert.doesNotMatch(JSON.stringify(stored), /providers|activeProvider|fixture-file-secret|kept-key/)
    assert.equal(new ModelSettings(root, env).current().model, 'other-model')
    const before = restarted.view()
    rmSync(path); mkdirSync(path)
    assert.throws(() => restarted.save(input(restarted, { apiKey: 'replacement' })))
    assert.deepEqual(restarted.view(), before)
    rmSync(path, { recursive: true })
    writeFileSync(path, JSON.stringify({ version: 1, revision: 5, activeProvider: 'selected', providers: {
      selected: { baseUrl: 'https://selected.example/v1', model: 'selected-model', apiKey: 'selected-secret' },
      removed: { baseUrl: 'https://removed.example/v1', model: 'removed-model', apiKey: 'removed-secret' },
    } }))
    const migrated = new ModelSettings(root, env)
    assert.equal(migrated.current().model, 'selected-model')
    assert.doesNotMatch(readFileSync(path, 'utf8'), /removed|providers|activeProvider/)
    assert.equal(migrated.providers.size, 1)
    assert.equal(existsSync(join(root, '.env')), false, '页面配置不改写 .env')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

class Response extends EventEmitter {
  status = 0; chunks: string[] = []; destroyed = false; writableEnded = false
  writeHead(status: number) { this.status = status }
  end(value?: string) { if (value) this.chunks.push(value); this.writableEnded = true }
  json() { return JSON.parse(this.chunks.join('')) }
}
const request = (url: string, body?: unknown, origin?: string) => Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]),
  { url, method: body === undefined ? 'GET' : 'POST', headers: { host: '127.0.0.1:8787', ...(origin ? { origin } : {}) } }) as IncomingMessage

test('单配置接口无需对局可使用，保存不发模型请求，在途请求保留旧实例且认证不回显', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-settings-api-')), original = globalThis.fetch
  const settings = new ModelSettings(root, env)
  let actions = 0, calls = 0, release!: () => void
  const api = new WorkbenchApi({ models: settings, log: new CommandLog(), ready: () => false, status: async () => 'waiting', submit: async () => { actions++ } })
  try {
    globalThis.fetch = async (_url, init) => {
      calls++
      assert.equal((init!.headers as Record<string, string>).authorization, `Bearer ${env.MODEL_LOCAL_API_KEY}`)
      await new Promise<void>(resolve => { release = resolve })
      return new globalThis.Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 })
    }
    const get = new Response(); await api.handle(request('/commander/settings'), get as never)
    assert.equal(get.status, 200); assert.doesNotMatch(JSON.stringify(get.json()), /fixture-env-secret/)
    const pending = settings.current().generate({ messages: [{ role: 'user', content: 'test' }] })
    while (!release) await new Promise<void>(resolve => setImmediate(resolve))
    const saved = new Response()
    await api.handle(request('/commander/settings', input(settings, { apiKey: 'new-fixture-secret' })), saved as never)
    assert.equal(saved.status, 200); assert.equal(calls, 1, '保存不发送模型请求')
    release(); assert.equal((await pending).text, 'OK')
    assert.equal(settings.current().config.apiKey, 'new-fixture-secret')
    const file = join(root, '.runtime/settings.json'), before = readFileSync(file, 'utf8'), view = settings.view()
    globalThis.fetch = async (_url, init) => {
      assert.equal(JSON.parse(init!.body as string).model, 'unsaved-model')
      return new globalThis.Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 })
    }
    const tested = new Response(); await api.handle(request('/commander/settings/test', input(settings, { model: 'unsaved-model' })), tested as never)
    assert.equal(tested.json().ok, true)
    assert.equal(readFileSync(file, 'utf8'), before, '测试表单不保存配置')
    assert.deepEqual(settings.view(), view, '测试不切换正在使用的模型')
    globalThis.fetch = async () => new globalThis.Response('echo new-fixture-secret', { status: 401 })
    const failed = new Response(); await api.handle(request('/commander/settings/test', input(settings)), failed as never)
    assert.equal(failed.status, 400); assert.doesNotMatch(failed.json().error, /new-fixture-secret/)
    const forbidden = new Response(); await api.handle(request('/commander/settings', input(settings), 'https://outside.example'), forbidden as never)
    assert.equal(forbidden.status, 403)
    const malformed = new Response()
    await api.handle(Object.assign(Readable.from(['{"apiKey":"private-malformed']), { url: '/commander/settings', method: 'POST', headers: {} }) as IncomingMessage, malformed as never)
    assert.doesNotMatch(malformed.chunks.join(''), /private-malformed/)
    assert.equal(actions, 0)
  } finally { globalThis.fetch = original; api.close(); rmSync(root, { recursive: true, force: true }) }
})

test('最近十局仅从元数据筛选，排除未进局和当前进行中记录，不删除旧档或猜测胜负', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-history-')), records = new BattleRecords(root)
  const ids: string[] = []
  try {
    for (let n = 0; n < 13; n++) {
      const sessionKey = n ? `battle-session-${n}` : '', id = `battle-${createHash('sha256').update(sessionKey || 'unbound').digest('hex').slice(0, 24)}`
      ids.push(id); const folder = join(root, '.runtime/battles', id); mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'meta.json'), JSON.stringify({ id, sessionKey, startedAt: n, updatedAt: 100 - n, commands: 1, feedback: 0, issues: 0 }))
    }
    records.setSession('battle-session-12')
    const list = records.history(true)
    assert.deepEqual(list.map(r => r.id), ids.slice(2, 12).reverse())
    assert.ok(list.every(r => !r.result))
    assert.equal(records.history(false)[0]!.id, ids[12])
    assert.ok(ids.every(id => existsSync(join(root, '.runtime/battles', id))))
    const api = new WorkbenchApi({ records, log: new CommandLog(), ready: () => false, status: async () => 'ready', submit: async () => {} })
    const res = new Response(); await api.handle(request('/commander/history'), res as never)
    assert.equal(res.json().records.length, 10)
    const active = new Response(); await api.handle(request(`/commander/records/${ids[12]}/export`, {}), active as never)
    assert.equal(active.status, 400); api.close()
  } finally { records.close(); rmSync(root, { recursive: true, force: true }) }
})

test('历史下载接口准备并流式传输 ZIP，关闭后清理临时文件，离线数据可完整读取', { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-download-api-')), records = new BattleRecords(root), downloads = new BattleDownloads(root)
  const api = new WorkbenchApi({ records, downloads, log: new CommandLog(), ready: () => true, status: async () => 'waiting', submit: async () => {} })
  try {
    records.event({ commandId: 'cmd-fixture', sessionKey: 'fixture-battle', stage: 'received', source: 'sidebar', text: '造重工', at: 1, seq: 1 })
    records.transcript({ requestId: 'cmd-fixture', sessionKey: 'fixture-battle', text: '造重工', rawResponse: '模型响应', error: '', messages: [] })
    records.feedback(records.list()[0]!.id, 'cmd-fixture', 'partial', '实际反馈')
    const id = records.list()[0]!.id, started = new Response()
    await api.handle(request(`/commander/records/${id}/export`, {}), started as never)
    assert.equal(started.status, 202)
    const token = started.json().token
    let state = 'preparing'
    for (let n = 0; state === 'preparing' && n < 250; n++) {
      await delay(20); const poll = new Response(); await api.handle(request(`/commander/exports/${token}`), poll as never); state = poll.json().state
      assert.notEqual(state, 'failed', poll.chunks.join(''))
    }
    assert.equal(state, 'ready')
    class DownloadResponse extends Writable {
      headersSent = false; status = 0; headers: Record<string, string> = {}; chunks: Buffer[] = []
      writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; this.headersSent = true }
      _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) { this.chunks.push(Buffer.from(chunk)); callback() }
    }
    const response = new DownloadResponse()
    await api.handle(request(`/commander/exports/${token}/download`), response as never)
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-type'], 'application/zip')
    assert.match(response.headers['content-disposition']!, /attachment; filename="battle-.*\.zip"/)
    const path = join(root, 'download.zip'); writeFileSync(path, Buffer.concat(response.chunks))
    const opened = await openBattleZip(path)
    try { assert.equal(opened.records.read(opened.id)!.feedback[0]!.note, '实际反馈') } finally { opened.dispose() }
    assert.equal(downloads.status(token), undefined)
  } finally { api.close(); records.close(); rmSync(root, { recursive: true, force: true }) }
})
