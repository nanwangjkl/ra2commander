import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { WerhdBridge } from '../packages/game-werhd/src/page-bridge.ts'
import { loadPrompts } from '../packages/command/src/index.ts'
import { snapshot } from './helpers.ts'
import { placementDirection, inTargetRegion, type TargetRegion, type PlacementDirection } from '../packages/contracts/src/index.ts'

const buildingFoundations = Object.fromEntries(loadPrompts().game.entries().flatMap(item =>
  item.type === 2 && item.foundation ? [[item.name, item.foundation]] : []))
const bridgeSource = readFileSync(new URL('../packages/game-werhd/src/bridge.js', import.meta.url), 'utf8')
function pageBridge(source = `window.__ra2cBuildingFoundations = ${JSON.stringify(buildingFoundations)};\nwindow.__ra2cCrushingRules = ${JSON.stringify(loadPrompts().game.crushing())};\n${bridgeSource}`) {
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
  const install = () => runInNewContext(source, {
    // 固定采集耗时，避免测试并行调度触发实机采样降频而读到上一帧。
    window, crypto: { randomUUID }, performance: { now: () => 0 }, setInterval: (fn: () => void) => { poll = fn; return 1 }, clearInterval: () => {},
  })
  install()
  poll()
  const sample = () => { onTick({ tick }); return snapshots.at(-1)! }
  const next = () => { tick += 15; return sample() }
  return { window, api, submitted, sample, next, poll: () => poll(), install, own, enemy, setTick: (value: number) => { tick = value } }
}

test('碾压走 ForceMove 地格订单，复查实时敌人、桥面和目标分区，不把拒绝当成成功', () => {
  const page = pageBridge()
  page.enemy[0] = { ...page.enemy[0]!, name: 'E1', type: 3, onBridge: true, zone: 0 }
  page.own[0]!.onBridge = true
  const snap = page.sample()
  assert.equal(snap.self[0]!.onBridge, true)
  assert.equal(snap.enemies[0]!.onBridge, true)
  const action = { kind: 'crush', unitIds: [1], targetId: 99, targetRegion: { id: 'zone', name: '防区', polygons: [{ outer: [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]], holes: [] }] } }
  const submit = () => page.window.__ra2cSubmit(snap.session, action, snap.seq, snap.sessionKey)
  page.enemy[0]!.tile.rx = 12
  assert.equal(submit().ok, true)
  assert.deepEqual(JSON.parse(JSON.stringify(page.submitted)), [[[1], { type: 1, target: { x: 12, y: 5, onBridge: true } }]])
  assert.equal(submit().targetPosition.x, 12, '使用最终提交时的真实落点')
  for (const name of ['ADOG', 'DOG', 'SHK']) { page.enemy[0]!.name = name; assert.equal(submit().reason, 'crush-not-applicable') }
  page.enemy[0]!.name = 'E1'
  for (const name of ['APOC', 'FV']) { page.own[0]!.name = name; assert.equal(submit().reason, 'crush-not-applicable') }
  page.own[0]!.name = 'MTNK'; page.enemy[0]!.zone = 1
  assert.equal(submit().reason, 'crush-not-applicable')
  page.enemy[0]!.zone = 0; page.enemy[0]!.onBridge = false
  assert.equal(submit().reason, 'crush-not-applicable')
  page.enemy[0]!.onBridge = true; page.enemy[0]!.tile.rx = 25
  assert.equal(submit().reason, 'crush-target-outside')
  page.enemy[0]!.tile.rx = 12; page.api.order = () => false
  assert.equal(submit().reason, 'crush-order-rejected')
  page.enemy.length = 0
  assert.equal(submit().reason, 'invisible-target')
})

test('部署原语按实际姿态幂等提交，不将无姿态的 Mod 变形当成常规部署', () => {
  const page = pageBridge()
  page.own[0] = { ...page.own[0]!, name: 'E1', type: 3, canDeploy: true, isDeployed: false }
  Object.assign(page.api, { deploy: (ids: number[]) => { page.submitted.push(ids); for (const id of ids) { const unit = page.own.find(unit => unit.id === id)!; unit.isDeployed = !unit.isDeployed } return true } })
  let snap = page.sample()
  assert.equal(snap.self[0]!.isDeployed, false)
  const submit = (deployed: boolean) => page.window.__ra2cSubmit(snap.session, { kind: 'deploy', unitIds: [1], deployed }, snap.seq, snap.sessionKey)
  assert.equal(submit(true).submitted, 1)
  assert.equal(submit(true).submitted, 0, '旧快照期间也复查页面真实姿态')
  snap = page.next()
  assert.equal(snap.self[0]!.isDeployed, true)
  assert.equal(submit(false).submitted, 1)
  delete page.own[0]!.isDeployed
  assert.equal(submit(true).reason, 'deployment-state-unavailable')
  assert.equal(page.submitted.length, 2)
})

test('公开玩家状态确认胜负，最后不满采样间隔也补存结束，不凭敌人消失宣布胜利', () => {
  const page = pageBridge()
  let defeated = false
  page.api.me = () => ({ credits: 1000, name: 'self', combatant: true, isObserver: false, defeated: false })
  Object.assign(page.api, { players: () => [
    { name: 'self', allied: true, combatant: true, isObserver: false, defeated: false },
    { name: 'ally', allied: true, combatant: true, isObserver: false, defeated: false },
    { name: 'opponent', allied: false, combatant: !defeated, isObserver: false, defeated },
  ] })
  let snap = page.sample()
  assert.equal(snap.battle!.phase, 'playing')
  page.enemy.length = 0
  snap = page.next()
  assert.equal(snap.battle!.phase, 'playing')
  page.setTick(snap.tick + 1); defeated = true
  page.poll()
  const ended = page.window.__ra2cState()
  assert.ok(ended.installed)
  // 原采样间隔还没有过去，只靠轮询补采最终状态。
  const final = page.sample()
  assert.equal(final.battle!.outcome, 'victory')
  assert.ok(final.seq > snap.seq)
  assert.equal(page.window.__ra2cSubmit(final.session, { kind: 'stop', unitIds: [1] }, final.seq, final.sessionKey).reason, 'battle-ended')
  page.api.me = () => ({ credits: 1000, name: 'self', combatant: false, isObserver: false, defeated: true })
  page.next()
  assert.equal(page.sample().battle!.outcome, 'defeat')
})

test('生产建筑集结原语走公开 Move 订单，拒绝车辆、建造厂、机场及失效目标', () => {
  const page = pageBridge()
  page.own[0] = { ...page.own[0]!, name: 'GAWEAP', type: 2 }
  let factory = 3
  page.api.rules = () => ({ factory } as never)
  const snap = page.sample()
  const submit = (x = 50, y = 60) => page.window.__ra2cSubmit(snap.session, { kind: 'setRallyPoint', unitIds: [page.own[0]!.id], x, y }, snap.seq, snap.sessionKey)
  assert.equal(submit().ok, true)
  assert.deepEqual(JSON.parse(JSON.stringify(page.submitted)), [[[page.own[0]!.id], { type: 0, target: { x: 50, y: 60 } }]])
  for (const kind of [0, 1, 5]) { factory = kind; assert.equal(submit().reason, 'not-rally-factory') }
  factory = 3; page.own[0]!.type = 7
  assert.equal(submit().reason, 'not-rally-factory')
  page.own[0]!.type = 2
  assert.equal(submit(100, 60).reason, 'invalid-rally-point')
  page.api.order = () => false
  assert.equal(submit().reason, 'rally-order-rejected')
  assert.equal(page.submitted.length, 1)
})

test('撤销生产只按本步真实同名队列数量提交，不影响其他项目', () => {
  const page = pageBridge()
  let queued = 2
  Object.assign(page.api, {
    production: { queues: () => [{ type: 4, items: [{ name: 'ORCA', quantity: queued }, { name: 'YAK', quantity: 1 }] }], available: () => [] },
    cancel: (name: string, quantity: number) => page.submitted.push({ name, quantity }),
  })
  let snap = page.sample()
  const submit = (quantity: number) => page.window.__ra2cSubmit(snap.session, { kind: 'cancel', name: 'ORCA', quantity }, snap.seq, snap.sessionKey)
  assert.equal(submit(4).ok, true)
  assert.deepEqual(page.submitted, [{ name: 'ORCA', quantity: 2 }])
  queued = 0; snap = page.next()
  assert.equal(submit(2).reason, 'not-queued')
  assert.equal(submit(-1).reason, 'invalid-quantity')
  assert.equal(page.submitted.length, 1)
})

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

test('自动建筑放置优先避开集结点周围 3×3，不改变原集结点', () => {
  const page = pageBridge()
  page.own.splice(0, page.own.length, { ...page.own[0]!, id: 3237, name: 'NAWEAP', type: 2, tile: { rx: 82, ry: 38 } })
  page.own.push({ ...page.own[0]!, id: 3200, name: 'GACNST', tile: { rx: 82, ry: 48 } })
  page.api.canPlace = (_name, x, y) => [91, 95].includes(x) && y === 38
  const snap = page.sample()
  const result = page.window.__ra2cSubmit(snap.session, { kind: 'place', name: 'NAPOWR', rallyPoints: [{ x: 92, y: 39 }] }, snap.seq, snap.sessionKey)
  assert.equal(result.ok, true)
  assert.equal(result.placement.x, 95, '避开最新对局中电厂 91,38 与集结点 92,39 的冲突')
  assert.equal(page.submitted.length, 1)
})

test('唯一合法落点占用集结区时只提出候选，换点前不放置、不预占失败落点', () => {
  const page = pageBridge()
  page.own.splice(0, page.own.length, { ...page.own[0]!, id: 3237, name: 'NAWEAP', type: 2, tile: { rx: 82, ry: 38 } })
  page.api.canPlace = (_name, x, y) => x === 91 && y === 38
  const snap = page.sample(), region: TargetRegion = { id: 'right', name: '指定区', polygons: [{ outer: [[90, 37], [94, 37], [94, 41], [90, 41], [90, 37]], holes: [] }] }
  const place = (rallyPoints: Array<{ x: number; y: number }>, explicit = false) => page.window.__ra2cSubmit(snap.session, {
    kind: 'place', name: 'NAPOWR', placementRegion: region, rallyPoints,
    placement: { id: 'power', anchor: { x: 82, y: 38 }, direction: 'down-right' }, ...(explicit ? { x: 91, y: 38 } : {}),
  }, snap.seq, snap.sessionKey)
  for (const explicit of [false, true, false]) {
    const result = place([{ x: 92, y: 39 }], explicit)
    assert.equal(result.reason, 'building-rally-conflict')
    assert.equal(result.placement.x, 91)
    assert.equal(result.submitted, 0)
  }
  assert.equal(page.submitted.length, 0)
  assert.equal(place([{ x: 92, y: 43 }]).ok, true, '原候选未计入实际放置或占地预留，换点后仍可放置')
  assert.equal(page.submitted.length, 1)
})

test('建筑间隔按完整占地留一格，包含斜角、盟友及可见敌方建筑', () => {
  const page = pageBridge(), template = page.own[0]!
  const building = (id: number, name: string, x: number, y: number) => ({ ...template, id, name, type: 2, tile: { rx: x, ry: y } })
  page.own.splice(0, page.own.length, building(100, 'GAWEAP', 20, 20)) // 5×3 占地。
  const allied = [building(101, 'GAREFN', 40, 40)]
  page.enemy.splice(0, page.enemy.length, building(102, 'GAPOWR', 60, 60))
  page.api.units = relation => relation === 'self' ? page.own : relation === 'allied' ? allied : page.enemy
  const snap = page.sample()
  const place = (x: number, y: number) => page.window.__ra2cSubmit(snap.session, { kind: 'place', name: 'GAPOWR', x, y }, snap.seq, snap.sessionKey)
  for (const [x, y] of [[25, 20], [25, 23], [18, 20], [20, 18], [44, 40], [62, 60]]) {
    assert.equal(place(x!, y!).reason, 'building-spacing', `不能紧贴建筑：${x},${y}`)
  }
  assert.equal(page.submitted.length, 0)
  for (const [x, y] of [[26, 20], [17, 20], [20, 24], [20, 17], [63, 60]]) {
    assert.equal(place(x!, y!).ok, true, `留一格后可放置：${x},${y}`)
  }
})

test('只有防御建筑之间可紧贴；围墙任一侧豁免间距，仍须满足引擎放置规则', () => {
  const page = pageBridge(), template = page.own[0]!
  page.own.push(
    { ...template, id: 100, name: 'GTGCAN', type: 2, tile: { rx: 20, ry: 20 } },
    { ...template, id: 101, name: 'GAWALL', type: 2, tile: { rx: 40, ry: 40 } },
    { ...template, id: 102, name: 'GAPOWR', type: 2, tile: { rx: 60, ry: 60 } },
  )
  page.api.rules = name => ({ unsellable: false, wall: name === 'GAWALL', isBaseDefense: ['GAPILL', 'GTGCAN'].includes(name) })
  const snap = page.sample()
  const place = (name: string, x: number, y: number) => page.window.__ra2cSubmit(snap.session, { kind: 'place', name, x, y }, snap.seq, snap.sessionKey)
  assert.equal(place('GAPILL', 22, 20).ok, true)
  assert.equal(place('GAPOWR', 22, 21).reason, 'building-spacing', '普通建筑不能紧贴防御建筑')
  assert.equal(place('GTGCAN', 62, 60).reason, 'building-spacing', '防御建筑不能紧贴普通建筑')
  assert.equal(place('GAWALL', 62, 60).ok, true)
  assert.equal(place('GAPOWR', 41, 40).ok, true)
  page.api.canPlace = () => false
  assert.equal(place('GAWALL', 61, 60).reason, 'cannot-place')
  assert.equal(place('GAPILL', 23, 20).reason, 'cannot-place')
})

test('宿主向页面注入建筑占地，自动选址和分区方位选址都避开紧邻及未显现的放置', async () => {
  let source = ''
  const bridge = new WerhdBridge({ pages: () => [], exposeBinding: async () => {}, addInitScript: async (value: string) => { source = value } } as never, undefined, buildingFoundations)
  await bridge.install()
  const page = pageBridge(source)
  page.own.push({ ...page.own[0]!, id: 100, name: 'GACNST', type: 2, tile: { rx: 50, ry: 50 } })
  page.api.canPlace = (_name, x, y) => [54, 55, 57, 58].includes(x) && y === 50
  const snap = page.sample()
  const submit = (action: object) => page.window.__ra2cSubmit(snap.session, action, snap.seq, snap.sessionKey)
  const first = submit({ kind: 'place', name: 'GAPOWR' })
  assert.equal(first.ok, true)
  assert.equal(first.placement.x, 55)
  assert.equal(submit({ kind: 'place', name: 'GAWEAP', x: 57, y: 50 }).reason, 'building-spacing')
  const region: TargetRegion = { id: 'right', name: '右侧', polygons: [{ outer: [[54, 49], [62, 49], [62, 53], [54, 53], [54, 49]], holes: [] }] }
  const second = submit({ kind: 'place', name: 'GAWEAP', placementRegion: region, placement: { id: 'factory-right', anchor: { x: 50, y: 50 }, direction: 'down-right' } })
  assert.equal(second.ok, true)
  assert.equal(second.placement.x, 58)
  assert.ok(inTargetRegion(second.placement.x, second.placement.y, region))
  assert.equal(placementDirection({ x: 50, y: 50 }, second.placement), 'down-right')
  page.api.canPlace = (_name, x, y) => x === 54 && y === 50
  assert.equal(submit({ kind: 'place', name: 'GAREFN' }).reason, 'no-spot')
})

test('放置预留在建筑出现后转为实时占地，拆除后可重用，静默失败不永久占位', () => {
  const page = pageBridge()
  let snap = page.sample()
  const place = (name: string, x: number, y: number) => page.window.__ra2cSubmit(snap.session, { kind: 'place', name, x, y }, snap.seq, snap.sessionKey)
  assert.equal(place('GAPOWR', 10, 10).ok, true)
  assert.equal(place('GTGCAN', 12, 10).reason, 'building-spacing')
  page.own.push({ ...page.own[0]!, id: 100, name: 'GAPOWR', type: 2, tile: { rx: 10, ry: 10 } })
  snap = page.next()
  assert.equal(place('GTGCAN', 12, 10).reason, 'building-spacing')
  page.own.pop()
  snap = page.next()
  assert.equal(place('GTGCAN', 12, 10).ok, true)
  assert.equal(place('GAPOWR', 30, 30).ok, true)
  assert.equal(place('GTGCAN', 32, 30).reason, 'building-spacing')
  page.setTick(snap.tick + 120); snap = page.sample()
  assert.equal(place('GTGCAN', 32, 30).ok, true)
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

test('行军速度按本局规则读取并缓存，防空车可快于坦克，换局重新读取', () => {
  const page = pageBridge()
  let calls = 0
  page.api.rules = (name, _type) => { calls++; return { unsellable: false, speed: name === 'HTK' ? 8 : 6 } }
  page.own[0] = { ...page.own[0]!, name: 'HTK', zone: 0 }
  page.own[0].velocity = { x: 3, y: 0, z: 7 }
  page.sample(); assert.equal(calls, 0, 'tick 采样不查询静态规则')
  page.poll(); const snap = page.next()
  assert.equal(snap.self[0]!.speed, 8)
  assert.equal(snap.self[1]!.speed, 6)
  assert.equal(snap.self[0]!.zone, 0)
  assert.deepEqual({ ...snap.self[0]!.velocity }, { x: 3, y: 0, z: 7 }, '移动方向直接取游戏公开向量，不通过截图或位移测速')
  const count = calls; page.next(); assert.equal(calls, count)
  page.setTick(1); page.sample(); page.poll(); page.next(); page.poll(); page.next()
  assert.ok(calls > count, '换局不能复用旧 MOD 速度')
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

test('已公开的敌方幻影使用强制对象攻击，普通敌人仍用普通攻击，不查射程阻止接近', () => {
  const page = pageBridge()
  page.enemy[0]!.name = 'MGTK'
  const snap = page.sample()
  page.api.inRange = () => { throw new Error('普通进攻不应预判射程') }
  const attack = (targetId = 99) => page.window.__ra2cSubmit(snap.session, { kind: 'attack', unitIds: [1, 2], targetId }, snap.seq, snap.sessionKey)
  const forced = attack()
  assert.equal(forced.reason, 'mirage-force-attack')
  assert.equal(forced.submitted, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(page.submitted)), [[[1, 2], { type: 3, target: { objectId: 99 } }]])
  page.api.order = () => false
  assert.equal(attack().reason, 'order-rejected', '回执拒绝不能算成功')
  page.enemy[0]!.name = 'MTNK'
  assert.equal(attack().ok, true)
  assert.deepEqual(JSON.parse(JSON.stringify(page.submitted.at(-1))), [[1, 2], 99])
  assert.equal(attack(1).reason, 'invisible-target', '不能强攻己方单位')
  page.enemy.length = 0
  assert.equal(attack().reason, 'invisible-target', '不以历史 ID 强攻已不在公开敌人列表的目标')
  assert.equal(page.submitted.length, 2)
})

test('幻影伪装不阻断掩护射程查询；仅射程内成员强攻，防空主武器不放宽对地副武器射程', async () => {
  const page = pageBridge()
  page.enemy[0]!.name = 'MGTK'
  page.own[1]!.primaryWeapon = { minRange: 0, maxRange: 8, aa: true, ag: false }
  page.own[1]!.secondaryWeapon = { minRange: 0, maxRange: 4, aa: false, ag: true }
  let distance = 5
  Object.assign(page.api, { weaponVs: (_a: number, _b: number, mode: string) => mode === 'current' ? undefined : { distance, inRange: true } })
  const snap = page.sample(), pairs = [{ unitId: 1, targetId: 99 }, { unitId: 2, targetId: 99 }]
  const bridge = new WerhdBridge({} as never)
  bridge.bindGameFrame({ isDetached: () => false, page: () => ({ isClosed: () => false }), evaluate: (fn: Function, args: unknown) => runInNewContext(`(${fn.toString()})(args)`, { window: page.window, args }) } as never)
  assert.deepEqual(JSON.parse(JSON.stringify(await bridge.coverRanges(pairs, snap.sessionKey))), [
    { ...pairs[0], canAttack: true, inRange: true }, { ...pairs[1], canAttack: true, inRange: false },
  ])
  const attack = () => page.window.__ra2cSubmit(snap.session, { kind: 'attack', unitIds: [1, 2], targetId: 99, holdPosition: true }, snap.seq, snap.sessionKey)
  assert.equal(attack().submitted, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(page.submitted)), [[[1], { type: 3, target: { objectId: 99 } }]])
  distance = 9
  assert.equal(attack().reason, 'cover-out-of-range')
  assert.equal(page.submitted.length, 1, '不能因强攻绕过掩护的射程限制')
  distance = 3
  assert.equal(attack().submitted, 2)
  page.enemy[0]!.name = 'MTNK'
  assert.ok((await bridge.coverRanges(pairs, snap.sessionKey)).every(pair => !pair.canAttack), '普通目标不能借幻影分支跳过实际武器选择')
  assert.equal((await bridge.coverRanges(pairs, 'old-battle')).length, 0)
})

test('掩护开火用当前武器复查射程，射程不足正常等待；普通攻击仍由游戏接近', () => {
  const page = pageBridge(), snap = page.sample(), modes: unknown[] = []
  Object.assign(page.api, { inRange: (_unitId: number, _targetId: number, mode: unknown) => { modes.push(mode); return false } })
  const submit = (holdPosition: boolean) => page.window.__ra2cSubmit(snap.session, { kind: 'attack', unitIds: [1], targetId: 99, holdPosition }, snap.seq, snap.sessionKey)
  assert.equal(submit(true).submitted, 0)
  assert.equal(page.submitted.length, 0)
  assert.deepEqual(modes, ['current'])
  assert.equal(submit(false).ok, true)
  assert.equal(page.submitted.length, 1)
  Object.assign(page.api, { inRange: () => true })
  assert.equal(submit(true).ok, true)
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
  const page = { name: () => '', isDetached: () => false, page: () => ({ isClosed: () => false }),
    evaluate: async (_fn: unknown, args: unknown) => { calls.push(args); return { ok: true } } }
  const bridge = new WerhdBridge({ pages: () => [{ isClosed: () => false, mainFrame: () => page }] } as never)
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
  bridge.bindGameFrame({ isDetached: () => false, page: () => ({ isClosed: () => false }), evaluate: async (fn: Function, arg: unknown) => { evaluations++; return runInNewContext(`(${fn.toString()})(args)`, { window: state, args: arg }) } } as never)
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
  const frame = (name: string, address: string) => ({ name: () => name, url: () => address, isDetached: () => false, page: () => ({ isClosed: () => false }),
    evaluate: async (_fn: unknown, args: unknown) => { if (args !== undefined) calls.push({ frame: name, args }); return 4 } })
  const outer = frame('workbench', url + 'commander/')
  const game = frame('ra2c-game', url)
  const other = frame('other-game', url)
  let receive!: (source: unknown, value: ReturnType<typeof snapshot>) => void
  const context = { pages: () => [{ isClosed: () => false, frames: () => [outer, game] }, { isClosed: () => false, frames: () => [other] }],
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

test('关闭窗口后不访问未标记detached的旧frame，重新打开工作台会重绑并清理旧快照', async () => {
  const url = 'https://127.0.0.1:8787/'
  let closed = false, opened = true, receives!: (source: unknown, value: ReturnType<typeof snapshot>) => void, oldReads = 0
  const old = { name: () => 'ra2c-game', url: () => url, isDetached: () => false, page: () => ({ isClosed: () => closed }),
    evaluate: async () => { oldReads++; if (closed) throw new Error('Target page, context or browser has been closed'); return { apiAlive: true } } }
  const fresh = { name: () => 'ra2c-game', url: () => url, isDetached: () => false, page: () => ({ isClosed: () => false }), evaluate: async () => ({ apiAlive: true }) }
  const context = { pages: () => !opened ? [] : [{ isClosed: () => false, frames: () => closed ? [fresh] : [old] }],
    exposeBinding: async (_name: string, callback: typeof receives) => { receives = callback }, addInitScript: async () => {} }
  const bridge = new WerhdBridge(context as never, url)
  bridge.bindGameFrame(old as never); await bridge.install()
  receives({ frame: old }, snapshot())
  assert.ok(bridge.latest)
  closed = true; opened = false
  const reads = oldReads
  assert.equal((await bridge.state()).apiAlive, false)
  assert.equal(bridge.latest, undefined)
  assert.equal(oldReads, reads, '不在关闭的页面上反复执行ensureBridge和evaluate')
  opened = true
  assert.equal((await bridge.state()).apiAlive, true)
  assert.equal(bridge.frame, fresh)
  receives({ frame: old }, snapshot({ sessionKey: 'stale' }))
  assert.equal(bridge.latest, undefined)
  const next = snapshot({ sessionKey: 'new' })
  receives({ frame: fresh }, next)
  assert.equal(bridge.latest, next)
})
