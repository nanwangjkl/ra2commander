import test from 'node:test'
import assert from 'node:assert/strict'
import type { ActionRequest, ActionResult, SnapshotUnit } from '../packages/contracts/src/index.ts'
import { FormationRegistry, persistState, restoreState } from '../packages/runtime/src/index.ts'
import { activate, harness, outcome, production, snapshot } from './helpers.ts'

const factory: SnapshotUnit = { id: 3237, name: 'NAWEAP', type: 2, rx: 82, ry: 38, elevation: 0, isIdle: true }
const oldPoint = { x: 92, y: 39 }
const plant: SnapshotUnit = { id: 3247, name: 'NAPOWR', type: 2, rx: 91, ry: 38, elevation: 0, isIdle: true }
const born = (id: number, ready = false): SnapshotUnit => ({ id, name: 'HTNK', type: 7, rx: ready ? oldPoint.x : 84, ry: 39, isIdle: ready, elevation: 0 })
const readyProduction = { ...snapshot().production!, queues: [{ type: 0, status: 3, size: 1, maxSize: 1, items: [{ name: 'NAPOWR', quantity: 1, progress: 1, creditsEach: 600, creditsSpent: 600 }] }] }
const overlaps = (point: { x: number; y: number }) => point.x >= 90 && point.x <= 93 && point.y >= 37 && point.y <= 40

async function fixture() {
  const submitted: ActionRequest[] = [], placed: ActionRequest[] = []
  const options = { terrain: true, unknownRally: false, failMoves: false }
  const h = await harness({ run: async () => outcome([]) }, {
    formations: new FormationRegistry(), buildingFoundation: () => ({ width: 2, height: 2 }),
    factorySites: async snap => snap.self.filter(unit => unit.type === 2).map(unit => ({ id: unit.id, name: unit.name, x: unit.rx, y: unit.ry, elevation: 0, factory: unit.name === 'NAWEAP' ? 3 : 0, foundation: unit.name === 'NAWEAP' ? { width: 5, height: 3 } : { width: 2, height: 2 } })),
    rallyTiles: async points => options.terrain ? points.map(point => ({ ...point, z: 0, landType: 0 })) : [],
    submit: async (actions, snap, guard) => {
      if (!guard()) return []
      const results: ActionResult[] = []
      for (const action of actions) {
        submitted.push(structuredClone(action))
        if (action.kind === 'setRallyPoint' && options.unknownRally) throw new Error('模拟回执中断')
        if (action.kind === 'place') {
          if (action.rallyPoints?.some(overlaps)) { results.push({ ok: false, submitted: 0, reason: 'building-rally-conflict', session: snap.session, placement: { x: 91, y: 38, elevation: 0 } }); continue }
          placed.push(action)
        }
        results.push({ ok: !(options.failMoves && action.kind === 'move'), submitted: options.failMoves && action.kind === 'move' ? 0 : 1, session: snap.session })
      }
      return results
    },
  })
  await h.runtime.onSnapshot(snapshot({ seq: 2, time: 1, self: [factory], enemies: [] }))
  await h.runtime.factoryRallies.configure([factory.id], oldPoint, 'rally', () => {}, { id: 'right', name: '右侧', polygons: [{ outer: [[89, 34], [99, 34], [99, 47], [89, 47], [89, 34]], holes: [] }] })
  submitted.length = 0
  const tick = (self = h.runtime.snapshot!.self, seconds = 1, ready = false) => h.runtime.onSnapshot({ ...h.runtime.snapshot!, seq: h.runtime.snapshot!.seq + 1, tick: h.runtime.snapshot!.tick + Math.round(seconds * 30), time: h.runtime.snapshot!.time + seconds, self, ...(ready ? { production: readyProduction } : {}) })
  const tanks = async (count: number) => {
    activate(h.runtime, production({ id: 'tanks', target: 'HTNK', quantity: count, formationId: '1队' }))
    h.runtime.production.push({ id: 'tank-record', goalId: 'tanks', name: 'HTNK', quantity: count, building: false, queueType: 3, state: 'submitted', observedIds: [], placed: false })
    await tick([factory, ...Array.from({ length: count }, (_, i) => born(4000 + i, i === 0))])
  }
  const building = () => {
    activate(h.runtime, production({ id: 'power', target: 'NAPOWR', targetType: 2 }))
    h.runtime.production.push({ id: 'plant-record', goalId: 'power', name: 'NAPOWR', quantity: 1, building: true, queueType: 0, state: 'submitted', observedIds: [], placed: false })
  }
  return { ...h, submitted, placed, options, tick, tanks, building }
}

test('电厂必须占用原集结区时先换点，跨帧及重启保护所有未交接成员，已就绪者不召回', async () => {
  const f = await fixture()
  await f.tanks(8); f.building(); await f.tick(undefined, 1, true)
  assert.equal(f.placed.length, 0)
  const setting = f.runtime.factoryRallies.state.settings[0]!
  assert.notDeepEqual(setting.point, oldPoint)
  assert.equal(overlaps(setting.point!), false, '选新点时已将拟建电厂占地作为障碍')
  assert.equal(setting.region!.name, '右侧')
  assert.equal(f.runtime.productionExits.state.units.filter(job => job.redirectFrom).length, 7)
  assert.deepEqual(f.runtime.productionExits.state.units.find(job => job.unitId === 4000)!.point, oldPoint)
  const saved = persistState(f.runtime), restored = await fixture()
  await restored.runtime.onSnapshot(f.runtime.snapshot!)
  restoreState(restored.runtime, saved); restored.submitted.length = 0
  await restored.tick()
  assert.equal(restored.placed.length, 0, '超过单帧移动预算，最后一名未确认时旧点仍受保护')
  assert.equal(restored.runtime.productionExits.state.units.filter(job => job.redirectFrom).length, 1)
  await restored.tick()
  assert.equal(restored.placed.length, 1)
  const moves = restored.submitted.filter(action => action.kind === 'move')
  assert.equal(moves.length, 7)
  assert.ok(moves.every(action => !action.unitIds.includes(4000) && action.x === setting.point!.x && action.y === setting.point!.y))
  const lastMove = restored.submitted.filter(action => action.kind === 'move').at(-1)!
  const firstPlacement = restored.submitted.findIndex(action => action.kind === 'place' && !action.rallyPoints?.some(overlaps))
  assert.ok(firstPlacement > restored.submitted.indexOf(lastMove), '全部改点移动确认后才放置')
  assert.equal(restored.runtime.production.length, 2, '不重造、不增加目标生产数量')
})

test('无开阔替代点或换点回执未知时保留就绪建筑，不反复覆盖集结点或触发脚本故障', async () => {
  const f = await fixture()
  f.building(); f.options.terrain = false
  await f.tick(undefined, 1, true)
  assert.equal(f.placed.length, 0)
  assert.match(f.runtime.goalExecution('power')!.detail!, /开阔集结点|保留就绪建筑/)
  assert.ok(!f.submitted.some(action => action.kind === 'setRallyPoint'))
  f.options.terrain = true; f.options.unknownRally = true
  await f.tick()
  assert.equal(f.runtime.factoryRallies.state.settings[0]!.status, 'unknown')
  assert.deepEqual(f.runtime.factoryRallies.state.settings[0]!.relocatedFrom, oldPoint)
  for (let n = 0; n < 3; n++) await f.tick(undefined, 5)
  assert.equal(f.submitted.filter(action => action.kind === 'setRallyPoint').length, 1)
  assert.equal(f.placed.length, 0)
  assert.equal(f.runtime.programs.get('global')!.status, 'active')
  assert.equal(f.runtime.production.length, 1)
  await f.runtime.factoryRallies.configure([factory.id], { x: 96, y: 45 }, 'explicit-retry', () => {})
  assert.deepEqual(f.runtime.factoryRallies.state.settings[0]!.relocatedFrom, oldPoint, '玩家显式改令也须保留尚未确认释放的原位置')
  await f.tick()
  assert.equal(f.placed.length, 0)
  assert.equal(f.submitted.filter(action => action.kind === 'setRallyPoint').length, 2, '只有显式改令再提交，不自动重发')
})

test('外部新建筑占点不等下次生产即复查；暂停不移动，改点失败有限重试且不召回已就绪者', async () => {
  const f = await fixture()
  await f.tanks(2)
  f.runtime.pause('global')
  await f.tick([...f.runtime.snapshot!.self, plant])
  assert.deepEqual(f.runtime.factoryRallies.state.settings[0]!.point, oldPoint)
  assert.ok(!f.submitted.some(action => action.kind === 'move'))
  f.options.failMoves = true; f.runtime.resume('global')
  await f.tick()
  assert.notDeepEqual(f.runtime.factoryRallies.state.settings[0]!.point, oldPoint)
  for (let n = 0; n < 4; n++) await f.tick(undefined, 4)
  const moves = f.submitted.filter(action => action.kind === 'move')
  assert.equal(moves.length, 3)
  assert.ok(moves.every(action => action.unitIds.length === 1 && action.unitIds[0] === 4001))
  const waiting = f.runtime.productionExits.state.units.find(job => job.unitId === 4001)!
  assert.equal(waiting.phase, 'exiting')
  assert.match(waiting.detail!, /重试已用尽/)
  assert.match(f.runtime.goalExecution('tanks')!.detail!, /改点.*重试已用尽/)
  assert.ok(f.runtime.factoryRallies.protectedPoints(f.runtime.snapshot!, f.runtime.productionExits.state.units).some(point => point.x === oldPoint.x && point.y === oldPoint.y))
})
