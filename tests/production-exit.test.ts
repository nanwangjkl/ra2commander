import test from 'node:test'
import assert from 'node:assert/strict'
import type { SnapshotUnit } from '../packages/contracts/src/index.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { FormationRegistry, persistState, restoreState, type FactorySite } from '../packages/runtime/src/index.ts'
import { activate, harness, snapshot, production, deferred } from './helpers.ts'

const source = `function step(s,m){const actions=[];for(const g of s.control.goals){const c=s.constraints.goals[g.spec.id];if(g.spec.kind==='production'&&c.management&&c.management.allowedUnitIds.length){actions.push({goalId:g.spec.id,request:{kind:c.management.kind,formationId:c.management.formationId,unitIds:c.management.allowedUnitIds}})}}return {actions,memory:m}}`
const unit = (id: number, name: string, rx: number, ry: number, type = 7, isIdle = false): SnapshotUnit => ({ id, name, type, rx, ry, elevation: 0, isIdle, harvester: name === 'HARV', naval: false })
const buildings = [unit(3226, 'NAWEAP', 147, 122, 2, true), unit(3214, 'NAHAND', 148, 118, 2, true)]
const sites = async (snap: ReturnType<typeof snapshot>): Promise<FactorySite[]> => snap.self.filter(unit => unit.type === 2).map(unit => ({ id: unit.id, name: unit.name, x: unit.rx, y: unit.ry, elevation: 0, foundation: unit.name === 'NAWEAP' ? { width: 5, height: 3 } : { width: 2, height: 2 }, factory: unit.name === 'NAWEAP' ? 3 : 2 }))
const tiles = async (points: Array<{ x: number; y: number }>) => points.map(point => ({ ...point, z: 0, landType: 0 }))
async function fixture() {
  const executor = new StepExecutor()
  const h = await harness(executor, { formations: new FormationRegistry(), factorySites: sites, rallyTiles: tiles })
  let time = 0, seq = 2, own = [...buildings]
  await h.runtime.onSnapshot(snapshot({ seq, time, mapWidth: 200, mapHeight: 200, self: own }))
  const tick = async (members = own, seconds = 0.5) => { own = members; time += seconds; await h.runtime.onSnapshot({ ...h.runtime.snapshot!, seq: ++seq, tick: Math.round(time * 30) + 15, time, self: own }) }
  const queue = (name = 'HTNK', quantity = 1, id = 'tanks') => {
    activate(h.runtime, production({ id, target: name, targetType: name === 'E2' ? 3 : 7, quantity, formationId: '1队' }), source)
    h.runtime.production.push({ id: `${id}-record`, goalId: id, name, quantity, building: false, queueType: name === 'E2' ? 2 : 3, state: 'submitted', observedIds: [], placed: false })
  }
  return { ...h, tick, queue, dispose: () => executor.dispose(), own: () => own }
}

test('复现最新反馈：坦克出现及离开厂房均不编队，抵达集结点以后才交接停车', async () => {
  const f = await fixture()
  try {
    f.queue('HTNK', 2); await f.tick()
    const point = f.runtime.factoryRallies.state.settings.find(setting => setting.factoryId === 3226)!.point!
    const first = unit(3243, 'HTNK', 149, 123)
    await f.tick([...buildings, first])
    assert.equal(f.runtime.production[0]!.observedIds[0], 3243)
    assert.equal(f.formations.ownerOf(3243), undefined)
    assert.ok(!f.submitted.some(action => action.kind === 'stop'))
    assert.equal(f.runtime.goalExecution('tanks')!.state, 'pending')
    await f.tick([...buildings, { ...first, rx: 153 }])
    assert.equal(f.formations.ownerOf(3243), undefined, '只是离开建筑还不够，必须抵达集结点')
    await f.tick([...buildings, { ...first, rx: point.x, ry: point.y, isIdle: true }])
    assert.equal(f.formations.ownerOf(3243), '1队')
    assert.deepEqual(f.submitted.filter(action => action.kind === 'stop'), [{ kind: 'stop', unitIds: [3243] }])
    assert.equal(f.runtime.production[0]!.quantity, 2)
    assert.ok(!f.submitted.some(action => action.kind === 'produce'), '卡住或已出现产物都不补造')
    const second = unit(3252, 'HTNK', 149, 123)
    await f.tick([...f.own(), second])
    assert.equal(f.formations.ownerOf(3252), undefined)
    assert.equal(f.runtime.goals.get('tanks')!.status, 'active')
    await f.tick(f.own().map(member => member.id === 3252 ? { ...member, rx: point.x + 1, ry: point.y, isIdle: true } : member))
    assert.equal(f.formations.ownerOf(3252), '1队')
    await f.tick()
    assert.equal(f.runtime.goals.get('tanks')!.status, 'completed')
  } finally { await f.dispose() }
})

test('坦克和步兵各自等待出生时的集结点；改建筑集结点只影响后来出生者，矿车保留原生采矿', async () => {
  const f = await fixture()
  try {
    f.queue(); f.queue('E2', 1, 'infantry'); await f.tick()
    const tankPoint = f.runtime.factoryRallies.state.settings.find(setting => setting.factoryId === 3226)!.point!
    const infantryPoint = f.runtime.factoryRallies.state.settings.find(setting => setting.factoryId === 3214)!.point!
    await f.tick([...buildings, unit(3243, 'HTNK', 149, 123), unit(3215, 'E2', 149, 119, 3), unit(3228, 'HARV', 149, 123)])
    assert.equal(f.formations.ownerOf(3215), undefined)
    assert.equal(f.runtime.productionExits.waiting(3228), false)
    await f.runtime.factoryRallies.configure([3226], { x: 170, y: 130 }, 'change-rally', () => {})
    assert.deepEqual(f.runtime.productionExits.state.units.find(job => job.unitId === 3243)!.point, tankPoint)
    await f.tick(f.own().map(member => member.id === 3215 ? { ...member, rx: infantryPoint.x, ry: infantryPoint.y, isIdle: true } : member))
    assert.equal(f.formations.ownerOf(3215), '1队')
    assert.equal(f.formations.ownerOf(3243), undefined)
    assert.ok(f.submitted.every(action => !('unitIds' in action) || !action.unitIds.includes(3228)))
  } finally { await f.dispose() }
})

test('工厂中心持续无位移时先疏散实际挡路单位；到点后才放行，不影响采矿等专用流程', async () => {
  const f = await fixture()
  try {
    f.queue(); await f.tick()
    const born = unit(3243, 'HTNK', 149, 123), blocker = unit(600, 'HTNK', 152, 123, 7, true), harvester = unit(601, 'HARV', 152, 124, 7, true)
    await f.tick([...buildings, born, blocker, harvester])
    await f.tick(undefined, 2)
    assert.ok(!f.submitted.some(action => action.kind === 'move'))
    await f.tick(undefined, 1.1)
    const moves = f.submitted.filter(action => action.kind === 'move')
    assert.ok(moves.some(action => action.unitIds.includes(600)))
    assert.ok(moves.every(action => !action.unitIds.includes(601)))
    assert.ok(!f.submitted.some(action => action.kind === 'stop'))
    assert.equal(f.runtime.productionExits.state.blockages[0]!.state, 'clearing')
    const yieldOrder = f.runtime.productionExits.state.yields.find(order => order.unitId === 600)!
    await f.tick(f.own().map(member => member.id === 600 ? { ...member, rx: yieldOrder.point.x, ry: yieldOrder.point.y } : member.id === 3243 ? { ...member, rx: 153 } : member))
    assert.equal(f.runtime.productionExits.state.blockages[0]!.state, 'recovered')
    assert.equal(f.formations.ownerOf(3243), undefined)
    const point = f.runtime.productionExits.state.units.find(job => job.unitId === 3243)!.point!
    await f.tick(f.own().map(member => member.id === 3243 ? { ...member, rx: point.x, ry: point.y, isIdle: true } : member))
    assert.equal(f.formations.ownerOf(3243), '1队')
  } finally { await f.dispose() }
})

test('出厂和集结等待在同局重启后继续；不重算产量、不重设点、不重放停车或旧让路动作', async () => {
  const f = await fixture(), restored = await fixture()
  try {
    f.queue(); await f.tick()
    await f.tick([...buildings, unit(3243, 'HTNK', 149, 123)])
    const state = persistState(f.runtime)
    restoreState(restored.runtime, state)
    await restored.tick([...buildings, unit(3243, 'HTNK', 149, 123)], 0.5)
    assert.equal(restored.formations.ownerOf(3243), undefined)
    assert.equal(restored.submitted.length, 0)
    assert.deepEqual(restored.runtime.production[0]!.observedIds, [3243])
    const point = state.productionExits!.units[0]!.point!
    await restored.tick([...buildings, unit(3243, 'HTNK', point.x, point.y, 7, true)])
    assert.equal(restored.formations.ownerOf(3243), '1队')
    assert.ok(!restored.submitted.some(action => action.kind === 'produce' || action.kind === 'setRallyPoint'))
  } finally { await f.dispose(); await restored.dispose() }
})

test('出口疏通有次数上限；暂停冻结计时，明确停止后不自动恢复新造成员的移动', async () => {
  const f = await fixture()
  try {
    f.queue(); await f.tick(); await f.tick([...buildings, unit(3243, 'HTNK', 149, 123)])
    f.runtime.pause('global')
    await f.tick(undefined, 30)
    assert.ok(!f.submitted.some(action => action.kind === 'move'))
    f.runtime.resume('global'); await f.tick(undefined, 1)
    assert.ok(!f.submitted.some(action => action.kind === 'move'))
    for (let attempt = 0; attempt < 5; attempt++) await f.tick(undefined, 3.1)
    const block = f.runtime.productionExits.state.blockages[0]!
    assert.equal(block.attempts, 3)
    assert.equal(block.state, 'unresolved')
    assert.equal(f.submitted.filter(action => action.kind === 'move').length, 3)
    await f.runtime.stopUnits([3243]); await f.tick(undefined, 30)
    assert.equal(f.submitted.filter(action => action.kind === 'move').length, 3)
    assert.equal(f.formations.ownerOf(3243), undefined)
  } finally { await f.dispose() }
})

test('让路选点期间收到停止命令，迟到结果不移动成员，也不恢复旧任务', async () => {
  const entered = deferred<void>(), release = deferred<void>(), f = await fixture()
  try {
    f.queue(); await f.tick(); await f.tick([...buildings, unit(3243, 'HTNK', 149, 123), unit(600, 'HTNK', 152, 123, 7, true)])
    // 换成延迟的公开地形查询，复现查询与停止交错。
    const original = f.runtime.factoryRallies.point.bind(f.runtime.factoryRallies)
    f.runtime.factoryRallies.point = async (...args) => { entered.resolve(); await release.promise; return original(...args) }
    const pending = f.tick(undefined, 3.1)
    await entered.promise
    await f.runtime.stop('global')
    release.resolve(); await pending
    assert.ok(!f.submitted.some(action => action.kind === 'move'))
    assert.equal(f.runtime.productionExits.state.yields.length, 0)
  } finally { release.resolve(); await f.dispose() }
})

test('等待集结时新下攻击指令保留为 pending，不误报成员损失；到点交接后执行', async () => {
  const f = await fixture()
  try {
    f.queue(); await f.tick(); await f.tick([...buildings, unit(3243, 'HTNK', 149, 123)])
    assert.equal(f.runtime.plannedFormationOf(3243), '1队')
    const owner = f.runtime.upsertGoal({ id: 'attack-after-rally', kind: 'attack', executionMode: 'native', rawText: '所有坦克攻击敌人', formationId: '1队', unitIds: [3243], aircraftIds: [], preparationGoalIds: [], ammoCapacity: {}, targetKind: 'enemies', targetNames: [] })
    f.runtime.activateNativeGoals(owner)
    await f.tick()
    assert.equal(f.runtime.goals.get('attack-after-rally')!.status, 'active')
    assert.equal(f.runtime.goalExecution('attack-after-rally')!.state, 'pending')
    assert.ok(!f.submitted.some(action => action.kind === 'attack' || action.kind === 'stop'))
    const point = f.runtime.productionExits.state.units[0]!.point!
    await f.tick([...buildings, unit(3243, 'HTNK', point.x, point.y, 7, true)])
    await f.tick()
    assert.equal(f.formations.ownerOf(3243), '1队')
    assert.ok(f.submitted.some(action => action.kind === 'attack' && action.unitIds.includes(3243)))
  } finally { await f.dispose() }
})
