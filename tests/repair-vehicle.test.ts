import test from 'node:test'
import assert from 'node:assert/strict'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { loadPrompts } from '../packages/command/src/index.ts'
import { FormationRegistry, persistState, restoreState } from '../packages/runtime/src/index.ts'
import { planRepairs, emptyRepairState } from '../packages/runtime/src/repair.ts'
import { goalExecutionMode, type ActionRequest, type RepairGoal, type SnapshotUnit } from '../packages/contracts/src/index.ts'
import { executeCapabilities } from '../apps/companion/src/capabilities/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { GameCatalog } from '../apps/companion/src/game-catalog.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { activate, code, harness, production, snapshot } from './helpers.ts'

// 固定模型产物验证真实隔离执行、动态事实与桥动作接线；不调用云模型或游戏。
const source = `function step(s,m){const actions=[];for(const g of s.control.goals){const p=g.spec,c=s.constraints.goals[p.id];
 if(p.kind==='production'){if(g.unitIds.length&&c.management){actions.push({goalId:p.id,request:{kind:c.management.kind,formationId:p.formationId,unitIds:g.unitIds}})}else if(g.produceRemaining[p.target]>0){actions.push({goalId:p.id,request:{kind:'produce',name:p.target,quantity:g.produceRemaining[p.target]}})}}
 if(p.kind==='formation'&&g.unitIds.length)actions.push({goalId:p.id,request:{...p.request,unitIds:g.unitIds}});
 if(p.kind==='repair'&&g.repair){for(const pair of g.repair.assembling)actions.push({goalId:p.id,request:{kind:'enterTransport',unitIds:[pair.engineerId],targetId:pair.vehicleId}});for(const t of g.repair.targets)actions.push({goalId:p.id,request:{kind:'repair',unitIds:[t.unitId],targetId:t.targetId}});}
 if(p.kind==='transport'&&g.unitIds.length)actions.push({goalId:p.id,request:{kind:'enterTransport',unitIds:g.unitIds,targetId:p.transportId}});
 }return {actions,memory:m}}`
const unit = (id: number, name = 'MTNK', overrides: Partial<SnapshotUnit> = {}): SnapshotUnit => ({ id, name, type: name === 'ENGINEER' ? 3 : 7, rx: id, ry: 5, isIdle: false, hitPoints: 100, maxHitPoints: 100, ...(name === 'FV' ? { transport: { occupied: 0, capacity: 1, unitIds: [] } } : {}), ...overrides })
const loaded = (id: number, engineerId: number) => unit(id, 'FV', { transport: { occupied: 1, capacity: 1, unitIds: [engineerId], passengers: [{ id: engineerId, name: 'ENGINEER', type: 3 }] } })
const goal = (overrides: Partial<RepairGoal> = {}): RepairGoal => ({ id: 'repair', rawText: '维修坦克', kind: 'repair', formationId: '维修队', vehicleNames: ['FV'], engineerNames: ['ENGINEER'], tankNames: ['MTNK', 'HTNK'], preparationGoalIds: [], policy: { retryTicks: 90, stallTicks: 600 }, ...overrides })
async function fixture() {
  const executor = new StepExecutor()
  const h = await harness(executor, { formations: new FormationRegistry() })
  await h.runtime.onSnapshot(snapshot({ seq: 2, self: [unit(50, 'GACNST', { type: 2 }), unit(60, 'MTNK', { hitPoints: 50 }), unit(61, 'HTNK', { hitPoints: 20 })], production: { ...snapshot().production!, available: ['FV', 'ENGINEER'] } }))
  const prompts = loadPrompts(), catalog = new GameCatalog(['FV', 'ENGINEER', 'MTNK', 'HTNK'].map(name => ({ name, type: name === 'ENGINEER' ? 3 : 7, power: 0, available: true, factions: [], aliases: [], roles: [name === 'FV' ? 'infantryFightingVehicle' : name === 'ENGINEER' ? 'engineer' : 'tank'] })), h.runtime.snapshot!, prompts.game)
  let generations = 0
  const controller = new ProgramController({ runtime: h.runtime, executor, provider: () => ({ generate: async () => { generations++; return { text: source, model: 'fixture', durationMs: 0 } } }) as never })
  const ctx = { runtime: h.runtime, formations: h.formations, controller, bridge: {} } as unknown as CommandContext
  const tick = (self = h.runtime.snapshot!.self) => h.runtime.onSnapshot({ ...h.runtime.snapshot!, self, tick: h.runtime.snapshot!.tick + 15, seq: h.runtime.snapshot!.seq + 1 })
  const run = (params: Record<string, unknown> = {}) => executeCapabilities([{ capability: 'skill.run', params: { skillId: 'repair-vehicle', ...params } }], ctx, { text: '造维修车', prompts, catalog })
  return { ...h, executor, ctx, tick, run, generations: () => generations, prompts, catalog }
}

test('维修车别名和固定配方：默认新造整套，两车同队组件同时交接，上车后分头修理', async () => {
  const f = await fixture()
  try {
    assert.equal(f.prompts.skills.get('修理车')!.definition.id, 'repair-vehicle')
    assert.deepEqual(f.prompts.skills.parameters('维修车', {}), { quantity: 1, memberSource: 'new' })
    const execution = await f.run({ quantity: 2, formationId: '1队' })
    assert.deepEqual(execution.skipped, [])
    assert.equal(f.generations(), 0, '组件生产、组装和维修均本机执行')
    const run = [...f.runtime.skillRuns.values()][0]!
    assert.ok(run.kind === 'repair-vehicle')
    assert.equal(f.runtime.goals.get(run.repairGoalId)!.spec.executionMode, 'native')
    assert.equal(f.runtime.programs.get('formation:1队')!.script, undefined)
    await f.tick()
    assert.deepEqual(f.submitted.filter(a => a.kind === 'produce'), [{ kind: 'produce', name: 'FV', quantity: 2 }, { kind: 'produce', name: 'ENGINEER', quantity: 2 }])
    const born = [...f.runtime.snapshot!.self, unit(101, 'FV'), unit(102, 'FV'), unit(103, 'ENGINEER'), unit(104, 'ENGINEER')]
    await f.tick(born); await f.tick()
    assert.deepEqual(new Set(f.formations.membersOf('1队')), new Set([101, 102, 103, 104]))
    assert.equal(f.runtime.programs.get('global')!.stats.errors, 0)
    const pairs = f.submitted.filter(a => a.kind === 'enterTransport')
    assert.equal(new Set(pairs.map(a => a.targetId)).size, 2)
    assert.equal(f.runtime.goalExecution(run.repairGoalId)!.state, 'running')
    assert.equal(f.submitted.some(a => a.kind === 'repair'), false) // 发出上车不算已组装。
    await f.tick(born.filter(u => u.id !== 103).map(u => u.id === 101 ? loaded(101, 103) : u))
    assert.deepEqual(f.submitted.filter(a => a.kind === 'repair').flatMap(a => a.unitIds), [101], '首辆组装完成就维修，不等待另一辆上车')
    await f.tick(born.filter(u => u.type !== 3).map(u => u.id === 101 ? loaded(101, 103) : u.id === 102 ? loaded(102, 104) : u))
    const repairs = f.submitted.filter(a => a.kind === 'repair')
    assert.equal(new Set(repairs.map(a => a.targetId)).size, 2)
    assert.deepEqual(new Set(repairs.flatMap(a => a.unitIds)), new Set([101, 102]))
    assert.equal(f.runtime.goalExecution(run.repairGoalId)!.state, 'continuous')
    assert.equal(run.status, 'repairing')
    assert.ok(run.preparationGoalIds.every(id => f.runtime.goals.get(id)!.status === 'completed'))
    assert.equal(f.submitted.some(a => a.kind === 'move' && a.unitIds.some(id => [60, 61].includes(id))), false)
    assert.equal(f.submitted.filter(a => a.kind === 'produce').length, 2)
    const saved = persistState(f.runtime), restored = await harness(f.executor, { formations: new FormationRegistry() })
    await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 1 })
    restoreState(restored.runtime, saved)
    await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 2 })
    assert.equal(restored.submitted.some(a => a.kind === 'produce' || a.kind === 'enterTransport'), false)
    assert.equal(restored.submitted.some(a => a.kind === 'repair'), false, '恢复已确认的忙碌订单，不重新打断维修')
    assert.equal(restored.runtime.skillRuns.get(run.id)!.status, 'repairing')
    await restored.runtime.cancelSkillRun(run.id)
    const before = restored.submitted.length
    await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 3 })
    assert.equal(restored.submitted.length, before)
    assert.equal(restored.runtime.goals.get(run.repairGoalId)!.status, 'cancelled')
  } finally { await f.executor.dispose() }
})

test('按全量真实血量分工：排除满血、矿车及敌人，修满或失效后换目标，多车不串行', () => {
  const cars = [loaded(1, 3), loaded(2, 4)]
  const tanks = [unit(10, 'MTNK', { hitPoints: 40 }), unit(11, 'HTNK', { hitPoints: 20 }), unit(12), unit(13, 'HARV', { hitPoints: 1 })]
  const snap = snapshot({ self: [...cars, ...tanks], enemies: [unit(99, 'MTNK', { hitPoints: 1 })] })
  const first = planRepairs(goal(), snap, [1, 2], emptyRepairState(), false)
  assert.deepEqual(new Set(first.view.targets.map(t => t.targetId)), new Set([10, 11]))
  const full = { ...snap, tick: 30, self: [...cars, unit(10), unit(11, 'HTNK', { hitPoints: 20 }), unit(12, 'MTNK', { hitPoints: 30 })] }
  const next = planRepairs(goal(), full, [1, 2], first.state, false)
  assert.deepEqual(new Set(next.view.targets.map(t => t.targetId)), new Set([11, 12]))
  const noWounded = planRepairs(goal(), { ...full, self: [...cars, unit(11), unit(12)] }, [1, 2], next.state, false)
  assert.deepEqual(noWounded.view.targets, [])
  assert.equal(noWounded.view.readyIds.length, 2)
  const scope = planRepairs(goal({ followFormationId: '坦克队' }), full, [1, 2], next.state, false, [12])
  assert.ok(scope.view.targets.every(t => t.targetId === 12))
  assert.ok(scope.view.follow)
})

test('auto 只补缺失组件，本机生产与编队仍完成交接与组装', async () => {
  const f = await fixture()
  try {
    await f.tick([...f.runtime.snapshot!.self, unit(1, 'FV')])
    await f.run({ memberSource: 'auto', formationId: '维修队' })
    assert.equal(f.generations(), 0)
    await f.tick(); await f.tick()
    assert.deepEqual(f.submitted.filter(action => action.kind === 'produce'), [{ kind: 'produce', name: 'ENGINEER', quantity: 1 }])
    await f.tick([...f.runtime.snapshot!.self, unit(103, 'ENGINEER')]); await f.tick(); await f.tick()
    assert.deepEqual(new Set(f.formations.membersOf('维修队')), new Set([1, 103]))
    assert.ok(f.submitted.some(action => action.kind === 'enterTransport' && action.unitIds[0] === 103 && action.targetId === 1))
    assert.equal(f.runtime.programs.get('global')!.stats.errors, 0)
  } finally { await f.executor.dispose() }
})

test('已有组件可组装而不生产；给维修队新命令后旧 Skill 不再接管', async () => {
  const f = await fixture()
  try {
    await f.tick([...f.runtime.snapshot!.self, unit(1, 'FV'), unit(3, 'ENGINEER')])
    const execution = await f.run({ memberSource: 'existing', formationId: '维修队' })
    assert.deepEqual(execution.skipped, [])
    assert.equal(f.generations(), 0)
    await f.tick(); await f.tick()
    assert.equal(f.submitted.some(a => a.kind === 'produce'), false)
    assert.ok(f.submitted.some(a => a.kind === 'enterTransport'))
    const first = [...f.runtime.skillRuns.values()][0]!
    activate(f.runtime, production({ id: 'unrelated-production' }), code)
    await executeCapabilities([{ capability: 'skill.cancel', params: { skillId: 'repair-vehicle' } }], f.ctx, { text: '取消维修车', prompts: f.prompts, catalog: f.catalog })
    assert.equal(first.status, 'cancelled')
    assert.equal(f.generations(), 0, '取消本机组件准备不重编无关生产')
    await f.run({ memberSource: 'existing', formationId: '维修队' }); await f.tick(); await f.tick()
    const run = [...f.runtime.skillRuns.values()].at(-1)!
    activate(f.runtime, { id: 'new-order', kind: 'combat', rawText: '原地待命', formationId: run.formationId, mode: 'hold', region: { name: '全图', x1: 0, y1: 0, x2: 99, y2: 99 }, allowedActions: ['stop'] }, code)
    const before = f.submitted.length
    await f.tick()
    assert.equal(run.status, 'superseded')
    assert.equal(f.submitted.length, before)
  } finally { await f.executor.dispose() }
})

test('本机组装与维修按成功回执去重，单车拒绝不阻塞同伴；暂停恢复、伤愈与战损沿用原生命周期', async () => {
  const submitted: ActionRequest[] = []
  let attempts = 0
  const neverRun = { run: async () => { throw new Error('本机维修不应运行 QuickJS') } }
  const h = await harness(neverRun, { submit: async (actions, snap, guard) => {
    if (!guard()) return []
    submitted.push(...actions)
    if (actions[0]?.kind === 'enterTransport') {
      attempts++
      if (attempts === 1) return []
      if (attempts === 2) return [{ ok: false, submitted: 0, reason: 'order-rejected', session: snap.session }]
    }
    return actions.map(() => ({ ok: true, submitted: 1, session: snap.session }))
  } })
  h.formations.transfer([2, 3], 'A')
  const spec = goal({ formationId: 'A', executionMode: 'native' })
  h.runtime.activateNativeGoals(h.runtime.upsertGoal(spec))
  const parts = [unit(1, 'FV'), loaded(2, 4), unit(3, 'ENGINEER'), unit(10, 'MTNK', { hitPoints: 40 }), unit(11, 'HTNK', { hitPoints: 20 })]
  await h.runtime.onSnapshot(snapshot({ seq: 2, tick: 30, self: parts }))
  assert.deepEqual(h.runtime.goals.get(spec.id)!.facts.unitOrders!.orders, {}, '空回执不算已上车')
  await h.runtime.onSnapshot(snapshot({ seq: 3, tick: 45, self: parts }))
  assert.equal(h.runtime.goals.get(spec.id)!.facts.unitOrders!.orders[3], undefined, '失败回执不阻止重试')
  assert.ok(submitted.some(action => action.kind === 'repair' && action.unitIds[0] === 2), '上车被拒绝时另一辆仍维修')
  await h.runtime.onSnapshot(snapshot({ seq: 4, tick: 60, self: parts }))
  assert.equal(h.runtime.goals.get(spec.id)!.facts.unitOrders!.orders[3]!.kind, 'enterTransport')
  assert.ok(submitted.every(action => action.kind !== 'repair' || !action.unitIds.includes(1)), '上车回执不能代替实际载员')
  const ready = [loaded(1, 3), ...parts.filter(unit => ![1, 3].includes(unit.id))]
  await h.runtime.onSnapshot(snapshot({ seq: 5, tick: 75, self: ready }))
  assert.equal(new Set(submitted.filter(action => action.kind === 'repair').map(action => action.targetId)).size, 2)
  const count = submitted.length
  await h.runtime.onSnapshot(snapshot({ seq: 6, tick: 90, self: ready }))
  assert.equal(submitted.length, count, '忙碌的同一目标不反复发令')
  await h.runtime.onSnapshot(snapshot({ seq: 7, tick: 165, self: ready.map(unit => unit.id === 2 ? { ...unit, isIdle: true } : unit) }))
  assert.deepEqual(submitted.slice(count).flatMap(action => 'unitIds' in action ? action.unitIds : []), [2], '只有空闲且到重试间隔的成员重发')
  h.runtime.pause('formation:A')
  const beforePause = submitted.length
  await h.runtime.onSnapshot(snapshot({ seq: 8, tick: 5000, self: ready }))
  assert.equal(submitted.length, beforePause)
  const saved = persistState(h.runtime), restored = await harness(neverRun, { formations: new FormationRegistry() })
  await restored.runtime.onSnapshot(h.runtime.snapshot!); restoreState(restored.runtime, saved)
  const jobs = restored.runtime.goals.get(spec.id)!.facts.repair!.jobs.map(job => [job.unitId, job.targetId])
  restored.runtime.resume('formation:A')
  await restored.runtime.onSnapshot(snapshot({ seq: 9, tick: 5015, self: ready }))
  assert.deepEqual(restored.runtime.goals.get(spec.id)!.facts.repair!.jobs.map(job => [job.unitId, job.targetId]), jobs, '暂停不累计受阻时长或重分工')
  const healed = ready.map(unit => [10, 11].includes(unit.id) ? { ...unit, hitPoints: unit.maxHitPoints! } : unit)
  await restored.runtime.onSnapshot(snapshot({ seq: 10, tick: 5030, self: healed }))
  assert.deepEqual(new Set(restored.submitted.filter(action => action.kind === 'stop').flatMap(action => action.unitIds)), new Set([1, 2]))
  assert.equal(restored.runtime.goalExecution(spec.id)!.state, 'continuous', '全部修满仍持续待命')
  await restored.runtime.onSnapshot(snapshot({ seq: 11, tick: 5045, self: ready.filter(unit => unit.id !== 1) }))
  assert.equal(restored.runtime.goals.get(spec.id)!.status, 'active', '单车损失后剩余成员继续')
  await restored.runtime.onSnapshot(snapshot({ seq: 12, tick: 5060, self: healed.filter(unit => ![1, 2].includes(unit.id)) }))
  assert.equal(restored.runtime.goals.get(spec.id)!.status, 'failed')
  assert.ok(restored.submitted.every(action => action.kind !== 'produce'))
})

test('现有维修队直接本机跟随指定队，发现伤员改为对象维修，目标离队后停止旧指令', async () => {
  const f = await fixture()
  try {
    await f.tick([...f.runtime.snapshot!.self.map(unit => unit.id === 60 ? { ...unit, hitPoints: 100 } : unit), loaded(1, 3), loaded(2, 4)])
    f.formations.create('维修队', [1, 2]); f.formations.create('坦克队', [60])
    const execution = await executeCapabilities([{ capability: 'vehicle.repair', params: { formationId: '维修队', followFormationId: '坦克队' } }], f.ctx,
      { text: '维修队跟随坦克队维修', prompts: f.prompts, catalog: f.catalog })
    assert.deepEqual(execution.skipped, [])
    assert.equal(f.generations(), 0)
    await f.tick()
    assert.deepEqual(new Set(f.submitted.filter(action => action.kind === 'move').flatMap(action => action.unitIds)), new Set([1, 2]))
    assert.equal(f.submitted.some(action => action.kind === 'repair'), false, '不修理队外伤员')
    await f.tick(f.runtime.snapshot!.self.map(unit => unit.id === 60 ? { ...unit, hitPoints: 40 } : unit))
    assert.deepEqual(f.submitted.filter(action => action.kind === 'repair').map(action => action.targetId), [60, 60])
    f.formations.create('其他队', []); f.formations.transfer([60], '其他队')
    await f.tick()
    assert.deepEqual(new Set(f.submitted.filter(action => action.kind === 'stop').flatMap(action => action.unitIds)), new Set([1, 2]))
    assert.ok(f.submitted.every(action => !('unitIds' in action) || !action.unitIds.some(id => [60, 61].includes(id))), '不移动被支援队或其他坦克')
    assert.equal(f.generations(), 0)
  } finally { await f.executor.dispose() }
})

test('维修车显式脚本回退及无标记旧存档保留原执行方式和上车配对', async () => {
  const previous = process.env.RA2C_REPAIR_EXECUTOR
  process.env.RA2C_REPAIR_EXECUTOR = 'script'
  const f = await fixture()
  try {
    await f.tick([...f.runtime.snapshot!.self, unit(1, 'FV'), unit(3, 'ENGINEER')])
    await f.run({ memberSource: 'existing', formationId: '维修队' }); await f.tick(); await f.tick()
    assert.equal(f.generations(), 2)
    const run = [...f.runtime.skillRuns.values()][0]!
    assert.ok(run.kind === 'repair-vehicle')
    const saved = persistState(f.runtime)
    for (const [, state] of saved.goals) { delete state.spec.executionMode; if (state.activeSpec) delete state.activeSpec.executionMode }
    if (previous === undefined) delete process.env.RA2C_REPAIR_EXECUTOR
    else process.env.RA2C_REPAIR_EXECUTOR = previous
    const restored = await harness(f.executor, { formations: new FormationRegistry() })
    await restored.runtime.onSnapshot(f.runtime.snapshot!); restoreState(restored.runtime, saved)
    assert.equal(goalExecutionMode(restored.runtime.goals.get(run.repairGoalId)!.spec), 'script')
    assert.ok(restored.runtime.programs.get('formation:维修队')!.script)
    await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 1, tick: f.runtime.snapshot!.tick + 15 })
    assert.ok(restored.submitted.some(action => action.kind === 'enterTransport'))
    assert.deepEqual(restored.runtime.goals.get(run.repairGoalId)!.facts.repair!.pairs, f.runtime.goals.get(run.repairGoalId)!.facts.repair!.pairs)
  } finally {
    if (previous === undefined) delete process.env.RA2C_REPAIR_EXECUTOR
    else process.env.RA2C_REPAIR_EXECUTOR = previous
    await f.executor.dispose()
  }
})
