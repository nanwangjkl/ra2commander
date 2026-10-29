import test from 'node:test'
import assert from 'node:assert/strict'
import { placementDirection, type ActionRequest, type PlacementDirection, type SnapshotUnit } from '../packages/contracts/src/index.ts'
import { loadPrompts } from '../packages/command/src/index.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { FormationRegistry, persistState, restoreState } from '../packages/runtime/src/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { executeCapabilities } from '../apps/companion/src/capabilities/index.ts'
import { GameCatalog } from '../apps/companion/src/game-catalog.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { harness, snapshot } from './helpers.ts'
import { observeProduction } from '../packages/runtime/src/production-progress.ts'
import type { ProductionRecord } from '../packages/runtime/src/state.ts'

const source = `function step(s,m){const actions=[];for(const g of s.control.goals){if(g.blocked)continue;const p=g.spec;if(p.kind!=='production')continue;for(const name of g.productionPlan.readyToPlace)actions.push({goalId:p.id,request:{kind:'place',name}});for(const name of g.productionPlan.availableToProduce)actions.push({goalId:p.id,request:{kind:'produce',name,quantity:1}});}return{actions,memory:m}}`
const base: SnapshotUnit = { id: 100, name: 'GACNST', type: 2, rx: 50, ry: 50, elevation: 0, isIdle: true }
const building = (id: number, name: string, x: number, y: number): SnapshotUnit => ({ ...base, id, name, rx: x, ry: y })
const queue = (type: number, name?: string) => ({ type, status: name ? 3 : 0, size: name ? 1 : 0, maxSize: 1, items: name ? [{ name, quantity: 1, progress: 1, creditsEach: 1, creditsSpent: 1 }] : [] })
async function fixture() {
  const executor = new StepExecutor(), submitted: ActionRequest[] = []
  let blockCannon = false, placementFailure = 'no-spot'
  const { runtime } = await harness(executor, { formations: new FormationRegistry(), submit: async (actions, ctx, guard) => {
    if (!guard()) return []
    submitted.push(...actions)
    return actions.map(action => action.kind === 'place' && action.name === 'GTGCAN' && blockCannon ? { ok: false, reason: placementFailure, submitted: 0, session: ctx.session } : { ok: true, submitted: 1, session: ctx.session })
  } })
  await runtime.onSnapshot(snapshot({ seq: 2, self: [base], production: { ...snapshot().production!, available: ['GTGCAN', 'GAPOWR'], queues: [queue(0), queue(1)] } }))
  const prompts = loadPrompts(), catalog = new GameCatalog([
    { name: 'GACNST', type: 2, power: 0, available: false, factions: [], aliases: ['基地'], roles: ['constructionYard'] },
    { name: 'GTGCAN', type: 2, power: -100, available: true, factions: [], aliases: ['巨炮'], roles: [] },
    { name: 'GAPOWR', type: 2, power: 200, available: true, factions: [], aliases: ['电厂'], roles: ['powerPlant'] },
  ], runtime.snapshot!, prompts.game)
  const controller = new ProgramController({ runtime, executor, provider: () => ({ generate: async () => ({ text: source, model: 'fixture', durationMs: 0 }) }) as never,
    prepare: async goals => goals.map(goal => goal.kind === 'production' ? { ...goal, targetType: 2, queueTypes: { GTGCAN: 1, GAPOWR: 0 } } : goal) })
  const ctx = { runtime, formations: runtime.formations, controller, bridge: {} } as unknown as CommandContext
  const tick = (self = runtime.snapshot!.self, ready: string[] = []) => runtime.onSnapshot({ ...runtime.snapshot!, self, seq: runtime.snapshot!.seq + 1, tick: runtime.snapshot!.tick + 15, production: { ...runtime.snapshot!.production!, queues: [queue(0, ready.find(name => name === 'GAPOWR')), queue(1, ready.find(name => name === 'GTGCAN'))] } })
  const run = (directions?: PlacementDirection[], quantity = 3) => executeCapabilities([
    { capability: 'production.produce', params: { target: 'GTGCAN', quantity, ...(directions ? { placementDirections: directions, placementAnchor: '基地' } : {}) } },
    { capability: 'production.produce', params: { target: 'GAPOWR', quantity: 3 } },
  ], ctx, { text: directions ? '在基地上方，左边和下边各造一个巨炮，补3个电厂' : '造三个巨炮，补三个电厂', prompts, catalog })
  return { runtime, executor, submitted, tick, run, block: (value: boolean, reason = 'no-spot') => { blockCannon = value; placementFailure = reason } }
}

test('回放巨炮位置反馈：保留上左下三座要求，电厂无位置；真实落地推进，恢复不重置方位或生产', async () => {
  const f = await fixture()
  try {
    const execution = await f.run(['up', 'left', 'down'])
    assert.deepEqual(execution.skipped, [])
    const cannon = execution.goals[0]!, power = execution.goals[1]!
    assert.ok(cannon.kind === 'production' && power.kind === 'production')
    assert.deepEqual(cannon.placement!.directions, ['up', 'left', 'down'])
    assert.equal(power.placement, undefined)
    await f.tick()
    await f.tick(undefined, ['GTGCAN', 'GAPOWR'])
    let placements = f.submitted.filter(action => action.kind === 'place')
    assert.equal(placements.find(action => action.name === 'GTGCAN')!.placement!.direction, 'up')
    assert.equal(placements.find(action => action.name === 'GAPOWR')!.placement, undefined)
    await f.tick([base, building(101, 'GTGCAN', 46, 46), building(102, 'GAPOWR', 52, 50)])
    assert.equal(f.runtime.goalExecution(cannon.id)!.progress!.completed, 1)
    const saved = persistState(f.runtime), restored = await harness(f.executor, { formations: new FormationRegistry() })
    await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 1 })
    restoreState(restored.runtime, saved)
    const oldRecords = f.runtime.production.length
    await f.tick(undefined, ['GTGCAN', 'GAPOWR'])
    placements = f.submitted.filter(action => action.kind === 'place')
    assert.equal(placements.filter(action => action.name === 'GTGCAN').at(-1)!.placement!.direction, 'left')
    assert.equal(f.runtime.production.length, oldRecords)
    const latest = { ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 2 }
    await restored.runtime.onSnapshot(latest)
    assert.equal(restored.submitted.some(action => action.kind === 'produce'), false)
    const restoredPlace = restored.submitted.find(action => action.kind === 'place' && action.name === 'GTGCAN')
    assert.ok(restoredPlace?.kind === 'place')
    assert.equal(restoredPlace.placement!.direction, 'left')
    await f.tick([...f.runtime.snapshot!.self, building(103, 'GTGCAN', 46, 54), building(104, 'GAPOWR', 54, 50)])
    await f.tick(undefined, ['GTGCAN', 'GAPOWR'])
    placements = f.submitted.filter(action => action.kind === 'place')
    assert.equal(placements.filter(action => action.name === 'GTGCAN').at(-1)!.placement!.direction, 'down')
    await f.tick([...f.runtime.snapshot!.self, building(105, 'GTGCAN', 54, 54), building(106, 'GAPOWR', 56, 50)])
    assert.equal(f.runtime.goalExecution(cannon.id)!.state, 'completed')
    assert.equal(f.runtime.goalExecution(power.id)!.state, 'completed')
    assert.equal(f.submitted.filter(action => action.kind === 'produce' && action.name === 'GTGCAN').length, 3)
  } finally { await f.executor.dispose() }
})

test('未提方位沿用默认选址；方位受阻仍重试并推进电厂，位置错误不误报完成也不补造', async () => {
  const ordinary = await fixture(), directed = await fixture()
  try {
    const defaultExecution = await ordinary.run()
    assert.ok(defaultExecution.goals.every(goal => goal.kind === 'production' && !goal.placement))
    await ordinary.tick(); await ordinary.tick(undefined, ['GTGCAN'])
    assert.equal(ordinary.submitted.find(action => action.kind === 'place')!.placement, undefined)
    const execution = await directed.run(['up'], 1), id = execution.goals[0]!.id
    directed.block(true)
    await directed.tick(); await directed.tick(undefined, ['GTGCAN', 'GAPOWR'])
    assert.equal(directed.runtime.goalExecution(id)!.state, 'blocked')
    assert.match(directed.runtime.goalExecution(id)!.detail!, /上方.*暂无合法位置/)
    assert.ok(directed.submitted.some(action => action.kind === 'place' && action.name === 'GAPOWR'))
    for (const reason of ['no-spot', 'building-spacing', 'placement-footprint-unavailable:GTGCAN']) {
      directed.block(true, reason)
      const attempts = directed.submitted.filter(action => action.kind === 'place' && action.name === 'GTGCAN').length
      await directed.tick(undefined, ['GTGCAN'])
      assert.equal(directed.submitted.filter(action => action.kind === 'place' && action.name === 'GTGCAN').length, attempts + 1)
      assert.equal(directed.runtime.goalExecution(id)!.state, 'blocked')
      assert.equal(directed.runtime.programs.get('global')!.status, 'active')
    }
    directed.block(false)
    await directed.tick(undefined, ['GTGCAN'])
    await directed.tick([base, building(101, 'GTGCAN', 54, 54)]) // 模拟外部实际落点与指定方向不同。
    assert.equal(directed.runtime.goalExecution(id)!.state, 'partial')
    assert.match(directed.runtime.goalExecution(id)!.detail!, /按指定方位建成0座/)
    assert.equal(directed.submitted.filter(action => action.kind === 'produce' && action.name === 'GTGCAN').length, 1)
  } finally { await ordinary.executor.dispose(); await directed.executor.dispose() }
})

test('画面方位使用等距投影和真实高差，地图轴不直接充当屏幕方向', () => {
  const anchor = { x: 50, y: 50, elevation: 0 }
  assert.equal(placementDirection(anchor, { x: 46, y: 46 }), 'up')
  assert.equal(placementDirection(anchor, { x: 46, y: 54 }), 'left')
  assert.equal(placementDirection(anchor, { x: 54, y: 54 }), 'down')
  assert.equal(placementDirection(anchor, { x: 54, y: 46 }), 'right')
  assert.equal(placementDirection(anchor, { x: 50, y: 50, elevation: 3 }), 'up')
})

test('同一批排队三座建筑也逐座取方位，第一座落地不能跳过剩余放置', () => {
  const record: ProductionRecord = { id: 'batch', goalId: 'cannon', name: 'GTGCAN', quantity: 3, building: true, state: 'submitted', observedIds: [], placed: false, placement: { anchor: { x: 50, y: 50 }, directions: ['up', 'left', 'down'] } }
  const seen = new Set<number>(), born = [building(101, 'GTGCAN', 46, 46), building(102, 'GTGCAN', 46, 54), building(103, 'GTGCAN', 54, 54)]
  for (let n = 0; n < born.length; n++) {
    observeProduction([record], seen, snapshot({ self: born.slice(0, n + 1) }), new Set())
    assert.equal(record.placed, n === 2)
  }
  assert.ok(record.placementResults!.every(result => result.matched))
})
