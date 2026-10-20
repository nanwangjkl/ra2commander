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

test('页面最终提交拒绝过期快照和旧对局，目标消失后拒绝攻击', () => {
  const page = pageBridge()
  const first = page.sample()
  const action = { kind: 'move', unitIds: [1], x: 6, y: 6 }
  assert.equal(page.window.__ra2cSubmit(first.session, action, first.seq, first.sessionKey).ok, true)
  const second = page.next()
  assert.equal(page.window.__ra2cSubmit(first.session, action, first.seq, first.sessionKey).reason, 'stale-snapshot')
  page.enemy.length = 0
  assert.equal(page.window.__ra2cSubmit(second.session, { kind: 'attack', unitIds: [1], targetId: 99 }, second.seq, second.sessionKey).reason, 'invisible-target')
  page.window.werhd = { ...page.api }
  assert.equal(page.window.__ra2cSubmit(second.session, action, second.seq, second.sessionKey).reason, 'stale-session')
  page.poll()
  assert.equal(page.window.__ra2cSubmit(second.session, action, second.seq, second.sessionKey).reason, 'stale-session')
  assert.equal(page.submitted.length, 1)
})

test('换局重置采样 tick，低 tick 的新对局立即采样', () => {
  const page = pageBridge()
  const old = page.sample()
  for (let i = 0; i < 10; i++) page.next()
  page.window.werhd = { ...page.api }
  page.poll()
  page.setTick(1)
  const next = page.sample()
  assert.notEqual(next.sessionKey, old.sessionKey)
  assert.equal(next.tick, 1)
})

test('紧急停车允许同局稍旧快照，目标出射程后最终拒绝攻击', () => {
  const page = pageBridge()
  const first = page.sample()
  const next = page.next()
  assert.equal(page.window.__ra2cSubmit(first.session, { kind: 'stop', unitIds: [1] }, first.seq, first.sessionKey).ok, true)
  page.api.inRange = () => false
  assert.equal(page.window.__ra2cSubmit(next.session, { kind: 'attack', unitIds: [1], targetId: 99 }, next.seq, next.sessionKey).reason, 'out-of-range')
})

test('宿主桥保留动作来源对局，不查询当前会话替换它；撤权后不排入 evaluate', async () => {
  const calls: unknown[] = []
  const page = { evaluate: async (_fn: unknown, args: unknown) => { calls.push(args); return { ok: true } } }
  const bridge = new WerhdBridge({ pages: () => [page] } as never)
  const context = snapshot()
  await bridge.submit({ kind: 'stop', unitIds: [1] }, context)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], [context, { kind: 'stop', unitIds: [1] }])
  await bridge.submit({ kind: 'stop', unitIds: [1] }, context, () => false)
  assert.equal(calls.length, 1)
})

test('API 对象复用但模拟 tick 回退时也撤销旧会话', () => {
  const page = pageBridge()
  const old = page.sample()
  page.next()
  page.setTick(1)
  assert.equal(page.window.__ra2cSubmit(old.session, { kind: 'stop', unitIds: [1] }, old.seq, old.sessionKey).reason, 'stale-session')
  page.sample()
  page.poll()
  const current = page.sample()
  assert.notEqual(current.sessionKey, old.sessionKey)
  assert.equal(current.tick, 1)
})
