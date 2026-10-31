import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPrompts, type CapabilityCall } from '../packages/command/src/index.ts'
import { goalExecutionMode, type ActionRequest, type ProductionGoal, type Snapshot, type SnapshotUnit } from '../packages/contracts/src/index.ts'
import { FormationRegistry, persistState, restoreState, type RuntimeDeps } from '../packages/runtime/src/index.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { executeCapabilities } from '../apps/companion/src/capabilities/index.ts'
import { prepareGoals } from '../apps/companion/src/prepare-goals.ts'
import { GameCatalog } from '../apps/companion/src/game-catalog.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { activate, deferred, harness, production, snapshot } from './helpers.ts'
import { productionProgress } from '../packages/runtime/src/production-progress.ts'

const legacy = `function step(s,m){const actions=[];for(const g of s.control.goals){if(g.spec.kind!=='production')continue;for(const name of g.productionPlan.availableToProduce)actions.push({goalId:g.spec.id,request:{kind:'produce',name,quantity:g.produceRemaining[name]}})}return{actions,memory:m}}`
const unit = (id: number, name: string, type = 2): SnapshotUnit => ({ id, name, type, rx: 20, ry: 20, isIdle: true })
const queue = (type: number, maxSize: number, name?: string) => ({ type, maxSize, status: name ? 3 : 0, size: name ? 1 : 0, items: name ? [{ name, quantity: 1, progress: 1, creditsEach: 1, creditsSpent: 1 }] : [] })
const build = (target: string, quantity = 1, formationId?: string): CapabilityCall => ({ capability: 'production.produce', params: { target, quantity, ...(formationId ? { formationId } : {}) } })
const neverRun = { run: async () => { throw new Error('本机生产不应进入 QuickJS') } }
async function fixture(executor = neverRun as Pick<StepExecutor, 'run'>, extra: Partial<RuntimeDeps> = {}) {
  const h = await harness(executor, { formations: new FormationRegistry(), ...extra })
  const rules = new Map([
    ['GAPOWR', { type: 2, prerequisite: [], power: 200 }],
    ['NANRCT', { type: 2, prerequisite: [], power: 2000 }],
    ['GAREFN', { type: 2, prerequisite: ['GAPOWR'], power: -50 }],
    ['GAWEAP', { type: 2, prerequisite: ['GAREFN'], power: -25 }],
    ['MTNK', { type: 7, prerequisite: ['GAWEAP'], power: 0 }],
    ['FV', { type: 7, prerequisite: ['GAWEAP'], power: 0 }],
    ['GTGCAN', { type: 2, prerequisite: [], power: -100, buildCat: 0 }],
  ])
  await h.runtime.onSnapshot(snapshot({ seq: 2, self: [unit(100, 'GACNST'), unit(90, 'MTNK', 7)],
    production: { power: { total: 100, drain: 0, isLowPower: false }, available: ['GAPOWR'], queues: [queue(0, 1), queue(1, 1), queue(3, 3)] } }))
  const prompts = loadPrompts(), reads = new Map<string, number>()
  let generations = 0
  const prepare: NonNullable<ConstructorParameters<typeof ProgramController>[0]['prepare']> = (goals, signal, prompts, cache) => prepareGoals(goals, h.runtime.snapshot!, async (name, type) => {
    const key = `${type}:${name}`; reads.set(key, (reads.get(key) ?? 0) + 1)
    return rules.get(name)?.type === type ? rules.get(name) : undefined
  }, signal, prompts.game, cache)
  const controller = new ProgramController({ runtime: h.runtime, executor, prepare, provider: () => ({ generate: async () => { generations++; return { text: legacy, model: 'fixture', durationMs: 0 } } }) as never })
  const catalog = new GameCatalog([...rules].map(([name, rule]) => ({ name, type: rule.type, power: rule.power, available: true, factions: prompts.game.factionsFor(name), aliases: [], roles: prompts.game.rolesFor(name, rule.type, rule) })), h.runtime.snapshot!, prompts.game)
  const ctx = { runtime: h.runtime, formations: h.formations, controller, bridge: {} } as unknown as CommandContext
  const run = (calls: CapabilityCall[]) => executeCapabilities(calls, ctx, { text: '本机生产验收', prompts, catalog })
  const tick = (overrides: Partial<Snapshot> = {}) => h.runtime.onSnapshot({ ...h.runtime.snapshot!, seq: h.runtime.snapshot!.seq + 1, tick: h.runtime.snapshot!.tick + 15, ...overrides })
  return { ...h, ctx, controller, prepare, prompts, catalog, reads, run, tick, generations: () => generations }
}

test('有限生产复用真实科技树与共享前置，按队列空间分批，累计新产物入队后完成且不补战损', async () => {
  const f = await fixture()
  await f.run([build('MTNK', 5, '1队'), build('FV', 1, '2队')])
  assert.equal(f.generations(), 0)
  assert.deepEqual((f.runtime.goals.values().next().value!.spec as ProductionGoal).prerequisites, ['GAPOWR', 'GAREFN', 'GAWEAP'])
  assert.equal(f.reads.get('2:GAPOWR'), 1, '两个独立准备共用同次命令的规则查询')
  for (const [index, name] of ['GAPOWR', 'GAREFN', 'GAWEAP'].entries()) {
    await f.tick()
    assert.equal(f.submitted.filter(action => action.kind === 'produce' && action.name === name).length, 1)
    await f.tick({ production: { ...f.runtime.snapshot!.production!, queues: [queue(0, 1, name), queue(1, 1), queue(3, 3)] } })
    const next = ['GAREFN', 'GAWEAP', 'MTNK', 'FV'].slice(index < 2 ? index : 2, index < 2 ? index + 1 : 4)
    await f.tick({ self: [...f.runtime.snapshot!.self, unit(101 + index, name)], production: { ...f.runtime.snapshot!.production!, available: next, queues: [queue(0, 1), queue(1, 1), queue(3, 3)] } })
  }
  assert.deepEqual(f.submitted.filter(action => action.kind === 'place').map(action => action.name), ['GAPOWR', 'GAREFN', 'GAWEAP'])
  assert.deepEqual(f.submitted.flatMap(action => action.kind === 'produce' && action.name === 'MTNK' ? [action.quantity] : []), [3])
  await f.tick({ self: [...f.runtime.snapshot!.self, ...[110, 111, 112].map(id => unit(id, 'MTNK', 7))] }); await f.tick()
  assert.deepEqual(f.submitted.flatMap(action => action.kind === 'produce' && action.name === 'MTNK' ? [action.quantity] : []), [3, 2])
  await f.tick({ self: [...f.runtime.snapshot!.self, unit(113, 'MTNK', 7), unit(114, 'MTNK', 7), unit(115, 'FV', 7)] }); await f.tick(); await f.tick()
  assert.deepEqual(new Set(f.formations.membersOf('1队')), new Set([110, 111, 112, 113, 114]))
  assert.deepEqual(f.formations.membersOf('2队'), [115])
  assert.ok([...f.runtime.goals.values()].every(goal => goal.status === 'completed' && !goal.facts.nativeError))
  const count = f.submitted.length
  await f.tick({ self: f.runtime.snapshot!.self.filter(unit => unit.id !== 110) })
  assert.equal(f.submitted.length, count, '已有同名单位和后来战损都不改累计生产')
})

test('慢规则查询只等待本目标，其他生产先执行；取消立即结束等待，迟到结果不能恢复', async () => {
  const f = await fixture(), started = deferred<void>(), ready = deferred<void>(), gate = deferred<void>()
  const controller = new ProgramController({ runtime: f.runtime, executor: neverRun, provider: () => { throw new Error('不应生成代码') },
    prepare: async (goals, signal, prompts, cache) => { if (goals[0]!.kind === 'production' && goals[0]!.target === 'MTNK') { started.resolve(); await gate.promise } return f.prepare(goals, signal, prompts, cache) } })
  f.ctx.controller = controller
  controller.subscribe(event => { if (event.stage === 'effective' && event.goalIds.some(id => { const goal = f.runtime.goals.get(id); return goal?.spec.kind === 'production' && goal.spec.target === 'FV' })) ready.resolve() })
  const pending = f.run([build('MTNK', 2), build('FV')])
  await started.promise
  await ready.promise
  await f.tick()
  assert.ok(f.submitted.some(action => action.kind === 'produce' && action.name === 'GAPOWR'))
  const slow = [...f.runtime.goals.values()].find(goal => goal.spec.kind === 'production' && goal.spec.target === 'MTNK')!
  await f.run([{ capability: 'goal.cancel', params: { goalId: slow.spec.id } }]); await pending
  assert.equal(slow.status, 'cancelled')
  gate.resolve(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(slow.activeSpec, undefined)
  assert.ok([...f.runtime.goals.values()].some(goal => goal.spec.kind === 'production' && goal.spec.target === 'FV' && goal.status === 'active'))
})

test('准备途中解散编队，迟到规则只补科技信息，不恢复已删除的生产队号', async () => {
  const f = await fixture(), started = deferred<void>(), gate = deferred<void>()
  f.formations.create('1队', [90])
  f.ctx.controller = new ProgramController({ runtime: f.runtime, executor: neverRun, provider: () => { throw new Error('不应生成代码') },
    prepare: async (goals, signal, prompts, cache) => { started.resolve(); await gate.promise; return f.prepare(goals, signal, prompts, cache) } })
  const pending = f.run([build('MTNK', 2, '1队')]); await started.promise
  const goal = [...f.runtime.goals.values()][0]!
  f.runtime.activateNativeGoals(f.runtime.upsertGoal({ id: 'dissolve', kind: 'formation', rawText: '解散1队', executionMode: 'native', request: { kind: 'dissolveFormation', formationId: '1队' } }))
  await f.tick()
  gate.resolve(); await pending
  assert.equal(goal.spec.kind === 'production' && goal.spec.formationId, undefined)
  assert.equal(goal.activeSpec?.kind === 'production' && goal.activeSpec.formationId, undefined)
  await f.tick()
  assert.equal(f.formations.list().length, 0)
  assert.ok(f.submitted.some(action => action.kind === 'produce'), '独立生产继续，未重建旧队')
})

test('新本机建筑的待建耗电进入已有补电脚本，保留其代码与记忆并共用放置', async () => {
  const executor = new StepExecutor(), f = await fixture(executor)
  try {
    await f.tick({ production: { ...f.runtime.snapshot!.production!, available: ['GAPOWR', 'GTGCAN'] } })
    activate(f.runtime, production({ id: 'power', target: 'GAPOWR', targetType: 2, maintainPower: { reserve: 100, output: 200 }, powerCosts: {}, queueTypes: { GAPOWR: 0 } }), legacy)
    const program = f.runtime.programs.get('global')!, script = program.script
    program.memory = { retained: 123 }
    await f.run([build('GTGCAN')]); await f.tick()
    assert.equal(f.generations(), 0)
    assert.equal(program.script, script)
    assert.deepEqual(program.memory, { retained: 123 })
    assert.deepEqual(f.submitted.filter(action => action.kind === 'produce').map(action => [action.name, action.quantity]), [['GTGCAN', 1], ['GAPOWR', 1]])
    assert.deepEqual((f.runtime.goals.get('power')!.activeSpec as ProductionGoal).powerCosts, {}, '更新来自实际台账，不改写旧目标规则')
    const cannon = [...f.runtime.goals.values()].find(goal => goal.spec.kind === 'production' && goal.spec.target === 'GTGCAN')!
    const { activeSpec, ...pendingOwner } = cannon, goals = new Map(f.runtime.goals)
    goals.set('explicit-pending', { ...pendingOwner, spec: production({ id: 'explicit-pending', target: 'GTGCAN' }), status: 'pending' })
    const shared = f.runtime.production.filter(record => record.name === 'GTGCAN').map(record => ({ ...record, goalId: 'explicit-pending' }))
    assert.equal(productionProgress(f.runtime.goals.get('power')!.spec as ProductionGoal, shared, f.runtime.snapshot!, goals).remaining.GAPOWR, 1, '共享前置先归账到待准备目标时仍计入耗电')
    await f.tick({ production: { ...f.runtime.snapshot!.production!, queues: [queue(0, 1, 'GAPOWR'), queue(1, 1, 'GTGCAN'), queue(3, 3)] } })
    assert.deepEqual(new Set(f.submitted.filter(action => action.kind === 'place').map(action => action.name)), new Set(['GTGCAN', 'GAPOWR']))
  } finally { await executor.dispose() }
})

test('改量替换在途准备；旧批次到齐不吞掉新增数量，暂停恢复不接受旧准备或重放产量', async () => {
  const f = await fixture(), gates = Array.from({ length: 3 }, () => deferred<void>()), starts = Array.from({ length: 3 }, () => deferred<void>())
  let request = 0
  f.ctx.controller = new ProgramController({ runtime: f.runtime, executor: neverRun, provider: () => { throw new Error('不应生成代码') },
    prepare: async (goals, signal, prompts, cache) => { const index = request++; starts[index]?.resolve(); if (gates[index]) await gates[index]!.promise; return f.prepare(goals, signal, prompts, cache) } })
  await f.tick({ production: { ...f.runtime.snapshot!.production!, available: ['MTNK'] } })
  const first = f.run([build('MTNK', 2)])
  await starts[0]!.promise
  const goal = [...f.runtime.goals.values()][0]!
  const changed = f.run([{ capability: 'goal.edit', params: { goalId: goal.spec.id, quantity: 5 } }])
  await starts[1]!.promise; await first
  gates[1]!.resolve(); await changed; await f.tick()
  gates[0]!.resolve(); await new Promise(resolve => setImmediate(resolve))
  const extra = f.run([{ capability: 'goal.edit', params: { goalId: goal.spec.id, quantity: 7 } }])
  await starts[2]!.promise
  await f.tick({ self: [...f.runtime.snapshot!.self, ...[110, 111, 112].map(id => unit(id, 'MTNK', 7))] })
  await f.tick({ self: [...f.runtime.snapshot!.self, unit(113, 'MTNK', 7), unit(114, 'MTNK', 7)] })
  assert.equal(goal.status, 'active', '旧批次完成仍等待新增要求')
  f.runtime.pause('global'); await extra
  gates[2]!.resolve(); await new Promise(resolve => setImmediate(resolve))
  assert.equal((goal.activeSpec as ProductionGoal).quantity, 5)
  await f.run([{ capability: 'control.resume', params: { scope: 'global' } }]); await f.tick()
  assert.equal((goal.activeSpec as ProductionGoal).quantity, 7)
  assert.equal(f.submitted.flatMap(action => action.kind === 'produce' && action.name === 'MTNK' ? [action.quantity] : []).reduce((sum, quantity) => sum + quantity, 0), 7)
})

test('准备失败只记录对应目标；新局不会接受旧局结果，本机提交回退脚本仍保留同一台账', async () => {
  const executor = new StepExecutor(), f = await fixture(executor)
  try {
    await f.tick({ production: { ...f.runtime.snapshot!.production!, available: ['MTNK', 'FV'] } })
    f.ctx.controller = new ProgramController({ runtime: f.runtime, executor, provider: () => { throw new Error('不应生成代码') },
      prepare: async (goals, signal, prompts, cache) => { if (goals[0]!.kind === 'production' && goals[0]!.target === 'FV') throw new Error('FV规则查询失败'); return f.prepare(goals, signal, prompts, cache) } })
    await f.run([build('MTNK', 2), build('FV')]); await f.tick()
    const failed = [...f.runtime.goals.values()].find(goal => goal.spec.kind === 'production' && goal.spec.target === 'FV')!
    assert.equal(f.runtime.goalExecution(failed.spec.id)!.state, 'faulted')
    assert.equal(f.submitted.filter(action => action.kind === 'produce').length, 1)
    const saved = persistState(f.runtime), restored = await harness(executor, { formations: new FormationRegistry() })
    await restored.runtime.onSnapshot(f.runtime.snapshot!); restoreState(restored.runtime, saved)
    const controller = new ProgramController({ runtime: restored.runtime, executor, provider: () => ({ generate: async () => ({ text: legacy, model: 'fixture', durationMs: 0 }) }) as never })
    await restored.runtime.cancelGoal(failed.spec.id)
    controller.useScriptExecution(['production']); await controller.refresh('global')
    await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 1 })
    const active = [...restored.runtime.goals.values()].find(goal => goal.status === 'active')!
    assert.equal(goalExecutionMode(active.spec), 'script')
    assert.equal(active.spec.id, saved.production[0]!.goalId)
    assert.equal(restored.submitted.some(action => action.kind === 'produce'), false)
    const started = deferred<void>(), gate = deferred<void>()
    f.ctx.controller = new ProgramController({ runtime: f.runtime, executor, provider: () => { throw new Error('不应生成代码') }, prepare: async goals => { started.resolve(); await gate.promise; return goals } })
    const pending = f.run([build('MTNK')]); await started.promise
    await f.tick({ sessionKey: 'new-battle', seq: 1 })
    await pending.catch(error => assert.match(String(error), /对局/))
    gate.resolve(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.runtime.goals.size, 0)
  } finally { await executor.dispose() }
})

const power = (reserve = 100): CapabilityCall => ({ capability: 'production.power', params: { reserve } })
const busy = (type: number, name: string, status = 1) => ({ ...queue(type, type === 3 ? 3 : 1, name), status })

test('重复补电共用全局供给，先归账到明确新增电厂；恢复健康待命，耗电增加继续补电', async () => {
  const f = await fixture()
  await f.run([power(300), power(300), build('GAPOWR', 2)])
  assert.equal(f.runtime.goals.size, 3)
  assert.equal(f.generations(), 0)
  assert.ok([...f.runtime.goals.values()].every(goal => goalExecutionMode(goal.spec) === 'native'))
  const finite = [...f.runtime.goals.values()].find(goal => goal.spec.kind === 'production' && !goal.spec.maintainPower)!
  await f.tick(); await f.tick()
  assert.equal(f.runtime.production.length, 1)
  assert.equal(f.runtime.production[0]!.goalId, finite.spec.id)
  for (let n = 1; n <= 2; n++) {
    await f.tick({ production: { ...f.runtime.snapshot!.production!, queues: [queue(0, 1, 'GAPOWR'), queue(1, 1), queue(3, 3)] } })
    await f.tick({ self: [...f.runtime.snapshot!.self, unit(110 + n, 'GAPOWR')], production: { ...f.runtime.snapshot!.production!, power: { total: 100 + n * 200, drain: 0, isLowPower: false }, queues: [queue(0, 1), queue(1, 1), queue(3, 3)] } })
  }
  assert.equal(finite.status, 'completed')
  assert.equal(f.runtime.production.reduce((sum, record) => sum + record.quantity, 0), 2, '明确新造2座，不吞数量也不另补1座')
  for (const goal of f.runtime.goals.values()) if (goal !== finite) assert.equal(f.runtime.goalExecution(goal.spec.id)!.state, 'continuous')
  f.runtime.pause('global')
  await f.tick({ production: { ...f.runtime.snapshot!.production!, power: { total: 500, drain: 550, isLowPower: true } } })
  assert.equal(f.runtime.production.length, 2)
  f.runtime.resume('global'); await f.tick(); await f.tick()
  assert.equal(f.runtime.production.length, 3, '仅补入当前空闲队列的一座，另一个补电目标不重复追加')
  assert.equal(f.runtime.production[2]!.name, 'GAPOWR')
})

test('旧脚本不同电厂的待建供给进入本机补电，未知回执与同局恢复不重复补同一缺口', async () => {
  const executor = new StepExecutor(), f = await fixture(executor)
  try {
    await f.tick({ production: { ...f.runtime.snapshot!.production!, available: ['NANRCT', 'GAPOWR'] } })
    activate(f.runtime, production({ id: 'nuclear', target: 'NANRCT', targetType: 2, powerCosts: { NANRCT: 2000 }, queueTypes: { NANRCT: 0 } }), legacy)
    await f.tick()
    f.runtime.production[0]!.state = 'unknown'
    await f.run([power(300), power(500)]); await f.tick()
    assert.equal(f.runtime.goals.size, 3)
    assert.deepEqual(f.submitted.filter(action => action.kind === 'produce').map(action => action.name), ['NANRCT'])
    for (const goal of f.runtime.goals.values()) if (goal.spec.id !== 'nuclear') {
      assert.equal(f.runtime.goalExecution(goal.spec.id)!.state, 'pending')
      assert.match(f.runtime.goalExecution(goal.spec.id)!.detail ?? '', /提交确认/)
    }
    const saved = persistState(f.runtime), restored = await harness(executor, { formations: new FormationRegistry() })
    await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: 1 }); restoreState(restored.runtime, saved)
    await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: 2 })
    assert.equal(restored.submitted.some(action => action.kind === 'produce'), false)
    const nuclear = { ...f.runtime.snapshot!, seq: 3, self: [...f.runtime.snapshot!.self, unit(120, 'NANRCT')], production: { ...f.runtime.snapshot!.production!, power: { total: 2100, drain: 0, isLowPower: false } } }
    await restored.runtime.onSnapshot(nuclear)
    assert.equal(restored.runtime.goals.get('nuclear')!.status, 'completed')
    assert.ok([...restored.runtime.goals.values()].filter(goal => goal.spec.id !== 'nuclear').every(goal => restored.runtime.goalExecution(goal.spec.id)!.state === 'continuous'))
    assert.equal(restored.submitted.length, 0)
  } finally { await executor.dispose() }
})

test('队列未公开时，大于明确新增数量的补电需求也先归账明确产量，余下缺口后补', async () => {
  const f = await fixture()
  await f.tick({ production: { ...f.runtime.snapshot!.production!, queues: [] } })
  await f.run([power(600), build('GAPOWR', 2)]); await f.tick(); await f.tick()
  const finite = [...f.runtime.goals.values()].find(goal => goal.spec.kind === 'production' && !goal.spec.maintainPower)!
  assert.deepEqual(f.runtime.production.map(record => [record.goalId, record.quantity]), [[finite.spec.id, 2]])
  await f.tick({ self: [...f.runtime.snapshot!.self, unit(151, 'GAPOWR'), unit(152, 'GAPOWR')], production: { ...f.runtime.snapshot!.production!, power: { total: 500, drain: 0, isLowPower: false } } })
  assert.equal(finite.status, 'completed')
  assert.equal(f.runtime.production.reduce((sum, record) => sum + record.quantity, 0), 3, '明确2座再补缺口1座')
})

test('取消原建设目标仍保留其他补电需要的共享电厂，补电可放置该前置并继续待命', async () => {
  const f = await fixture()
  await f.run([build('MTNK'), power(200)]); await f.tick()
  const tank = [...f.runtime.goals.values()].find(goal => goal.spec.kind === 'production' && goal.spec.target === 'MTNK')!
  assert.equal(f.runtime.production[0]!.name, 'GAPOWR')
  assert.equal(f.runtime.production[0]!.goalId, tank.spec.id)
  await f.runtime.cancelProductionGoal(tank.spec.id)
  await f.tick({ production: { ...f.runtime.snapshot!.production!, queues: [queue(0, 1, 'GAPOWR'), queue(1, 1), queue(3, 3)] } })
  assert.deepEqual(f.submitted.filter(action => action.kind === 'place'), [{ kind: 'place', name: 'GAPOWR' }])
  assert.equal(f.submitted.some(action => action.kind === 'cancel'), false, '共享前置按原撤销规则保留')
  await f.tick({ self: [...f.runtime.snapshot!.self, unit(160, 'GAPOWR')], production: { ...f.runtime.snapshot!.production!, power: { total: 300, drain: 0, isLowPower: false }, queues: [queue(0, 1), queue(1, 1), queue(3, 3)] } })
  const keeper = [...f.runtime.goals.values()].find(goal => goal !== tank)!
  assert.equal(f.runtime.goalExecution(keeper.spec.id)!.state, 'continuous')
  assert.equal(f.runtime.production.length, 1)
})

test('显式暂停其他忙队列，保留本目标前置与目标队列；完成后确认恢复，同局重启不重发', async () => {
  const f = await fixture()
  const queues = [busy(0, 'NANRCT'), busy(1, 'GTGCAN'), busy(2, 'E1', 2), busy(3, 'FV'), busy(4, 'ORCA')]
  await f.tick({ production: { ...f.runtime.snapshot!.production!, queues } })
  await f.run([{ capability: 'production.produce', params: { target: 'MTNK', quantity: 2, formationId: '1队', queues: [0, 1, 2, 3] } }]); await f.tick()
  const goal = [...f.runtime.goals.values()][0]!
  assert.deepEqual(f.submitted, [{ kind: 'pauseQueue', queueType: 1 }], '科技前置仍依赖建筑队列，不能先停它')
  await f.tick({ production: { ...f.runtime.snapshot!.production!, available: ['MTNK'], queues: queues.map(q => q.type === 1 ? { ...q, status: 2 } : q) } })
  assert.deepEqual(f.submitted.filter(action => action.kind === 'pauseQueue').map(action => action.queueType), [1, 0])
  assert.deepEqual(f.submitted.filter(action => action.kind === 'produce'), [{ kind: 'produce', name: 'MTNK', quantity: 2 }])
  f.runtime.pause('global')
  await f.tick({ self: [...f.runtime.snapshot!.self, unit(130, 'MTNK', 7), unit(131, 'MTNK', 7)], production: { ...f.runtime.snapshot!.production!, queues: queues.map(q => q.type <= 2 ? { ...q, status: 2 } : q) } })
  f.runtime.upsertGoal(production({ id: 'other-tanks', quantity: 1 }))
  f.runtime.production.push({ id: 'other-batch', goalId: 'other-tanks', name: 'MTNK', quantity: 1, queueType: 3, building: false, state: 'submitted', observedIds: [], placed: false })
  f.runtime.resume('global'); await f.tick()
  assert.equal(goal.status, 'active', '恢复只收到请求回执，尚未观察到队列恢复')
  assert.deepEqual(new Set(f.submitted.filter(action => action.kind === 'resumeQueue').map(action => action.queueType)), new Set([0, 1]))
  assert.deepEqual(f.formations.membersOf('1队'), [130, 131])
  assert.match(f.runtime.goalExecution(goal.spec.id)!.detail ?? '', /恢复/)
  await f.tick({ production: { ...f.runtime.snapshot!.production!, queues: [queue(0, 1), busy(2, 'E1', 2), queue(3, 3)] } })
  assert.equal(f.runtime.pausedQueues.has(0), false)
  assert.equal(f.runtime.pausedQueues.get(1), goal.spec.id, '暂未观察到的队列保留归属')
  const saved = persistState(f.runtime), restored = await harness(neverRun, { formations: new FormationRegistry() })
  await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: 1 }); restoreState(restored.runtime, saved)
  await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: 2 })
  assert.equal(restored.submitted.length, 0)
  await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: 3, production: { ...f.runtime.snapshot!.production!, queues: [queue(0, 1), queue(1, 1), busy(2, 'E1', 2), queue(3, 3)] } })
  assert.equal(restored.runtime.goals.get(goal.spec.id)!.status, 'completed')
  assert.equal(restored.runtime.pausedQueues.size, 0)
  assert.equal(restored.submitted.length, 0, '玩家原已暂停的步兵队列从未被接管或恢复')
})

test('取消发生在暂停提交中，迟到正回执仍被收尾；恢复回执不明时保留归属且重启不重发', async () => {
  const entered = deferred<void>(), gate = deferred<void>(), calls: ActionRequest[] = []
  const f = await fixture(neverRun, { submit: async (actions, context, guard) => {
    if (!guard()) return []
    calls.push(...actions)
    if (actions[0]?.kind === 'pauseQueue') { entered.resolve(); await gate.promise }
    if (actions[0]?.kind === 'resumeQueue') throw new Error('连接中断')
    return actions.map(() => ({ ok: true, submitted: 1, session: context.session }))
  } })
  await f.tick({ production: { ...f.runtime.snapshot!.production!, available: ['MTNK'], queues: [queue(0, 1), busy(1, 'GTGCAN'), queue(3, 3)] } })
  await f.run([{ capability: 'production.produce', params: { target: 'MTNK', queues: [1] } }])
  const goal = [...f.runtime.goals.values()][0]!, pending = f.tick()
  await entered.promise; await f.runtime.cancelGoal(goal.spec.id)
  const beforeReceipt = f.tick()
  gate.resolve(); await Promise.all([pending, beforeReceipt])
  assert.equal(f.runtime.pausedQueues.get(1), goal.spec.id)
  await f.tick({ production: { ...f.runtime.snapshot!.production!, queues: [queue(0, 1), busy(1, 'GTGCAN', 2), queue(3, 3)] } })
  assert.deepEqual(calls.map(action => action.kind), ['pauseQueue', 'resumeQueue'])
  assert.equal(goal.facts.queueControl?.orders[1]?.state, 'unknown')
  assert.match(f.runtime.goalExecution(goal.spec.id)!.detail ?? '', /恢复.*回执待确认/)
  const saved = persistState(f.runtime), restored = await harness(neverRun, { formations: new FormationRegistry() })
  await restored.runtime.onSnapshot(f.runtime.snapshot!); restoreState(restored.runtime, saved)
  await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 1 })
  assert.equal(restored.submitted.length, 0)
  assert.equal(restored.runtime.pausedQueues.get(1), goal.spec.id)
  await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 2, production: { ...f.runtime.snapshot!.production!, queues: [queue(0, 1), busy(1, 'GTGCAN'), queue(3, 3)] } })
  assert.equal(restored.runtime.pausedQueues.size, 0)
  assert.equal(restored.runtime.goals.get(goal.spec.id)!.status, 'cancelled')
  assert.equal(restored.submitted.length, 0)
})

test('暂停零提交不认领、确定未发送可重试；暂停回执不明不能把玩家暂停认作自己的', async () => {
  for (const unknown of [false, true]) {
    const calls: ActionRequest[] = []
    let attempt = 0, savedBeforeAPI = false, prepared: ReturnType<typeof persistState> | undefined
    const f = await fixture(neverRun, { checkpoint: () => { savedBeforeAPI = true; prepared = persistState(f.runtime) }, submit: async (actions, context, guard) => {
      if (!guard()) return []
      assert.equal(savedBeforeAPI, true)
      savedBeforeAPI = false
      calls.push(...actions)
      if (actions[0]?.kind === 'pauseQueue') {
        if (unknown) return [{ ok: false, submitted: 0, reason: 'api-error', session: context.session }]
        if (attempt++ === 0) return [{ ok: true, submitted: 0, session: context.session }]
      }
      return actions.map(() => ({ ok: true, submitted: 1, session: context.session }))
    } })
    await f.tick({ production: { ...f.runtime.snapshot!.production!, available: ['MTNK'], queues: [queue(0, 1), busy(1, 'GTGCAN'), queue(3, 3)] } })
    await f.run([{ capability: 'production.produce', params: { target: 'MTNK', queues: [1] } }]); await f.tick()
    const goal = [...f.runtime.goals.values()][0]!
    assert.equal(f.runtime.pausedQueues.size, 0)
    if (!unknown) {
      await f.tick()
      assert.equal(calls.filter(action => action.kind === 'pauseQueue').length, 2)
      assert.equal(f.runtime.pausedQueues.get(1), goal.spec.id)
      await f.tick({ production: { ...f.runtime.snapshot!.production!, queues: [queue(0, 1), busy(1, 'GTGCAN', 3), queue(3, 3)] } })
      assert.equal(f.runtime.pausedQueues.size, 0, '其他队列恰好完工，已就绪状态不会被当成一直等待暂停')
      assert.equal(calls.filter(action => action.kind === 'pauseQueue').length, 2, '已就绪队列不再暂停')
      assert.equal(calls.some(action => action.kind === 'resumeQueue'), false)
    } else {
      const restored = await harness(neverRun, { formations: new FormationRegistry() })
      await restored.runtime.onSnapshot(f.runtime.snapshot!); restoreState(restored.runtime, prepared!)
      await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: 1, production: { ...f.runtime.snapshot!.production!, queues: [queue(0, 1), busy(1, 'GTGCAN', 2), queue(3, 3)] } })
      assert.equal(restored.runtime.goals.get(goal.spec.id)!.facts.queueControl?.orders[1]?.state, 'unknown')
      assert.equal(restored.runtime.pausedQueues.size, 0)
      assert.equal(restored.submitted.some(action => action.kind === 'pauseQueue' || action.kind === 'resumeQueue'), false, '只保存意图尚无回执，恢复后不凭队列已暂停认领')
      await f.tick({ production: { ...f.runtime.snapshot!.production!, queues: [queue(0, 1), busy(1, 'GTGCAN', 2), queue(3, 3)] } })
      assert.equal(f.runtime.pausedQueues.size, 0)
      assert.equal(goal.facts.queueControl?.orders[1]?.state, 'unknown')
      await f.runtime.cancelGoal(goal.spec.id); await f.tick()
      assert.equal(calls.some(action => action.kind === 'resumeQueue'), false)
      assert.equal(calls.filter(action => action.kind === 'pauseQueue').length, 1)
    }
  }
})

test('本机带队列控制的生产回退脚本，产量及暂停归属不重置，旧转发脚本也能收尾恢复', async () => {
  const executor = new StepExecutor(), f = await fixture(executor)
  try {
    await f.tick({ production: { ...f.runtime.snapshot!.production!, available: ['MTNK'], queues: [queue(0, 1), busy(1, 'GTGCAN'), queue(3, 3)] } })
    await f.run([{ capability: 'production.produce', params: { target: 'MTNK', queues: [1] } }]); await f.tick()
    const goal = [...f.runtime.goals.values()][0]!, record = f.runtime.production[0]!
    await f.tick({ production: { ...f.runtime.snapshot!.production!, queues: [queue(0, 1), busy(1, 'GTGCAN', 2), queue(3, 3)] } })
    f.controller.useScriptExecution(['production']); await f.controller.refresh('global')
    assert.equal(f.generations(), 1)
    assert.equal(f.runtime.production[0], record)
    assert.equal(f.runtime.pausedQueues.get(1), goal.spec.id)
    await f.tick({ self: [...f.runtime.snapshot!.self, unit(150, 'MTNK', 7)] }); await f.tick()
    assert.equal(goalExecutionMode(goal.activeSpec!), 'script')
    assert.equal(f.submitted.filter(action => action.kind === 'produce').length, 1)
    assert.equal(f.submitted.filter(action => action.kind === 'resumeQueue').length, 1)
    assert.equal(goal.status, 'active')
    await f.tick({ production: { ...f.runtime.snapshot!.production!, queues: [queue(0, 1), busy(1, 'GTGCAN'), queue(3, 3)] } })
    assert.equal(goal.status, 'completed')
    assert.equal(f.runtime.pausedQueues.size, 0)
  } finally { await executor.dispose() }
})

test('暂停提交尚未返回时换局，旧正回执不能把暂停归属写入新对局', async () => {
  const entered = deferred<void>(), gate = deferred<void>()
  const f = await fixture(neverRun, { submit: async (actions, context, guard) => {
    if (!guard()) return []
    if (actions[0]?.kind === 'pauseQueue') { entered.resolve(); await gate.promise }
    return actions.map(() => ({ ok: true, submitted: 1, session: context.session }))
  } })
  await f.tick({ production: { ...f.runtime.snapshot!.production!, available: ['MTNK'], queues: [queue(0, 1), busy(1, 'GTGCAN'), queue(3, 3)] } })
  await f.run([{ capability: 'production.produce', params: { target: 'MTNK', queues: [1] } }])
  const pending = f.tick(); await entered.promise
  const switched = f.tick({ sessionKey: 'new-battle', seq: 1 })
  gate.resolve(); await Promise.all([pending, switched])
  assert.equal(f.runtime.goals.size, 0)
  assert.equal(f.runtime.pausedQueues.size, 0)
})
