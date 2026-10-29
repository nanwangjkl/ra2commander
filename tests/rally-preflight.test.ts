import test from 'node:test'
import assert from 'node:assert/strict'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { FormationRegistry, persistState, type PersistedState, type TaskRuntime, type FactorySite } from '../packages/runtime/src/index.ts'
import type { SnapshotUnit, TargetRegion } from '../packages/contracts/src/index.ts'
import { activate, deferred, harness, production, snapshot } from './helpers.ts'

const script = `function step(s,m){const actions=[];for(const g of s.control.goals){if(g.spec.kind==='production'&&g.produceRemaining[g.spec.target]>0)actions.push({goalId:g.spec.id,request:{kind:'produce',name:g.spec.target,quantity:g.produceRemaining[g.spec.target]}})}return {actions,memory:m}}`
const building = (id: number, name: string, rx: number, ry: number): SnapshotUnit => ({ id, name, type: 2, rx, ry, isIdle: true, elevation: 0 })
const factory = building(100, 'GAWEAP', 20, 20)
const sites = async (snap: ReturnType<typeof snapshot>): Promise<FactorySite[]> => snap.self.filter(unit => unit.type === 2).map(unit => ({ id: unit.id, name: unit.name, x: unit.rx, y: unit.ry, elevation: 0, factory: unit.name === 'GAWEAP' ? 3 : 0, foundation: unit.name === 'GAWEAP' ? { width: 5, height: 3 } : { width: 2, height: 2 } }))
const tiles = async (points: Array<{ x: number; y: number }>) => points.map(point => ({ ...point, z: 0, landType: 0 }))

test('新建筑占据集结点后立即换点，旧产物先收到改点移动，再继续生产；就绪成员不召回', async () => {
  const executor = new StepExecutor()
  try {
    let current: TaskRuntime | undefined
    const checkpoints: PersistedState[] = []
    const h = await harness(executor, { formations: new FormationRegistry(), factorySites: sites, rallyTiles: tiles, checkpoint: () => { if (current) checkpoints.push(persistState(current)) } })
    current = h.runtime
    await h.runtime.onSnapshot(snapshot({ seq: 2, self: [factory] }))
    activate(h.runtime, production({ id: 'first', quantity: 2 }), script)
    await h.runtime.onSnapshot({ ...h.runtime.snapshot!, seq: 3, tick: 30, time: 1 })
    const oldPoint = h.runtime.factoryRallies.state.settings[0]!.point!
    const born: SnapshotUnit = { id: 500, name: 'MTNK', type: 7, rx: 22, ry: 21, isIdle: false, harvester: false }
    const ready = { ...born, id: 501, rx: oldPoint.x, ry: oldPoint.y, isIdle: true }
    await h.runtime.onSnapshot({ ...h.runtime.snapshot!, seq: 4, tick: 45, time: 1.5, self: [factory, born, ready] })
    assert.equal(h.runtime.productionExits.waiting(500), true)
    assert.equal(h.runtime.productionExits.waiting(501), false)
    const newBuilding = building(101, 'GAPOWR', oldPoint.x, oldPoint.y)
    activate(h.runtime, production({ id: 'second' }), script)
    const before = h.submitted.length
    await h.runtime.onSnapshot({ ...h.runtime.snapshot!, seq: 5, tick: 60, time: 2, self: [factory, born, { ...ready, rx: 40, ry: 40 }, newBuilding] })
    const next = h.runtime.factoryRallies.state.settings[0]!.point!
    assert.notDeepEqual(next, oldPoint)
    assert.ok(next.x < oldPoint.x - 1 || next.y < oldPoint.y - 1 || next.x >= oldPoint.x + 3 || next.y >= oldPoint.y + 3, '连同新建筑周围一格也要避开')
    assert.deepEqual(h.submitted.slice(before).map(action => action.kind), ['setRallyPoint', 'move', 'produce'])
    const redirected = h.submitted.slice(before).find(action => action.kind === 'move')!
    assert.deepEqual(redirected, { kind: 'move', unitIds: [500], ...next })
    assert.deepEqual(h.runtime.productionExits.state.units.find(unit => unit.unitId === 500)!.point, next)
    assert.deepEqual(h.runtime.productionExits.state.units.find(unit => unit.unitId === 501)!.point, oldPoint)
    assert.equal(h.runtime.production.length, 2)
    assert.equal(h.runtime.production[1]!.quantity, 1)
    const prepared = checkpoints.find(state => state.factoryRallies!.settings.some(setting => setting.factoryId === 100 && setting.status === 'prepared' && setting.point?.x === next.x && setting.point.y === next.y) && state.productionExits!.units.some(unit => unit.unitId === 500))!
    assert.deepEqual(prepared.productionExits!.units.find(unit => unit.unitId === 500)!.point, next, '准备状态与旧产物改点同次保存，崩溃恢复不会保留不可用旧点')
    assert.equal(prepared.production.length, 1, '换点提交之前尚未预占下一批产量')
  } finally { await executor.dispose() }
})

test('玩家指定的远处集结点被占用时，在原分区附近重选；临时停留单位不触发换点', async () => {
  let revealed = false
  const h = await harness(undefined, { formations: new FormationRegistry(), factorySites: sites, rallyTiles: async points => revealed ? tiles(points) : [] })
  await h.runtime.onSnapshot(snapshot({ seq: 2, self: [factory] }))
  const point = { x: 80, y: 80 }, region: TargetRegion = { id: 'remote', name: '远处分区', polygons: [{ outer: [[75, 75], [90, 75], [90, 90], [75, 90], [75, 75]], holes: [] }] }
  await h.runtime.factoryRallies.configure([100], point, 'player', () => {}, region)
  assert.equal((await h.runtime.factoryRallies.beforeProduction(3, h.runtime.snapshot!, () => true)).ok, true, '远处黑幕不作为已知堵塞而阻断生产')
  revealed = true
  await h.runtime.onSnapshot({ ...h.runtime.snapshot!, seq: 3, self: [factory, { id: 300, name: 'MTNK', type: 7, rx: 80, ry: 80, isIdle: true }] })
  const before = h.submitted.length
  assert.equal((await h.runtime.factoryRallies.beforeProduction(3, h.runtime.snapshot!, () => true)).ok, true)
  assert.equal(h.submitted.length, before, '不因单位驻留每次换点')
  await h.runtime.onSnapshot({ ...h.runtime.snapshot!, seq: 4, self: [factory, building(101, 'GAPOWR', 79, 79)] })
  assert.equal((await h.runtime.factoryRallies.beforeProduction(3, h.runtime.snapshot!, () => true)).ok, true)
  const setting = h.runtime.factoryRallies.state.settings[0]!
  assert.equal(setting.source, 'player')
  assert.equal(setting.region!.id, 'remote')
  assert.notDeepEqual(setting.point, point)
  assert.ok(Math.hypot(setting.point!.x - point.x, setting.point!.y - point.y) <= 8)
  assert.ok(setting.point!.x >= 75 && setting.point!.y >= 75)
})

test('入队前检查周围地形；没有开阔地时不预占额度、不堵住其他生产，恢复后只入队一次', async () => {
  let passable = false
  const executor = new StepExecutor()
  try {
    const h = await harness(executor, { formations: new FormationRegistry(), factorySites: sites, rallyTiles: async points => (await tiles(points)).map(tile => ({ ...tile, landType: passable ? 0 : 2 })) })
    await h.runtime.onSnapshot(snapshot({ seq: 2, self: [factory], production: { ...snapshot().production!, available: ['MTNK', 'NAPOWR'] } }))
    activate(h.runtime, production({ id: 'tank' }), script)
    activate(h.runtime, production({ id: 'power', target: 'NAPOWR', targetType: 2 }), script)
    await h.runtime.onSnapshot({ ...h.runtime.snapshot!, seq: 3, tick: 30 })
    assert.ok(!h.runtime.production.some(record => record.name === 'MTNK'))
    assert.equal(h.runtime.production.find(record => record.name === 'NAPOWR')!.state, 'submitted')
    assert.equal(h.runtime.goals.get('tank')!.facts.rallyBlocked, true)
    assert.equal(h.runtime.programs.get('global')!.stats.errors, 0)
    passable = true
    await h.runtime.onSnapshot({ ...h.runtime.snapshot!, seq: 4, tick: 45 })
    assert.equal(h.runtime.production.filter(record => record.name === 'MTNK').length, 1)
    assert.equal(h.runtime.goals.get('tank')!.facts.rallyBlocked, undefined)
    assert.equal(h.runtime.production.filter(record => record.name === 'NAPOWR').length, 1)
  } finally { await executor.dispose() }
})

test('复查所有同类重工；周围出现岩石也换点，取消能使迟到的检查失效', async () => {
  const entered = deferred<void>(), release = deferred<void>()
  let delay = false, rejectNeighbour: { x: number; y: number } | undefined
  const h = await harness(undefined, { formations: new FormationRegistry(), factorySites: sites, rallyTiles: async points => {
    if (delay) { entered.resolve(); await release.promise }
    return (await tiles(points)).map(tile => ({ ...tile, landType: rejectNeighbour && tile.x === rejectNeighbour.x && tile.y === rejectNeighbour.y ? 2 : 0 }))
  } })
  const second = building(101, 'GAWEAP', 40, 20)
  await h.runtime.onSnapshot(snapshot({ seq: 2, self: [factory, second] }))
  await h.runtime.factoryRallies.configure([100], { x: 30, y: 30 }, 'one', () => {})
  await h.runtime.factoryRallies.configure([101], { x: 50, y: 30 }, 'two', () => {})
  rejectNeighbour = { x: 51, y: 30 }
  assert.equal((await h.runtime.factoryRallies.beforeProduction(3, h.runtime.snapshot!, () => true)).ok, true)
  assert.deepEqual(h.runtime.factoryRallies.state.settings.find(setting => setting.factoryId === 100)!.point, { x: 30, y: 30 })
  assert.notDeepEqual(h.runtime.factoryRallies.state.settings.find(setting => setting.factoryId === 101)!.point, { x: 50, y: 30 })
  let valid = true
  delay = true
  const before = h.submitted.length
  const pending = h.runtime.factoryRallies.beforeProduction(3, h.runtime.snapshot!, () => valid)
  await entered.promise; valid = false; release.resolve()
  await assert.rejects(pending, /已失效/)
  assert.equal(h.submitted.length, before)
})
