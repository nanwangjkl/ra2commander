import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { WerhdBridge } from '../packages/game-werhd/src/page-bridge.ts'
import { snapshot } from './helpers.ts'
import { placementDirection, inTargetRegion, type TargetRegion, type PlacementDirection } from '../packages/contracts/src/index.ts'

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
    me: () => ({ credits: 1000 }), map: { size: () => ({ width: 100, height: 100 }), tile: (x: number, y: number) => ({ rx: x, ry: y, z: 0 }) },
    move: (...args: unknown[]) => { submitted.push(args) }, attack: (...args: unknown[]) => { submitted.push(args) },
    produce: (...args: unknown[]) => { submitted.push(args) },
    canPlace: (_name: string, _x: number, _y: number) => true,
    place: (...args: unknown[]) => { submitted.push(args) },
    order: (...args: unknown[]) => { submitted.push(args); return true },
    unit: (id: number) => own.find(unit => unit.id === id),
    stop: (...args: unknown[]) => { submitted.push(args) }, inRange: () => true,
    repair: (id: number) => { const unit = own.find(unit => unit.id === id)!; unit.hasWrenchRepair = !unit.hasWrenchRepair; submitted.push({ kind: 'repair', id }) },
    sell: (id: number) => { submitted.push({ kind: 'sell', id }) },
    rules: (_name: string, _type: number) => ({ unsellable: false }),
  }
  const window: Record<string, any> = { werhd: api, __ra2cSnapshot: (s: ReturnType<typeof snapshot>) => snapshots.push(s) }
  const install = () => runInNewContext(readFileSync(new URL('../packages/game-werhd/src/bridge.js', import.meta.url), 'utf8'), {
    window, crypto: { randomUUID }, performance, setInterval: (fn: () => void) => { poll = fn; return 1 }, clearInterval: () => {},
  })
  install()
  poll()
  const sample = () => { onTick({ tick }); return snapshots.at(-1)! }
  const next = () => { tick += 15; return sample() }
  return { window, api, submitted, sample, next, poll: () => poll(), install, own, enemy, setTick: (value: number) => { tick = value } }
}

test('分区内建造遵守异形边界和孔洞，无落点时不退回基地默认位置', () => {
  const page = pageBridge()
  page.own.push({ ...page.own[0]!, id: 500, name: 'GACNST', type: 2, tile: { rx: 50, ry: 50 } })
  const region: TargetRegion = { id: 'floor', name: '一楼', polygons: [{ outer: [[40, 40], [60, 40], [60, 44], [44, 44], [44, 60], [40, 60], [40, 40]], holes: [[[41, 41], [43, 41], [43, 43], [41, 43], [41, 41]]] }] }
  const snap = page.sample()
  const submit = (x?: number, y?: number) => page.window.__ra2cSubmit(snap.session, { kind: 'place', name: 'GAREFN', placementRegion: region, x, y }, snap.seq, snap.sessionKey)
  page.api.canPlace = (_name, x, y) => { assert.ok(inTargetRegion(x, y, region)); return true }
  const result = submit()
  assert.equal(result.ok, true)
  assert.ok(inTargetRegion(result.placement.x, result.placement.y, region))
  const before = page.submitted.length
  page.api.canPlace = (_name, x, y) => x === 50 && y === 50 || x === 42 && y === 42
  assert.equal(submit().reason, 'no-spot', '基地原点和孔洞中的合法引擎格都不能代替分区落点')
  assert.equal(submit(50, 50).reason, 'wrong-placement-region')
  assert.equal(page.submitted.length, before)
})

test('建筑维修原语幂等开启扳手，出售不接受车辆、敌人或禁止出售建筑', () => {
  const page = pageBridge()
  page.own[0] = { ...page.own[0]!, name: 'GAREFN', type: 2, hitPoints: 850, maxHitPoints: 1000, hasWrenchRepair: false }
  const first = page.sample()
  const submit = (kind: string, id: number, snap = first) => page.window.__ra2cSubmit(snap.session, { kind, unitIds: [id] }, snap.seq, snap.sessionKey)
  assert.equal(submit('repairBuilding', 1).submitted, 1)
  assert.equal(submit('repairBuilding', 1).submitted, 0, '原生 repair 是 toggle，再发同一开启指令不能关闭扳手')
  const next = page.next()
  assert.equal(next.self[0]!.hasWrenchRepair, true)
  assert.equal(submit('sellBuilding', 1, next).ok, true)
  assert.deepEqual(page.submitted, [{ kind: 'repair', id: 1 }, { kind: 'sell', id: 1 }])
  assert.equal(submit('sellBuilding', 2, next).reason, 'invalid-building')
  assert.equal(submit('sellBuilding', 99, next).reason, 'invalid-units')
  page.api.rules = () => ({ unsellable: true })
  assert.equal(submit('sellBuilding', 1, next).reason, 'unsellable-building')
  assert.equal(page.submitted.length, 2)
})

test('页面桥转发飞机弹药及武器冷却，供宿主识别装弹与真实发射', () => {
  const page = pageBridge()
  page.own[0] = { ...page.own[0]!, type: 1, ammo: 0, primaryWeapon: { ...page.own[0]!.primaryWeapon!, cooldownTicks: 7 } }
  assert.equal(page.sample().self[0]!.ammo, 0)
  assert.equal(page.sample().self[0]!.primaryWeapon!.cooldownTicks, 7)
  page.own[0].ammo = 1
  assert.equal(page.next().self[0]!.ammo, 1)
})

test('页面桥可以提交正常动作，并丢弃过期、跨局或目标已消失的动作', () => {
  const page = pageBridge()
  const first = page.sample()
  const action = { kind: 'move', unitIds: [1], x: 6, y: 6 }
  assert.equal(page.window.__ra2cSubmit(first.session, action, first.seq, first.sessionKey).ok, true)
  page.api.inRange = () => { throw new Error('宿主不应预判射程') }
  assert.equal(page.window.__ra2cSubmit(first.session, { kind: 'attack', unitIds: [1], targetId: 99 }, first.seq, first.sessionKey).ok, true)
  const second = page.next()
  assert.equal(page.window.__ra2cSubmit(first.session, action, first.seq, first.sessionKey).ok, false)
  assert.equal(page.window.__ra2cSubmit(first.session, { kind: 'stop', unitIds: [1] }, first.seq, first.sessionKey).ok, true)
  page.enemy.length = 0
  assert.equal(page.window.__ra2cSubmit(second.session, { kind: 'attack', unitIds: [1], targetId: 99 }, second.seq, second.sessionKey).ok, false)
  page.window.werhd = { ...page.api }
  assert.equal(page.window.__ra2cSubmit(second.session, action, second.seq, second.sessionKey).ok, false)
  page.poll()
  assert.equal(page.window.__ra2cSubmit(second.session, action, second.seq, second.sessionKey).ok, false)
  assert.equal(page.submitted.length, 3)
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

test('桥升级保留对局身份并递增序号，上车和维修使用原生对象指令且不预判射程', () => {
  const page = pageBridge()
  page.own[0]!.name = 'FV'; page.own[0]!.transport = { occupied: 0, capacity: 1, unitIds: [] }
  page.own[1]!.name = 'ENGINEER'; page.own[1]!.type = 3
  page.own[2]!.hitPoints = 50; page.own[2]!.maxHitPoints = 100
  const first = page.sample()
  const submit = (context: typeof first, action: unknown) => page.window.__ra2cSubmit(context.session, action, context.seq, context.sessionKey)
  assert.equal(submit(first, { kind: 'enterTransport', unitIds: [2], targetId: 1 }).ok, true)
  assert.deepEqual(JSON.parse(JSON.stringify(page.submitted[0])), [[2], { type: 17, target: { objectId: 1 } }])
  page.own[0]!.transport = { occupied: 1, capacity: 1, unitIds: [2] }
  page.own.splice(1, 1)
  const loaded = page.next()
  assert.equal(loaded.self[0]!.transport!.passengers![0]!.name, 'ENGINEER')
  assert.equal(submit(loaded, { kind: 'repair', unitIds: [1], targetId: 3 }).ok, true)
  assert.deepEqual(JSON.parse(JSON.stringify(page.submitted[1])), [[1], { type: 2, target: { objectId: 3 } }]) // 普通 Attack，不是 Repair 或 ForceAttack。
  page.window.__ra2cVersion = 5
  page.install(); page.poll()
  const upgraded = page.next()
  assert.equal(upgraded.sessionKey, first.sessionKey)
  assert.equal(upgraded.session, first.session)
  assert.ok(upgraded.seq > loaded.seq)
  assert.equal(submit(loaded, { kind: 'repair', unitIds: [1], targetId: 3 }).ok, false)
  assert.equal(submit(upgraded, { kind: 'repair', unitIds: [1], targetId: 3 }).ok, true)
  assert.equal(page.window.__ra2cSubmit(upgraded.session, { kind: 'repair', unitIds: [1], targetId: 3 }, upgraded.seq, 'old-battle').ok, false)
  page.setTick(1); page.window.__ra2cVersion = 5
  page.install(); page.poll()
  assert.notEqual(page.sample().sessionKey, upgraded.sessionKey) // 升级期间实际换局仍必须撤销旧身份。
})
test('建筑按画面上左下找合法位置；指定方向无地可放时保留建筑，普通放置仍可执行', () => {
  const page = pageBridge(), anchor = { x: 50, y: 50, elevation: 0 }
  page.own[0]!.name = 'GACNST'; page.own[0]!.type = 2; page.own[0]!.tile = { rx: 50, ry: 50 }
  const snap = page.sample()
  const submit = (name: string, direction?: PlacementDirection) => page.window.__ra2cSubmit(snap.session, { kind: 'place', name, ...(direction ? { placement: { id: `${name}:${direction}`, anchor, direction } } : {}) }, snap.seq, snap.sessionKey)
  for (const direction of ['up', 'left', 'down'] as const) {
    const result = submit('GTGCAN', direction)
    assert.equal(result.ok, true)
    assert.equal(placementDirection(anchor, result.placement), direction)
  }
  page.api.canPlace = (_name, x, y) => placementDirection(anchor, { x, y }) === 'down'
  const before = page.submitted.length
  assert.equal(submit('GTGCAN', 'up').reason, 'no-spot')
  assert.equal(page.submitted.length, before)
  assert.equal(submit('GAPOWR').ok, true)
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

test('完整目录批量读取公开规则，同局缓存、换局失效，不读取或改变游戏动作', async () => {
  let reads = 0, evaluations = 0
  const state = { __ra2cSessionKey: 'first', werhd: { rules: (name: string, type: number) => { reads++; return { name, type, prerequisite: [] } } } }
  const bridge = new WerhdBridge({} as never)
  bridge.bindGameFrame({ isDetached: () => false, evaluate: async (fn: Function, arg: unknown) => { evaluations++; return runInNewContext(`(${fn.toString()})(args)`, { window: state, args: arg }) } } as never)
  const requests = Array.from({ length: 65 }, (_, n) => ({ name: `UNIT_${n}`, type: 7 }))
  assert.equal((await bridge.rulesMany(requests, 'first')).length, 65)
  assert.equal(reads, 65)
  assert.equal(evaluations, 2)
  await bridge.rulesMany(requests, 'first')
  assert.equal(reads, 65)
  state.__ra2cSessionKey = 'second'
  await bridge.rulesMany([requests[0]!], 'second')
  assert.equal(reads, 66)
  await assert.rejects(bridge.rulesMany([requests[1]!], 'first'), /对局已变化/)
})

test('工作台中的查询和动作指向已绑定游戏 frame，忽略外层与其他游戏的快照', async () => {
  const url = 'https://127.0.0.1:8787/'
  const calls: Array<{ frame: string; args: unknown }> = []
  const frame = (name: string, address: string) => ({ name: () => name, url: () => address, isDetached: () => false,
    evaluate: async (_fn: unknown, args: unknown) => { if (args !== undefined) calls.push({ frame: name, args }); return 4 } })
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
