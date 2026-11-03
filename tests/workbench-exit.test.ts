import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WorkbenchApi } from '../apps/companion/src/workbench-api.ts'
import { CommandLog } from '../apps/companion/src/command-log.ts'

test('退出只接受当前工作台 POST，响应发送后执行一次关闭，不要求已进入对局', async () => {
  const events: string[] = []
  const api = new WorkbenchApi({ log: new CommandLog(), ready: () => false, status: async () => 'loading', submit: async () => {}, quit: () => { events.push('quit') } })
  const server = createServer((req, res) => {
    res.once('finish', () => { if (res.statusCode === 202) events.push('response') })
    void api.handle(req, res)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, url = `${origin}/commander/quit`
  try {
    assert.equal((await fetch(url)).status, 405)
    assert.equal((await fetch(url, { method: 'POST', headers: { origin: 'https://outside.invalid' } })).status, 403)
    assert.deepEqual(events, [])
    const response = await fetch(url, { method: 'POST', headers: { origin } })
    assert.equal(response.status, 202); assert.deepEqual(await response.json(), { ok: true })
    assert.deepEqual(events, ['response', 'quit'])
    assert.equal((await fetch(url, { method: 'POST', headers: { origin } })).status, 503)
    assert.deepEqual(events, ['response', 'quit'])
  } finally {
    api.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
