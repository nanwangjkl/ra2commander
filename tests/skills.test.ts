import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compileCommand, loadPrompts, PromptLoader, readPrompts } from '../packages/command/src/index.ts'
import { goalExecutionMode, type ExploreGoal, type SnapshotUnit } from '../packages/contracts/src/index.ts'
import { ExplorationStore, persistState, restoreState, type ExplorationMap, FormationRegistry } from '../packages/runtime/src/index.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { WerhdBridge } from '../packages/game-werhd/src/page-bridge.ts'
import { MapRegionIndex, loadRegionScheme, loadPlayableArea } from '../packages/maps/src/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { GameCatalog } from '../apps/companion/src/game-catalog.ts'
import { executeCapabilities } from '../apps/companion/src/capabilities/index.ts'
import { ExplorationObserver, prepareExploration } from '../apps/companion/src/exploration.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { activate, code, deferred, harness, outcome, production, snapshot, spec } from './helpers.ts'

const policy = { pointSpacing: 2, stallTicks: 30, maxStallsPerRegion: 2 }
function map(): ExplorationMap {
  return { id: 'test-map', mapId: 'ice', schemeId: 'test', schemeVersion: '1.0.0', width: 100, height: 100,
    regions: [{ id: 'left', name: '左区', cells: [1010, 1012, 1210, 1212] }, { id: 'right', name: '右区', cells: [1020, 1022, 1220, 1222] }], seen: [], impassable: [], cursor: 0 }
}
const explore = (id = 'explore'): ExploreGoal => ({ id, kind: 'explore', rawText: '探路', formationId: 'A', explorationId: id, policy })
function store() {
  const store = new ExplorationStore(), goal = explore()
  store.add(map(), goal.id, ['left', 'right'])
  return { store, goal }
}

test('Skill 索引、按需正文与新请求重载：已展开目标固定旧定义，错误依赖整套回退', () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-skill-prompts-'))
  try {
    cpSync(new URL('../prompts/', import.meta.url), join(root, 'prompts'), { recursive: true })
    cpSync(new URL('../skills/', import.meta.url), join(root, 'skills'), { recursive: true })
    const url = pathToFileURL(join(root, 'prompts/templates') + sep), loader = new PromptLoader(url), first = loader.load()
    assert.deepEqual(first.skills.parameters('探路', {}), { quantity: 3, memberSource: 'auto' })
    assert.deepEqual(first.skills.parameters('scout', { quantity: 5, memberSource: 'existing' }), { quantity: 5, memberSource: 'existing' })
    const document = first.skills.get('开图')!
    const goal = { ...explore(), skill: { runId: 'run', id: document.definition.id, version: document.definition.version, hash: document.hash, instructions: document.instructions } }
    assert.ok(first.render('interpret').includes('scout（探路'))
    assert.ok(!first.render('interpret').includes(document.instructions))
    assert.ok(!first.compileFor([production()]).includes(document.instructions))
    assert.ok(first.compileFor([goal]).includes(document.instructions))
    const file = join(root, 'skills/scout/SKILL.md'), source = readFileSync(file, 'utf8')
    writeFileSync(file, source + '\n新版探路行为说明。\n')
    const next = loader.load()
    assert.notEqual(next.version, first.version)
    assert.ok(next.skills.get('scout')!.instructions.includes('新版探路行为说明'))
    assert.ok(!next.compileFor([goal]).includes('新版探路行为说明'))
    writeFileSync(file, source.replace('map.explore', 'unknown.capability'))
    assert.equal(loader.load({ onFallback: () => {} }), next)
    assert.throws(() => readPrompts(url), /Skill 定义错误/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('探索分散成员并只按实际揭开格子计数，抵达落点不能当作区域完成', () => {
  const { store: cache, goal } = store()
  const snap = snapshot()
  cache.advance(goal, snap, [1, 2], false)
  const view = cache.view(goal)
  assert.equal(view.seen, 0)
  assert.equal(new Set(view.targets.map(target => target.regionId)).size, 2)
  const atTargets = view.targets.map(target => ({ ...snap.self[0]!, id: target.unitId, rx: target.x, ry: target.y }))
  cache.advance(goal, snapshot({ self: atTargets, tick: 20 }), [1, 2], false)
  assert.equal(cache.view(goal).seen, 0)
  cache.observe(map().id, { seen: [1010, 1020], impassable: [1020] })
  assert.equal(cache.view(goal).seen, 2)
  cache.observe(map().id, { seen: [], impassable: [] }) // 后续不可见不能清掉历史已揭开事实。
  assert.equal(cache.view(goal).seen, 2)
  cache.observe(map().id, { seen: map().regions.flatMap(region => region.cells), impassable: [] })
  assert.equal(cache.advance(goal, snap, [1], false)?.state, 'completed')
})

test('逐区达到 80% 才完成：全图平均达标时继续探索不足分区，已达标区释放落点', async () => {
  const cache = new ExplorationStore(), goal = { ...explore(), policy: { ...policy, coverageRatio: 0.8 } }
  const large = Array.from({ length: 10 }, (_, n) => 1010 + n), small = Array.from({ length: 5 }, (_, n) => 2020 + n)
  cache.add({ ...map(), regions: [{ id: 'large', name: '大区', cells: large }, { id: 'small', name: '小区', cells: small }] }, goal.id, ['large', 'small'])
  cache.advance(goal, snapshot(), [1, 2], false)
  assert.equal(cache.view(goal).targets.length, 2)
  cache.observe(map().id, { seen: [...large, ...small.slice(0, 2)], impassable: [] })
  assert.equal(cache.advance(goal, snapshot({ tick: 20 }), [1, 2], false), undefined)
  const view = cache.view(goal)
  assert.equal(view.seen / view.total, 0.8)
  assert.equal(view.regions.find(region => region.id === 'large')!.satisfied, true)
  assert.equal(view.regions.find(region => region.id === 'small')!.satisfied, false)
  assert.ok(view.targets.length > 0 && view.targets.every(target => target.regionId === 'small'))
  const { runtime } = await harness({ run: async () => outcome() })
  runtime.exploration.add({ ...map(), regions: [{ id: 'large', name: '大区', cells: large }, { id: 'small', name: '小区', cells: small }] }, goal.id, ['large', 'small'])
  runtime.exploration.observe(map().id, { seen: [...large, ...small.slice(0, 2)], impassable: [] })
  activate(runtime, goal)
  assert.deepEqual(runtime.goalExecution(goal.id)!.progress, { completed: 1, total: 2, label: '分区达标（每区≥80%）' })
  assert.match(runtime.goalExecution(goal.id)!.detail!, /小区 40%/)
  cache.observe(map().id, { seen: small.slice(2, 4), impassable: [] })
  assert.equal(cache.advance(goal, snapshot(), [1, 2], false)?.state, 'completed')
  assert.ok(cache.view(goal).seen < cache.view(goal).total)
  assert.deepEqual(cache.view(goal).targets, [])
})

test('55% 逐区下限精确达标；优先中心未知格子，再从中心向外展开', () => {
  const cache = new ExplorationStore(), goal = { ...explore(), policy: { ...policy, coverageRatio: 0.55, centerFirst: true } }
  const scope = { ...map(), regions: [
    { id: 'a', name: '甲区', cells: rectangleCells(20, 20, 29, 29) },
    { id: 'b', name: '乙区', cells: rectangleCells(50, 20, 59, 29) },
  ] }
  cache.add(scope, goal.id, ['a', 'b'])
  cache.advance(goal, snapshot(), [1, 2], false)
  const targets = cache.view(goal).targets
  assert.equal(targets.length, 2)
  assert.ok(targets.every(target => target.y >= 24 && target.y <= 25 && (target.regionId === 'a' ? target.x >= 24 && target.x <= 25 : target.x >= 54 && target.x <= 55)))
  const central = targets.find(target => target.regionId === 'a')!
  cache.observe(scope.id, { seen: [central.y * 100 + central.x], impassable: [] })
  cache.advance(goal, snapshot({ tick: 20 }), [1, 2], false)
  const next = cache.view(goal).targets.find(target => target.regionId === 'a')!
  assert.ok(Math.hypot(next.x - central.x, next.y - central.y) <= 1.5)
  const seenA = new Set([central.y * 100 + central.x, ...scope.regions[0]!.cells.filter(cell => cell !== central.y * 100 + central.x).slice(0, 54)])
  assert.equal(seenA.size, 55)
  cache.observe(scope.id, { seen: [...seenA, ...scope.regions[1]!.cells.slice(0, 54)], impassable: [] })
  assert.equal(cache.advance(goal, snapshot(), [1, 2], false), undefined)
  assert.equal(cache.view(goal).regions[0]!.satisfied, true) // 55/100 不得因浮点乘法向上误取为 56。
  assert.equal(cache.view(goal).regions[1]!.satisfied, false)
  cache.observe(scope.id, { seen: [scope.regions[1]!.cells[54]!], impassable: [] })
  assert.equal(cache.advance(goal, snapshot(), [1, 2], false)?.state, 'completed')
})

test('各区恰好 80% 即完成，选定分区独立判定，恢复保留捕获阈值', async () => {
  const goal = { ...explore(), policy: { ...policy, coverageRatio: 0.8 } }, scope = { ...map(), regions: map().regions.map(region => ({ ...region, cells: [...region.cells, region.cells[0]! + 1] })) }
  const cache = new ExplorationStore()
  cache.add(scope, goal.id, ['left', 'right'])
  cache.observe(scope.id, { seen: scope.regions.flatMap(region => region.cells.slice(0, 4)), impassable: [] })
  assert.equal(cache.advance(goal, snapshot(), [1], false)?.state, 'completed')
  assert.ok(cache.view(goal).regions.every(region => region.seen / region.total === 0.8))
  const selected = new ExplorationStore()
  selected.add(scope, goal.id, ['left'])
  selected.observe(scope.id, { seen: scope.regions[0]!.cells.slice(0, 4), impassable: [] })
  assert.equal(selected.advance(goal, snapshot(), [1], false)?.state, 'completed')
  const { runtime } = await harness({ run: async () => outcome() })
  runtime.exploration.add(scope, goal.id, ['left', 'right'])
  runtime.exploration.observe(scope.id, { seen: scope.regions.flatMap(region => region.cells.slice(0, 4)), impassable: [] })
  activate(runtime, goal)
  const saved = persistState(runtime), restored = await harness({ run: async () => outcome() }, { formations: new FormationRegistry() })
  restoreState(restored.runtime, saved)
  await restored.runtime.onSnapshot(snapshot({ seq: 2, tick: 30 }))
  assert.equal(restored.runtime.goals.get(goal.id)!.status, 'completed')
  assert.deepEqual(restored.runtime.goalExecution(goal.id)!.progress, { completed: 2, total: 2, label: '分区达标（每区≥80%）' })
})

function rectangleCells(x1: number, y1: number, x2: number, y2: number): number[] {
  const cells: number[] = []
  for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) cells.push(y * 100 + x)
  return cells
}

for (const mode of ['script', 'native'] as const) test(`${mode}：三名侦察成员并行分区，一名停住不耽误另两名绕路`, async () => {
  const executor = new StepExecutor()
  try {
    const { runtime, formations, submitted } = await harness(executor)
    formations.transfer([2, 3], 'A')
    const scope = { ...map(), regions: [
      { id: 'a', name: '甲区', cells: rectangleCells(20, 20, 35, 35) },
      { id: 'b', name: '乙区', cells: rectangleCells(45, 20, 60, 35) },
      { id: 'c', name: '丙区', cells: rectangleCells(20, 45, 35, 60) },
    ] }
    const goal = { ...explore(), executionMode: mode, policy: { ...policy, pointSpacing: 4, coverageRatio: 0.8, interiorMargin: 2, retryPasses: 1 } }
    runtime.exploration.add(scope, goal.id, ['a', 'b', 'c'])
    if (mode === 'native') runtime.activateNativeGoals(runtime.upsertGoal(goal))
    else activate(runtime, goal, source)
    await runtime.onSnapshot(snapshot({ seq: 2, tick: 30 }))
    const moves = submitted.filter(action => action.kind === 'move')
    assert.deepEqual(new Set(moves.flatMap(action => action.unitIds)), new Set([1, 2, 3]))
    const targets = runtime.exploration.view(goal).targets
    assert.equal(new Set(targets.map(target => target.regionId)).size, 3)
    for (const target of targets) {
      const cells = new Set(scope.regions.find(region => region.id === target.regionId)!.cells)
      assert.ok([-2, 2].every(dx => [-2, 2].every(dy => cells.has((target.y + dy) * 100 + target.x + dx))))
    }
    const later = snapshot({ seq: 3, tick: 80 })
    later.self = later.self.map(unit => [2, 3].includes(unit.id) ? { ...unit, rx: 3 } : unit) // 实际移动，但暂时远离终点。
    await runtime.onSnapshot(later)
    const progress = runtime.exploration.progress.get(goal.id)!
    assert.equal(progress.stalls[targets.find(target => target.unitId === 1)!.regionId], 1)
    assert.ok(targets.filter(target => target.unitId !== 1).every(target => !progress.stalls[target.regionId]))
    assert.equal(runtime.goals.get(goal.id)!.status, 'active')
  } finally { await executor.dispose() }
})

test('收尾对暂缓区换点、换成员重试；真实覆盖恢复后重新开放区域，仍受阻才结束', () => {
  const cache = new ExplorationStore(), goal = { ...explore(), policy: { ...policy, pointSpacing: 4, coverageRatio: 0.8, maxStallsPerRegion: 1, interiorMargin: 2, retryPasses: 1 } }
  const scope = { ...map(), regions: [{ id: 'area', name: '区域', cells: rectangleCells(20, 20, 45, 45) }] }
  cache.add(scope, goal.id, ['area'])
  cache.advance(goal, snapshot(), [1], false)
  const first = cache.view(goal).targets[0]!
  assert.equal(cache.advance(goal, snapshot({ tick: 60 }), [1, 2], false), undefined)
  const progress = cache.progress.get(goal.id)!, retry = cache.view(goal).targets[0]!
  assert.equal(progress.retryRounds!.area, 1)
  assert.equal(retry.unitId, 2)
  assert.ok(Math.abs(first.x - retry.x) > 2 || Math.abs(first.y - retry.y) > 2)
  cache.observe(scope.id, { seen: [scope.regions[0]!.cells.at(-1)!], impassable: [] })
  cache.advance(goal, snapshot({ tick: 70 }), [1, 2], false)
  assert.equal(progress.failureStreak!.area, 0)
  assert.equal(progress.retryRounds!.area, 0)
  let result
  for (let tick = 120; tick <= 600 && !result; tick += 60) result = cache.advance(goal, snapshot({ tick }), [1, 2], false)
  assert.equal(result?.state, 'partial')
  assert.match(result!.detail, /重试后/)
  assert.equal(cache.view(goal).regions[0]!.satisfied, false)
})

test('冰天雪地探索只计引擎范围内格子，收尾落点不再指向已知图外边缘', async () => {
  const { runtime } = await harness({ run: async () => outcome() })
  await runtime.onSnapshot(snapshot({ seq: 2, mapWidth: 200, mapHeight: 200 }))
  const index = await loadRegionScheme(new URL('../maps/ice/schemes/nanwang-0.1.0.json', import.meta.url))
  const area = await loadPlayableArea(new URL('../maps/ice/playable-area.json', import.meta.url), index.scheme.map)
  const ctx = { runtime, mapRegions: index, mapSessionKey: runtime.battleKey, mapPlayableArea: area } as CommandContext
  const goal = { ...explore(), policy: { ...policy, coverageRatio: 0.8, interiorMargin: 3, retryPasses: 1 } }
  await prepareExploration(ctx, goal.id, undefined, () => {})
  const progress = runtime.exploration.progress.get(goal.id)!, map = runtime.exploration.maps.get(progress.mapId)!
  const cells = new Set(map.regions.flatMap(region => region.cells))
  assert.equal(cells.has(54 * 200 + 54), false)
  assert.equal(cells.has(168 * 200 + 84), false)
  assert.equal(cells.has(56 * 200 + 56), true)
  runtime.exploration.advance(goal, runtime.snapshot!, [1, 2, 3], false)
  const view = runtime.exploration.view(goal)
  assert.equal(view.regions.length, 17)
  assert.equal(view.total, cells.size)
  assert.ok(view.targets.length === 3 && view.targets.every(target => area.contains(target.x, target.y)))
})

test('停滞换点后保留未探索并部分完成；等待首名成员与全灭结果区分', () => {
  const { store: cache, goal } = store()
  assert.equal(cache.advance(goal, snapshot({ self: [] }), [], true), undefined)
  cache.advance(goal, snapshot(), [1], false)
  const first = cache.view(goal).targets[0]!
  cache.advance(goal, snapshot({ tick: 60 }), [1], false)
  const next = cache.view(goal).targets[0]!
  assert.ok(first.x !== next.x || first.y !== next.y)
  let result
  for (const tick of [100, 140, 180, 220]) result = cache.advance(goal, snapshot({ tick }), [1], false) ?? result
  assert.equal(result?.state, 'partial')
  assert.equal(cache.view(goal).seen, 0)
  cache.observe(map().id, { seen: map().regions.flatMap(region => region.cells), impassable: [] })
  assert.equal(cache.view(goal).seen, 0) // 后续其他侦察不能改写结束时的成果。
  const paused = store()
  paused.store.advance(paused.goal, snapshot(), [1], false)
  paused.store.suspend(paused.goal.id, 15)
  paused.store.advance(paused.goal, snapshot({ tick: 2000 }), [1], false)
  assert.deepEqual(paused.store.progress.get(paused.goal.id)!.stalls, {})
  const other = store()
  other.store.advance(other.goal, snapshot(), [1], false)
  assert.equal(other.store.advance(other.goal, snapshot({ self: [] }), [], false)?.state, 'partial')
  const empty = store()
  assert.equal(empty.store.advance(empty.goal, snapshot({ self: [] }), [], false)?.state, 'failed')
})

test('地图读取有批次上限，未知与图外格子不计覆盖，桥上地块不因水面而被排除', async () => {
  const calls: number[] = []
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __ra2cSessionKey: 'battle-a', werhd: { map: {
    visible: (x: number) => { calls.push(x); return x !== 2 },
    tile: (x: number) => x === 3 ? undefined : { landType: x === 2 || x === 4 ? 9 : 7, onBridge: x === 1 },
  } } } })
  const bridge = new WerhdBridge({} as never)
  bridge.bindGameFrame({ isDetached: () => false, page: () => ({ isClosed: () => false }), evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg) } as never)
  try {
    assert.deepEqual(await bridge.readMapBatch([0, 1, 2, 3, 4], 100, 'battle-a'), { seen: [0, 1, 4], impassable: [0], ore: [4] })
    assert.equal(calls.length, 5)
    await assert.rejects(bridge.readMapBatch(new Array(257).fill(0), 100, 'battle-a'), /批次过大/)
    await assert.rejects(bridge.readMapBatch([0], 100, 'old-battle'), /对局已变化/)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

const source = `function step(s,m){const actions=[];for(const g of s.control.goals){const p=g.spec,c=s.constraints.goals[p.id];
 if(p.kind==='production'){if(g.unitIds.length&&c.management){actions.push({goalId:p.id,request:{kind:c.management.kind,formationId:p.formationId,unitIds:g.unitIds}})}else if(g.produceRemaining[p.target]>0){actions.push({goalId:p.id,request:{kind:'produce',name:p.target,quantity:g.produceRemaining[p.target]}})}}
 if(p.kind==='formation'&&g.unitIds.length){actions.push({goalId:p.id,request:{...p.request,unitIds:g.unitIds}})}
 if(p.kind==='explore'&&!g.blocked){for(const t of g.exploration.targets){if(g.unitIds.includes(t.unitId))actions.push({goalId:p.id,request:{kind:'move',unitIds:[t.unitId],x:t.x,y:t.y}})}}
 }return {actions,memory:m}}`
async function fixture(existing = false) {
  const executor = new StepExecutor(), initial = snapshot()
  const { runtime, formations, submitted } = await harness(executor)
  const dog = (id: number): SnapshotUnit => ({ id, name: 'ADOG', type: 3, rx: 5, ry: 5, isIdle: true })
  await runtime.onSnapshot({ ...initial, seq: 2, production: { ...initial.production!, available: [...initial.production!.available, 'ADOG'] }, self: existing ? [...initial.self, dog(11), dog(12)] : initial.self })
  const scheme = JSON.parse(readFileSync(new URL('../maps/ice/schemes/nanwang-0.1.0.json', import.meta.url), 'utf8'))
  scheme.regions = [{ id: 'test', name: '测试区', aliases: [], level: 1, labelPosition: [11, 11], polygons: [{ outer: [[10, 10], [25, 10], [25, 25], [10, 25], [10, 10]], holes: [] }] }]
  const prompts = loadPrompts(), catalog = new GameCatalog([{ name: 'ADOG', label: 'Attack Dog', type: 3, power: 0, available: true, factions: [], roles: ['scoutDog'], aliases: [] }], runtime.snapshot!, prompts.game)
  let generations = 0
  const controller = new ProgramController({ runtime, executor, provider: () => ({ generate: async () => { generations++; return { text: source, model: 'fixture', durationMs: 0 } } }) as never })
  const ctx = { runtime, formations, controller, mapRegions: new MapRegionIndex(scheme), mapSessionKey: runtime.battleKey, bridge: {} } as unknown as CommandContext
  const run = (params: Record<string, unknown> = {}) => executeCapabilities([{ capability: 'skill.run', params: { skillId: 'scout', ...params } }], ctx, { text: '探路', prompts, catalog, commandId: 'test-command' })
  const tick = (self = runtime.snapshot!.self) => runtime.onSnapshot({ ...runtime.snapshot!, self, tick: runtime.snapshot!.tick + 15, seq: runtime.snapshot!.seq + 1 })
  return { executor, runtime, formations, submitted, ctx, run, tick, dog, prompts, catalog, generations: () => generations }
}

test('探路展开固定生产与独立编队；首条狗交接后即可出发，同局恢复不重复下单', async () => {
  const f = await fixture()
  try {
    const execution = await f.run()
    assert.ok(execution.results.every(result => result.includes('已生效')), execution.results.join('\n'))
    const run = [...f.runtime.skillRuns.values()][0]!
    assert.ok(run.kind !== 'repair-vehicle' && run.kind !== 'cover')
    assert.equal(run.quantity, 3)
    assert.equal(run.commandId, 'test-command')
    assert.equal(f.generations(), 1, '只生成全局生产代码，侦察队不再请求模型')
    assert.equal(f.runtime.goals.get(run.exploreGoalId)!.spec.executionMode, 'native')
    assert.equal(f.runtime.programs.get(`formation:${run.formationId}`)!.script, undefined)
    await f.tick()
    assert.deepEqual(f.submitted.filter(action => action.kind === 'produce'), [{ kind: 'produce', name: 'ADOG', quantity: 3 }])
    await f.tick([...f.runtime.snapshot!.self, f.dog(100)])
    await f.tick()
    assert.equal(f.formations.ownerOf(100), run.formationId)
    assert.ok(f.submitted.some(action => action.kind === 'stop' && action.unitIds.includes(100)))
    assert.ok(f.submitted.some(action => action.kind === 'move' && action.unitIds.includes(100)))
    assert.equal(f.runtime.goals.get(run.preparationGoalId)!.status, 'active')
    assert.equal(run.status, 'exploring')
    const before = persistState(f.runtime)
    assert.equal(before.version, 4)
    const restored = await harness(f.executor, { formations: new FormationRegistry() })
    await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 1 })
    restoreState(restored.runtime, before)
    await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 2, tick: f.runtime.snapshot!.tick + 15 })
    assert.ok(restored.submitted.every(action => action.kind !== 'produce'))
    assert.equal(restored.runtime.skillRuns.get(run.id)!.hash, run.hash)
    assert.deepEqual(persistState(restored.runtime).exploration, before.exploration)
    const progress = f.runtime.exploration.progress.get(run.exploreGoalId)!
    const map = f.runtime.exploration.maps.get(progress.mapId)!
    let batches = 0
    const observer = new ExplorationObserver()
    f.ctx.bridge.readMapBatch = async cells => { batches++; assert.ok(cells.length <= 256); return { seen: cells, impassable: [] } }
    await observer.poll(f.ctx)
    assert.equal(batches, 1)
    assert.ok(map.seen.length > 0)
  } finally { await f.executor.dispose() }
})

test('探路编译验证后续成员转入，拦截只会首次建队的脚本并允许模型修正', async () => {
  const f = await fixture()
  let lease: ReturnType<typeof f.runtime.beginCompile> | undefined
  try {
    await f.run({ useExisting: false })
    lease = f.runtime.beginCompile('global')
    const frame = f.runtime.compileFrame(lease)
    const broken = `function step(s,m){const actions=[];for(const g of s.control.goals){const c=s.constraints.goals[g.spec.id];if(g.produceRemaining[g.spec.target]>0)actions.push({goalId:g.spec.id,request:{kind:'produce',name:g.spec.target,quantity:g.produceRemaining[g.spec.target]}});if(c.management.kind==='createFormation'&&g.unitIds.length)actions.push({goalId:g.spec.id,request:{kind:'createFormation',formationId:g.spec.formationId,unitIds:g.unitIds}})}return {actions,memory:m}}`
    let attempts = 0
    const provider = { generate: async () => ({ text: ++attempts === 1 ? broken : source, model: 'fixture', durationMs: 0 }) }
    const result = await compileCommand(provider as never, frame, f.executor, { prompts: loadPrompts(), maxAttempts: 2 })
    assert.equal(result.attempts, 2)
    assert.match(result.log[0]!.errors.join(' '), /后续入队.*transferUnits/)
    assert.deepEqual(result.log[1]!.errors, [])
  } finally { if (lease) f.runtime.releaseCommand(lease); await f.executor.dispose() }
})

test('普通探路优先现有未编队狗，明确新造才新增；中心策略与 60% 随运行捕获', async () => {
  const f = await fixture(true)
  try {
    await f.run({ quantity: 2 })
    const run = [...f.runtime.skillRuns.values()][0]!
    assert.ok(run.kind !== 'repair-vehicle' && run.kind !== 'cover')
    assert.equal(run.useExisting, true)
    assert.equal(f.generations(), 0, '使用现有犬时，编队和探索均不生成代码')
    const goal = f.runtime.goals.get(run.exploreGoalId)!.spec as ExploreGoal
    assert.equal(goal.policy.coverageRatio, 0.6)
    assert.equal(goal.policy.centerFirst, true)
    await f.tick(); await f.tick()
    assert.deepEqual(f.formations.membersOf(run.formationId), [11, 12])
    assert.ok(f.submitted.every(action => action.kind !== 'produce'))
    const continued = await executeCapabilities([{ capability: 'map.explore', params: { formationId: run.formationId, regionName: '测试区' } }], f.ctx,
      { text: '让侦察队探索测试区', prompts: f.prompts, catalog: f.catalog })
    assert.deepEqual(continued.skipped, [])
    assert.equal(continued.goals[0]!.executionMode, 'native')
    assert.equal(f.generations(), 0, '现有编队 map.explore 同样直接本机执行')
    await f.run({ useExisting: false })
    const fresh = [...f.runtime.skillRuns.values()].at(-1)!
    assert.ok(fresh.kind !== 'repair-vehicle' && fresh.kind !== 'cover')
    assert.equal(f.runtime.goals.get(fresh.preparationGoalId)!.spec.kind, 'production')
  } finally { await f.executor.dispose() }
})

test('本机探索只确认成功的移动回执，暂停及同局恢复保留落点，真实揭开后才完成', async () => {
  const actions: import('../packages/contracts/src/index.ts').ActionRequest[] = []
  let rejectFirst = true
  const neverRun = { run: async () => { throw new Error('本机探索不应运行 QuickJS') } }
  const h = await harness(neverRun, { submit: async (requests, snap, guard) => {
    if (!guard()) return []
    actions.push(...requests)
    if (rejectFirst) { rejectFirst = false; return [] }
    return requests.map(() => ({ ok: true, submitted: 1, session: snap.session }))
  } })
  h.formations.transfer([2, 3], 'A')
  const goal: ExploreGoal = { ...explore(), executionMode: 'native', policy: { ...policy, stallTicks: 600 } }
  h.runtime.exploration.add(map(), goal.id, ['left', 'right'])
  h.runtime.activateNativeGoals(h.runtime.upsertGoal(goal))
  await h.runtime.onSnapshot(snapshot({ seq: 2, tick: 30 }))
  assert.deepEqual(h.runtime.goals.get(goal.id)!.facts.unitOrders!.orders, {}, '空回执不算移动已下达')
  await h.runtime.onSnapshot(snapshot({ seq: 3, tick: 45 }))
  const facts = h.runtime.goals.get(goal.id)!.facts
  assert.deepEqual(Object.keys(facts.unitOrders!.orders), ['1', '2', '3'])
  const count = actions.length
  await h.runtime.onSnapshot(snapshot({ seq: 4, tick: 60 }))
  assert.equal(actions.length, count, '相同落点不逐步重复下令')
  h.runtime.pause('formation:A')
  await h.runtime.onSnapshot(snapshot({ seq: 5, tick: 3000 }))
  const saved = persistState(h.runtime), restored = await harness(neverRun, { formations: new FormationRegistry() })
  await restored.runtime.onSnapshot(h.runtime.snapshot!)
  restoreState(restored.runtime, saved)
  assert.deepEqual(restored.runtime.exploration.progress.get(goal.id)!.targets, h.runtime.exploration.progress.get(goal.id)!.targets)
  restored.runtime.resume('formation:A')
  await restored.runtime.onSnapshot(snapshot({ seq: 6, tick: 3015 }))
  assert.deepEqual(restored.runtime.exploration.progress.get(goal.id)!.stalls, {}, '暂停时间不计入受阻时长')
  const current = restored.runtime.exploration.view(goal).targets
  await restored.runtime.onSnapshot(snapshot({ seq: 7, tick: 3030, self: current.map(t => ({ ...snapshot().self[0]!, id: t.unitId, rx: t.x, ry: t.y })) }))
  assert.equal(restored.runtime.goals.get(goal.id)!.status, 'active', '实际抵达落点仍不等于揭开地图')
  restored.runtime.exploration.observe(map().id, { seen: map().regions.flatMap(r => r.cells), impassable: [] })
  await restored.runtime.onSnapshot({ ...restored.runtime.snapshot!, seq: 8, tick: 3045 })
  assert.equal(restored.runtime.goals.get(goal.id)!.status, 'completed')
  assert.ok(restored.submitted.some(action => action.kind === 'stop'), '完成后结束成员的旧移动')
})

test('显式脚本回退保留原入口，无执行方式标记的旧探索恢复后继续原脚本', async () => {
  const previous = process.env.RA2C_SCOUT_EXECUTOR
  process.env.RA2C_SCOUT_EXECUTOR = 'script'
  const f = await fixture(true)
  try {
    await f.run({ memberSource: 'existing' }); await f.tick(); await f.tick()
    assert.equal(f.generations(), 2)
    const run = [...f.runtime.skillRuns.values()][0]!
    assert.ok(run.kind !== 'repair-vehicle' && run.kind !== 'cover')
    const saved = persistState(f.runtime)
    for (const [, goal] of saved.goals) { delete goal.spec.executionMode; if (goal.activeSpec) delete goal.activeSpec.executionMode }
    if (previous === undefined) delete process.env.RA2C_SCOUT_EXECUTOR
    else process.env.RA2C_SCOUT_EXECUTOR = previous
    const restored = await harness(f.executor, { formations: new FormationRegistry() })
    await restored.runtime.onSnapshot(f.runtime.snapshot!); restoreState(restored.runtime, saved)
    const goal = restored.runtime.goals.get(run.exploreGoalId)!
    assert.equal(goalExecutionMode(goal.spec), 'script')
    assert.ok(restored.runtime.programs.get(goal.ownerId)!.script)
    await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 1, tick: f.runtime.snapshot!.tick + 15 })
    assert.ok(restored.submitted.some(action => action.kind === 'move'))
    assert.deepEqual(restored.runtime.exploration.progress.get(run.exploreGoalId)!.targets, f.runtime.exploration.progress.get(run.exploreGoalId)!.targets)
  } finally {
    if (previous === undefined) delete process.env.RA2C_SCOUT_EXECUTOR
    else process.env.RA2C_SCOUT_EXECUTOR = previous
    await f.executor.dispose()
  }
})

test('使用现有狗不生产，数量可覆盖；取消只结束自身目标，改令后旧 Skill 不再接管', async () => {
  const f = await fixture(true)
  try {
    const execution = await f.run({ useExisting: true, quantity: 5 })
    assert.match(execution.skipped.join(' '), /仅2条/)
    const first = [...f.runtime.skillRuns.values()][0]!
    assert.ok(first.kind !== 'repair-vehicle' && first.kind !== 'cover')
    assert.equal(first.quantity, 5)
    await f.tick(); await f.tick()
    assert.deepEqual(f.formations.membersOf(first.formationId), [11, 12])
    assert.ok(f.submitted.every(action => action.kind !== 'produce'))
    const other = production({ id: 'unrelated' })
    activate(f.runtime, other, code)
    await executeCapabilities([{ capability: 'skill.cancel', params: { skillId: 'scout' } }], f.ctx, { text: '取消探路', prompts: f.prompts, catalog: f.catalog })
    assert.equal(f.generations(), 0, '取消本机准备的探路不重编无关的全局生产脚本')
    assert.equal(f.runtime.goals.get(first.exploreGoalId)!.status, 'cancelled')
    assert.equal(f.runtime.goals.get(other.id)!.status, 'active')
    await f.run({ quantity: 5 })
    const second = [...f.runtime.skillRuns.values()].at(-1)!
    assert.ok(second.kind !== 'repair-vehicle' && second.kind !== 'cover')
    assert.equal((f.runtime.goals.get(second.preparationGoalId)!.spec as { quantity: number }).quantity, 5)
    activate(f.runtime, spec({ id: 'new-order', formationId: second.formationId, rawText: '新命令', destination: { x: 8, y: 8 } }), code)
    await f.tick()
    assert.equal(second.status, 'superseded')
    assert.equal(f.runtime.goals.get(second.preparationGoalId)!.status, 'cancelled')
    assert.equal(f.runtime.goals.get('new-order')!.status, 'active')
  } finally { await f.executor.dispose() }
})

test('v3 兼容恢复保留目标和生产预留，不产生 Skill 或重播生产', async () => {
  const original = await harness({ run: async () => outcome() })
  activate(original.runtime, production())
  original.runtime.production.push({ id: 'reserved', goalId: 'production', name: 'MTNK', quantity: 1, building: false, state: 'reserved', observedIds: [], placed: false })
  const state = persistState(original.runtime)
  state.version = 3; delete state.skillRuns; delete state.exploration
  const restored = await harness({ run: async () => outcome() }, { formations: new FormationRegistry() })
  restoreState(restored.runtime, state)
  assert.equal(restored.runtime.goals.size, 1)
  assert.equal(restored.runtime.production[0]!.state, 'unknown')
  assert.equal(restored.runtime.skillRuns.size, 0)
  assert.deepEqual(restored.submitted, [])
})


test('取消探路后丢弃迟到的地图观察，不再安排探索或追加生产', async () => {
  const f = await fixture(true)
  try {
    await f.run({ useExisting: true }); await f.tick(); await f.tick()
    const run = [...f.runtime.skillRuns.values()][0]!
    assert.ok(run.kind !== 'repair-vehicle' && run.kind !== 'cover')
    const progress = f.runtime.exploration.progress.get(run.exploreGoalId)!
    const map = f.runtime.exploration.maps.get(progress.mapId)!, pending = deferred<{ seen: number[]; impassable: number[] }>()
    f.ctx.bridge.readMapBatch = () => pending.promise
    const polling = new ExplorationObserver().poll(f.ctx)
    await f.runtime.cancelSkillRun(run.id)
    pending.resolve({ seen: map.regions.flatMap(region => region.cells), impassable: [] })
    await polling
    assert.equal(map.seen.length, 0)
    const count = f.submitted.length
    await f.tick()
    assert.equal(f.submitted.length, count)
    assert.equal(run.status, 'cancelled')
  } finally { await f.executor.dispose() }
})
