import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { WerhdBridge } from '../packages/game-werhd/src/page-bridge.ts'
import { snapshot } from './helpers.ts'

function pageBridge() {
  let poll!: () => void
  let onTick!: (context: { tick: number }) => void
  let tick = 15
  const submitted: unknown[] = []
  const snapshots: Array<ReturnType<typeof snapshot>> = []
  const own = snapshot().self.map(u => ({ ...u, tile: { rx: u.rx, ry: u.ry } }))
  const enemy = snapshot().enemies.map(u => ({ ...u, tile: { rx: u.rx, ry: u.ry } }))
  const api = {
    onTick: (cb: typeof onTick) => { onTick = cb }, tick: () => tick, time: () => tick,
    units: (relation: string) => relation === 'self' ? own : enemy,
    me: () => ({ credits: 1000 }), map: { size: () => ({ width: 100, height: 100 }) },
    move: (...args: unknown[]) => { submitted.push(args) }, attack: (...args: unknown[]) => { submitted.push(args) },
    produce: (...args: unknown[]) => { submitted.push(args) },
    stop: (...args: unknown[]) => { submitted.push(args) }, inRange: () => true,
  }
  const window: Record<string, any> = { werhd: api, __ra2cSnapshot: (s: ReturnType<typeof snapshot>) => snapshots.push(s) }
  runInNewContext(readFileSync(new URL('../packages/game-werhd/src/bridge.js', import.meta.url), 'utf8'), {
    window, crypto: { randomUUID }, performance, setInterval: (fn: () => void) => { poll = fn; return 1 }, clearInterval: () => {},
  })
  poll()
  const sample = () => { onTick({ tick }); return snapshots.at(-1)! }
  const next = () => { tick += 15; return sample() }
  return { window, api, submitted, sample, next, poll, own, enemy, setTick: (value: number) => { tick = value } }
}

test('页面桥可以提交正常动作，并丢弃过期、跨局或目标已消失的动作', () => {
  const page = pageBridge()
  const first = page.sample()
  const action = { kind: 'move', unitIds: [1], x: 6, y: 6 }
  assert.equal(page.window.__ra2cSubmit(first.session, action, first.seq, first.sessionKey).ok, true)
  const second = page.next()
  assert.equal(page.window.__ra2cSubmit(first.session, action, first.seq, first.sessionKey).ok, false)
  assert.equal(page.window.__ra2cSubmit(first.session, { kind: 'stop', unitIds: [1] }, first.seq, first.sessionKey).ok, true)
  page.enemy.length = 0
  assert.equal(page.window.__ra2cSubmit(second.session, { kind: 'attack', unitIds: [1], targetId: 99 }, second.seq, second.sessionKey).ok, false)
  page.window.werhd = { ...page.api }
  assert.equal(page.window.__ra2cSubmit(second.session, action, second.seq, second.sessionKey).ok, false)
  page.poll()
  assert.equal(page.window.__ra2cSubmit(second.session, action, second.seq, second.sessionKey).ok, false)
  assert.equal(page.submitted.length, 2)
})

test('换局后重新采样，兼容游戏 API 对象被复用', () => {
  for (const replaceApi of [true, false]) {
    const page = pageBridge()
    const old = page.sample()
    page.next()
    page.setTick(1)
    if (replaceApi) page.window.werhd = { ...page.api }
    assert.equal(page.window.__ra2cSubmit(old.session, { kind: 'stop', unitIds: [1] }, old.seq, old.sessionKey).ok, false)
    // API 被复用时，由新一局的 tick 回调通知时钟归零，再由轮询重新挂接。
    if (!replaceApi) page.sample()
    page.poll()
    const current = page.sample()
    assert.notEqual(current.sessionKey, old.sessionKey)
    assert.equal(current.tick, 1)
  }
})
test('宿主桥保留动作来源对局，不查询当前会话替换它；撤权后不排入 evaluate', async () => {
  const calls: unknown[] = []
  const page = { evaluate: async (_fn: unknown, args: unknown) => { calls.push(args); return { ok: true } } }
  const bridge = new WerhdBridge({ pages: () => [{ mainFrame: () => page }] } as never)
  const context = snapshot()
  await bridge.submit({ kind: 'stop', unitIds: [1] }, context)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], [context, { kind: 'stop', unitIds: [1] }])
  await bridge.submit({ kind: 'stop', unitIds: [1] }, context, () => false)
  assert.equal(calls.length, 1)
})

test('工作台中的查询和动作指向已绑定游戏 frame，忽略外层与其他游戏的快照', async () => {
  const url = 'https://127.0.0.1:8787/'
  const calls: Array<{ frame: string; args: unknown }> = []
  const frame = (name: string, address: string) => ({ name: () => name, url: () => address, isDetached: () => false,
    evaluate: async (fn: unknown, args: unknown) => { if (args !== undefined || String(fn).includes('w.rules')) calls.push({ frame: name, args }); return 4 } })
  const outer = frame('workbench', url + 'commander/')
  const game = frame('ra2c-game', url)
  const other = frame('other-game', url)
  let receive!: (source: unknown, value: ReturnType<typeof snapshot>) => void
  const context = { pages: () => [{ frames: () => [outer, game] }, { frames: () => [other] }],
    exposeBinding: async (_name: string, callback: typeof receive) => { receive = callback }, addInitScript: async () => {} }
  const bridge = new WerhdBridge(context as never, url)
  bridge.bindGameFrame(game as never)
  await bridge.install()
  receive({ frame: outer }, snapshot({ sessionKey: 'outer' }))
  receive({ frame: other }, snapshot({ sessionKey: 'other' }))
  assert.equal(bridge.latest, undefined)
  const current = snapshot()
  receive({ frame: game }, current)
  assert.equal(bridge.latest, current)
  await bridge.rules('GAWEAP', 2)
  await bridge.submit({ kind: 'stop', unitIds: [1] }, current)
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.frame === 'ra2c-game'))
})
