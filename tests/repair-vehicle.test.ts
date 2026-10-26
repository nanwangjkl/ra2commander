import test from 'node:test'
import assert from 'node:assert/strict'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { loadPrompts } from '../packages/command/src/index.ts'
import { FormationRegistry, persistState, restoreState } from '../packages/runtime/src/index.ts'
import { planRepairs, emptyRepairState } from '../packages/runtime/src/repair.ts'
import type { RepairGoal, SnapshotUnit } from '../packages/contracts/src/index.ts'
import { executeCapabilities } from '../apps/companion/src/capabilities/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { GameCatalog } from '../apps/companion/src/game-catalog.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { activate, code, harness, snapshot } from './helpers.ts'

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
    assert.equal(f.generations(), 2)
    const run = [...f.runtime.skillRuns.values()][0]!
    assert.ok(run.kind === 'repair-vehicle')
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

test('已有组件可组装而不生产；给维修队新命令后旧 Skill 不再接管', async () => {
  const f = await fixture()
  try {
    await f.tick([...f.runtime.snapshot!.self, unit(1, 'FV'), unit(3, 'ENGINEER')])
    const execution = await f.run({ memberSource: 'existing', formationId: '维修队' })
    assert.deepEqual(execution.skipped, [])
    await f.tick(); await f.tick()
    assert.equal(f.submitted.some(a => a.kind === 'produce'), false)
    assert.ok(f.submitted.some(a => a.kind === 'enterTransport'))
    const run = [...f.runtime.skillRuns.values()][0]!
    activate(f.runtime, { id: 'new-order', kind: 'combat', rawText: '原地待命', formationId: run.formationId, mode: 'hold', region: { name: '全图', x1: 0, y1: 0, x2: 99, y2: 99 }, allowedActions: ['stop'] }, code)
    const before = f.submitted.length
    await f.tick()
    assert.equal(run.status, 'superseded')
    assert.equal(f.submitted.length, before)
  } finally { await f.executor.dispose() }
})
