import test from 'node:test'
import assert from 'node:assert/strict'
import { loadIceMap } from '../apps/companion/src/map-binding.ts'
import { FormationRegistry, persistState, restoreState, type FactorySite, type PersistedState } from '../packages/runtime/src/index.ts'
import { ProductionExits, type ExitUnit } from '../packages/runtime/src/production-exit.ts'
import type { SnapshotUnit } from '../packages/contracts/src/index.ts'
import { harness, production, snapshot } from './helpers.ts'

const ice = await loadIceMap()
const clear = (point: { x: number; y: number }) => ice.obstacles.clear3x3(point.x, point.y) && [-1, 0, 1].every(dx => [-1, 0, 1].every(dy => ice.area.contains(point.x + dx, point.y + dy)))
const factory: FactorySite = { id: 3228, name: 'NAWEAP', x: 119, y: 86, factory: 3, foundation: { width: 5, height: 3 }, elevation: 6 }
const building: SnapshotUnit = { id: factory.id, name: factory.name, type: 2, rx: factory.x, ry: factory.y, isIdle: true, elevation: 6 }
const old = { x: 129, y: 86 }
const tiles = async (points: Array<{ x: number; y: number }>) => points.map(point => ({ ...point, z: 6, landType: 0 }))
const setting = () => ({ factoryId: factory.id, name: factory.name, origin: { x: factory.x, y: factory.y }, point: { ...old }, source: 'automatic' as const, status: 'submitted' as const, attempts: 1, tick: 15 })

test('默认、玩家指定、让路和生产前换点均避开同一份静态树石，黑幕不能绕过补丁', async () => {
  let fog = false
  const h = await harness(undefined, { formations: new FormationRegistry(), factorySites: async () => [factory], rallyTiles: points => fog ? Promise.resolve([]) : tiles(points), rallyClear: clear })
  await h.runtime.onSnapshot(snapshot({ seq: 2, mapWidth: 200, mapHeight: 200, self: [building] }))
  h.runtime.factoryRallies.state.enabled = true
  await h.runtime.onSnapshot({ ...h.runtime.snapshot!, seq: 3, tick: 45 })
  const automatic = h.runtime.factoryRallies.state.settings[0]!.point!
  assert.equal(clear(automatic), true)
  fog = true
  const [explicit] = await h.runtime.factoryRallies.configure([3228], old, 'rally', () => {})
  assert.equal(explicit!.status, 'submitted')
  assert.equal(clear(explicit!.point!), true)
  assert.notDeepEqual(explicit!.point, old)
  fog = false
  const yieldPoint = await h.runtime.factoryRallies.point(factory, [factory], h.runtime.snapshot!, [automatic])
  assert.ok(yieldPoint && clear(yieldPoint), '出口让路复用相同的开阔地检查')
  h.runtime.factoryRallies.state.settings = [setting()]
  assert.equal((await h.runtime.factoryRallies.beforeProduction(3, h.runtime.snapshot!, () => true)).ok, true)
  assert.equal(clear(h.runtime.factoryRallies.state.settings[0]!.point!), true)
})

test('同局恢复立即修正旧障碍点及待集结成员，不等待新生产、不召回就绪成员，准备与迁移同次保存', async () => {
  const members: SnapshotUnit[] = [[3230, 89, 152], [3245, 88, 153], [3232, 128, 89], [3238, 128, 88], [3250, 127, 87]].map(([id, rx, ry]) => ({ id: id!, name: 'HTNK', type: 7, rx: rx!, ry: ry!, isIdle: true }))
  const make = async (checkpoint = () => {}) => {
    const h = await harness(undefined, { formations: new FormationRegistry(), factorySites: async () => [factory], rallyTiles: tiles, rallyClear: clear, checkpoint })
    await h.runtime.onSnapshot(snapshot({ seq: 2, mapWidth: 200, mapHeight: 200, self: [building, ...members] }))
    return h
  }
  const before = await make()
  before.runtime.upsertGoal(production({ id: 'five', target: 'HTNK', quantity: 5 }))
  before.runtime.production.push({ id: 'batch', goalId: 'five', name: 'HTNK', quantity: 5, building: false, queueType: 3, state: 'submitted', observedIds: members.map(unit => unit.id), placed: false })
  before.runtime.factoryRallies.state.settings = [setting()]
  before.runtime.productionExits.state.units = members.map((unit, i): ExitUnit => ({ unitId: unit.id, name: unit.name, type: 7, born: { x: 121, y: 87 }, factoryId: factory.id, point: { ...old }, position: { x: unit.rx, y: unit.ry }, phase: i < 2 ? 'ready' : 'rallying', progressAt: 0, attempts: 3 }))
  const saved = persistState(before.runtime), checkpoints: PersistedState[] = []
  let restored: Awaited<ReturnType<typeof make>> | undefined
  restored = await make(() => { if (restored) checkpoints.push(persistState(restored.runtime)) })
  restoreState(restored.runtime, saved)
  await restored.runtime.onSnapshot({ ...restored.runtime.snapshot!, seq: 3, tick: 60, time: 2 })
  const next = restored.runtime.factoryRallies.state.settings[0]!.point!
  assert.notDeepEqual(next, old)
  assert.equal(clear(next), true)
  for (const job of restored.runtime.productionExits.state.units) {
    assert.deepEqual(job.point, [3230, 3245].includes(job.unitId) ? old : next)
    if (![3230, 3245].includes(job.unitId)) assert.equal(job.attempts, 0)
  }
  const prepared = checkpoints.find(state => state.factoryRallies!.settings[0]!.status === 'prepared')!
  assert.ok(prepared)
  assert.ok(prepared.productionExits!.units.filter(job => ![3230, 3245].includes(job.unitId)).every(job => job.phase !== 'ready' && job.point?.x === next.x && job.point.y === next.y))
  assert.equal(restored.runtime.production.length, 1)
  assert.equal(restored.runtime.production[0]!.quantity, 5)
  assert.deepEqual(restored.runtime.production[0]!.observedIds, members.map(unit => unit.id))
  assert.equal(restored.submitted.filter(action => action.kind === 'setRallyPoint').length, 1)
  const redirects = restored.submitted.filter(action => action.kind === 'move')
  assert.deepEqual(redirects.flatMap(action => action.unitIds).sort(), [3232, 3238, 3250], '只同步未就绪成员，不召回已就绪单位')
  assert.ok(restored.submitted.every(action => ['setRallyPoint', 'move'].includes(action.kind)), '不重造、不交接停车')
  const sent = restored.submitted.length
  await restored.runtime.onSnapshot({ ...restored.runtime.snapshot!, seq: 4, tick: 90, time: 2.5 })
  assert.equal(restored.submitted.length, sent, '有效新点不周期重设，改点移动不重复补发')
})

test('四格到达容纳分散落位，但在移动、厂内或出口通道中仍等待；耗尽重试显示明确原因', () => {
  const store = new ProductionExits()
  const locations = [
    { x: 128, y: 88, idle: true, point: old, progress: 0 }, // 2.24 格，空闲
    { x: 128, y: 89, idle: false, point: old, progress: 0 }, // 3.16 格，已停稳
    { x: 129, y: 90, idle: true, point: old, progress: 0 }, // 四格
    { x: 128, y: 90, idle: true, point: old, progress: 0 }, // 四格之外
    { x: 125, y: 87, idle: true, point: { x: 128, y: 87 }, progress: 0 }, // 仍挡出口
    { x: 123, y: 87, idle: true, point: { x: 127, y: 87 }, progress: 0 }, // 仍在厂内
    { x: 128, y: 88, idle: false, point: old, progress: 5 }, // 尚未停稳
  ]
  const units: SnapshotUnit[] = locations.map((p, i) => ({ id: i + 1, name: 'HTNK', type: 7, rx: p.x, ry: p.y, isIdle: p.idle }))
  store.state.units = units.map((unit, i) => ({ unitId: unit.id, name: unit.name, type: 7, born: { x: 121, y: 87 }, factoryId: factory.id, point: locations[i]!.point, position: { x: unit.rx, y: unit.ry }, phase: 'rallying', progressAt: locations[i]!.progress, attempts: 3 }))
  store.observe(snapshot({ mapWidth: 200, mapHeight: 200, time: 5, self: [building, ...units] }), [factory], [], new Set(units.map(unit => unit.id)), [], new Set(), false)
  assert.deepEqual(store.state.units.filter(unit => unit.phase === 'ready').map(unit => unit.unitId), [1, 2, 3])
  assert.equal(store.state.units[3]!.detail, '集结受阻，重试已用尽')
})
