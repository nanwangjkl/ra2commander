import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPrompts } from '../packages/command/src/index.ts'
import { validateActions, type SnapshotUnit } from '../packages/contracts/src/index.ts'
import { TaskRuntime, persistState, restoreState, type FactorySite } from '../packages/runtime/src/index.ts'
import { readFactorySites } from '../apps/companion/src/factory-rally.ts'
import { runTranscript } from '../apps/companion/src/transcript.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { activate, deferred, harness, production, snapshot } from './helpers.ts'

const game = loadPrompts().game
const building = (id: number, name = 'GAWEAP', x = 20, y = 20): SnapshotUnit => ({ id, name, type: 2, rx: x, ry: y, elevation: 0, isIdle: true })
const nativeRules = (name: string, type: number) => {
  const entry = game.entry(name)
  return entry?.type === type ? { ...entry, factory: { InfantryType: 2, UnitType: 3, NavalUnitType: 4, BuildingType: 1, AircraftType: 5 }[entry.factory] ?? 0 } : undefined
}
const bridge = { rulesMany: async (requests: Array<{ name: string; type: number }>) => requests.map(request => ({ ...request, rule: nativeRules(request.name, request.type) })) }
const sites = (snap: ReturnType<typeof snapshot>) => readFactorySites(bridge, snap, game)
const tiles = async (points: Array<{ x: number; y: number }>) => points.map(point => ({ ...point, z: 0, landType: 0 }))
async function fixture() {
  const h = await harness(undefined, { factorySites: sites, rallyTiles: tiles })
  await h.runtime.onSnapshot(snapshot({ seq: 2, mapWidth: 200, mapHeight: 200, self: [building(100), building(101, 'NAWEAP', 25, 25), building(102, 'GAPOWR', 30, 20), building(104, 'GAYARD', 50, 50)] }))
  const tick = (delta = 30) => h.runtime.onSnapshot({ ...h.runtime.snapshot!, seq: h.runtime.snapshot!.seq + 1, tick: h.runtime.snapshot!.tick + delta })
  return { ...h, tick }
}

test('真实 art 占地驱动默认集结，绕开建筑、门口与已用位置；只初始化一次', async () => {
  assert.deepEqual(game.entry('GAWEAP')!.foundation, { width: 5, height: 3 })
  assert.deepEqual(game.entry('NAWEAP')!.foundation, { width: 5, height: 3 })
  const f = await fixture()
  activate(f.runtime, production())
  await f.tick()
  const settings = f.runtime.factoryRallies.state.settings
  assert.equal(settings.length, 2)
  assert.ok(settings.every(setting => setting.source === 'automatic' && setting.status === 'submitted'))
  assert.equal(f.submitted.filter(action => action.kind === 'setRallyPoint').length, 2)
  const points = settings.map(setting => setting.point!)
  assert.ok(Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y) >= 3)
  for (const setting of settings) {
    const point = setting.point!
    assert.ok(point.x >= setting.origin.x + 7, '候选在真实 5 格占地出口之外')
    assert.ok(!(point.x >= 29 && point.x <= 32 && point.y >= 19 && point.y <= 22), '避开电厂占地及边缘')
  }
  await f.tick(300); await f.tick(300)
  assert.equal(f.submitted.length, 2, '普通生产步进不重复设置，不移动已经存在的单位')
  await f.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: 10, tick: 1000, self: [...f.runtime.snapshot!.self, building(103, 'GAWEAP', 40, 20)] })
  assert.equal(f.submitted.length, 3, '接管后的新建重工也会独立初始化')
})

test('语音设置全部重工只理解一次，保留分区和实际建筑ID，不编译脚本、不移动现有坦克', async () => {
  const f = await fixture(), root = mkdtempSync(join(tmpdir(), 'ra2c-factory-rally-'))
  let requests = 0
  const provider = { generate: async () => {
    requests++
    return { text: JSON.stringify({ summary: '将全部重工的后续出厂单位集结到三楼右下', operations: [{ capability: 'production.rally', params: { regionName: '三楼右下' } }] }), model: 'fixture', durationMs: 0 }
  } }
  const executor = new StepExecutor(), controller = new ProgramController({ runtime: f.runtime, executor, provider: () => provider as never })
  const ctx = { runtime: f.runtime, formations: f.formations, currentProvider: () => provider, bridge: { ...bridge, rules: async (name: string, type: number) => nativeRules(name, type) }, controller } as unknown as CommandContext
  try {
    const text = await runTranscript('全部重工集结到三楼右下', ctx, root)
    assert.equal(requests, 1)
    assert.match(text, /指令已提交至三楼右下/)
    assert.deepEqual(f.submitted.map(action => action.kind), ['setRallyPoint', 'setRallyPoint'])
    assert.deepEqual(f.submitted.flatMap(action => 'unitIds' in action ? action.unitIds : []), [100, 101])
    assert.ok(f.runtime.factoryRallies.state.settings.every(setting => setting.source === 'player' && setting.commandId))
    activate(f.runtime, production()); await f.tick(300)
    assert.equal(f.submitted.length, 2, '后来的造车指令不重置玩家指定位置')
  } finally { await executor.dispose(); rmSync(root, { recursive: true, force: true }) }
})

test('同局恢复不重设集结点；无字段旧状态兼容，未知提交不盲目覆盖，换局丢弃设置', async () => {
  const f = await fixture()
  activate(f.runtime, production()); await f.tick()
  const state = persistState(f.runtime)
  const h = await fixture()
  restoreState(h.runtime, state)
  await h.tick(300)
  assert.deepEqual(h.submitted, [])
  const explicit = await h.runtime.factoryRallies.configure([100], { x: 70, y: 70 }, 'voice', () => {})
  assert.equal(explicit[0]!.status, 'submitted')
  const unknown = persistState(h.runtime); unknown.factoryRallies!.settings[0]!.status = 'prepared'
  const u = await fixture(); restoreState(u.runtime, unknown); await u.tick(300)
  assert.deepEqual(u.submitted, [])
  assert.ok(u.runtime.factoryRallies.state.settings.some(setting => setting.status === 'unknown'))
  const old = await fixture(); const oldState = persistState(f.runtime); delete oldState.factoryRallies
  restoreState(old.runtime, oldState); await old.tick(300)
  assert.equal(old.submitted.length, 2)
  await h.runtime.onSnapshot(snapshot({ sessionKey: 'new-battle', self: [building(100)], seq: 1 }))
  assert.deepEqual(h.runtime.factoryRallies.state, { enabled: false, settings: [] })
})

test('未知／不可用地形有限尝试后留原因；暂停不设置，销毁的建筑记录清理', async () => {
  const h = await harness(undefined, { factorySites: sites, rallyTiles: async () => [] })
  await h.runtime.onSnapshot(snapshot({ seq: 2, self: [building(100)] }))
  activate(h.runtime, production())
  h.runtime.pause('global')
  await h.runtime.onSnapshot({ ...h.runtime.snapshot!, seq: 3, tick: 60 })
  assert.equal(h.runtime.factoryRallies.state.settings.length, 0)
  h.runtime.resume('global')
  for (let i = 0; i < 6; i++) await h.runtime.onSnapshot({ ...h.runtime.snapshot!, seq: 4 + i, tick: 100 + i * 160 })
  assert.deepEqual(h.submitted, [])
  assert.equal(h.runtime.factoryRallies.state.settings[0]!.attempts, 3)
  assert.match(h.runtime.factoryRallies.state.settings[0]!.reason!, /没有已知可用/)
  await h.runtime.onSnapshot({ ...h.runtime.snapshot!, self: [], seq: 20, tick: 2000 })
  assert.equal(h.runtime.factoryRallies.state.settings.length, 0)
})

test('选点期间改令、停止或换局使旧自动设置失效；玩家位置不会被迟到结果覆盖', async () => {
  const entered = deferred<void>(), release = deferred<void>()
  let query = 0
  const h = await harness(undefined, { factorySites: sites, rallyTiles: async points => {
    if (query++ === 0) { entered.resolve(); await release.promise }
    return tiles(points)
  } })
  await h.runtime.onSnapshot(snapshot({ seq: 2, self: [building(100)] }))
  activate(h.runtime, production())
  const pending = h.runtime.onSnapshot({ ...h.runtime.snapshot!, seq: 3, tick: 60 })
  await entered.promise
  await h.runtime.factoryRallies.configure([100], { x: 70, y: 70 }, 'later', () => {})
  release.resolve(); await pending
  assert.deepEqual(h.submitted, [{ kind: 'setRallyPoint', unitIds: [100], x: 70, y: 70 }])
  const cancelled = await fixture()
  let stale = false
  await assert.rejects(cancelled.runtime.factoryRallies.configure([100], { x: 70, y: 70 }, 'stopped', () => { if (stale) throw new Error('已停止'); stale = true }), /已停止/)
  assert.deepEqual(cancelled.submitted, [])
})

test('设置集结点只接受指定己方建筑；缺少几何可显式指定，不用猜测默认位置', async () => {
  const snap = snapshot({ self: [building(100), { ...building(101, 'MTNK'), type: 7 }] })
  const constraints = { allowedUnitIds: [100, 101], factoryRallyIds: [100], allowedActions: ['setRallyPoint' as const], enemyIds: [], mapWidth: 100, mapHeight: 100 }
  assert.equal(validateActions([{ kind: 'setRallyPoint', unitIds: [100], x: 50, y: 50 }], constraints, snap), undefined)
  assert.match(validateActions([{ kind: 'setRallyPoint', unitIds: [101], x: 50, y: 50 }], constraints, snap)!, /己方生产建筑/)
  assert.match(validateActions([{ kind: 'setRallyPoint', unitIds: [100], x: 100, y: 50 }], constraints, snap)!, /坐标非法/)
  const site: FactorySite = { id: 100, name: 'GAWEAP', x: 20, y: 20, factory: 3 }
  const h = await harness(undefined, { factorySites: async () => [site], rallyTiles: tiles })
  await h.runtime.onSnapshot(snapshot({ seq: 2, self: [building(100)] }))
  const missing = await h.runtime.factoryRallies.configure([100], undefined, 'auto-position', () => {})
  assert.equal(missing[0]!.status, 'failed')
  assert.match(missing[0]!.reason!, /缺少可靠/)
  const result = await h.runtime.factoryRallies.configure([100], { x: 50, y: 50 }, 'explicit', () => {})
  assert.equal(result[0]!.status, 'submitted')
})
