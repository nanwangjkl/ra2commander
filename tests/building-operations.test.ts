import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActionRequest, SnapshotUnit } from '../packages/contracts/src/index.ts'
import { validateActions } from '../packages/contracts/src/index.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { FormationRegistry, persistState, restoreState } from '../packages/runtime/src/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { runTranscript } from '../apps/companion/src/transcript.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { activate, deferred, harness, snapshot } from './helpers.ts'

const source = `function step(s,m){const actions=[];for(const g of s.control.goals){if(g.spec.kind==='building')for(const request of g.building.actions)actions.push({goalId:g.spec.id,request});}return {actions,memory:m}}`
async function fixture() {
  const executor = new StepExecutor(), root = mkdtempSync(join(tmpdir(), 'ra2c-building-'))
  let own: SnapshotUnit[] = [
    { id: 1, name: 'GACNST', type: 2, hitPoints: 1000, maxHitPoints: 1000, hasWrenchRepair: false, rx: 10, ry: 10, isIdle: true },
    { id: 2, name: 'GAREFN', type: 2, hitPoints: 850, maxHitPoints: 1000, hasWrenchRepair: false, rx: 12, ry: 12, isIdle: true },
    { id: 3, name: 'GAPOWR', type: 2, hitPoints: 500, maxHitPoints: 750, hasWrenchRepair: true, rx: 14, ry: 14, isIdle: true },
    { id: 4, name: 'GTGCAN', type: 2, hitPoints: 1000, maxHitPoints: 1000, hasWrenchRepair: false, rx: 16, ry: 16, isIdle: true },
    { id: 5, name: 'MTNK', type: 7, hitPoints: 100, maxHitPoints: 300, rx: 20, ry: 20, isIdle: true },
  ]
  let credits = 1000
  const submitted: ActionRequest[] = []
  const { runtime, formations } = await harness(executor, { formations: new FormationRegistry(), submit: async (actions, context, guard) => {
    if (!guard()) return []
    submitted.push(...actions)
    for (const action of actions) if (action.kind === 'repairBuilding') own = own.map(unit => action.unitIds.includes(unit.id) ? { ...unit, hasWrenchRepair: true } : unit)
    return actions.map(() => ({ ok: true, submitted: 1, session: context.session }))
  } })
  await runtime.onSnapshot(snapshot({ seq: 2, self: own }))
  const provider = { generate: async ({ messages }: { messages: Array<{ content: string }> }) => {
    const input = JSON.parse(messages[1]!.content)
    assert.ok(!input.failures)
    return { text: 'text' in input ? JSON.stringify({ summary: '原生建筑操作', operations: [{ capability: /卖|出售/.test(input.text) ? 'building.sell' : 'building.repair', params: {} }] }) : source, model: 'fixture', durationMs: 0 }
  } }
  const controller = new ProgramController({ runtime, executor, provider: () => provider as never })
  const ctx = { runtime, formations, controller, currentProvider: () => provider, bridge: {
    rules: async (name: string, type: number) => ({ GACNST: 2, GAREFN: 2, GAPOWR: 2, GTGCAN: 2, MTNK: 7 }[name] === type ? { label: name, prerequisite: [], unsellable: name === 'GTGCAN' } : undefined),
  } } as unknown as CommandContext
  return { ctx, runtime, executor, submitted,
    goals: () => [...runtime.goals.values()].filter(goal => goal.spec.kind === 'building'),
    voice: (text: string) => runTranscript(text, ctx, root),
    credits: (value: number) => { credits = value },
    heal: (id: number) => { own = own.map(unit => unit.id === id ? { ...unit, hitPoints: unit.maxHitPoints! } : unit) },
    remove: (ids: number[]) => { own = own.filter(unit => !ids.includes(unit.id)) },
    addBuilding: () => { own.push({ ...own[0]!, id: 7, name: 'GAPOWR' }) },
    tick: async (delta = 30) => runtime.onSnapshot({ ...runtime.snapshot!, credits, self: own, seq: runtime.snapshot!.seq + 1, tick: runtime.snapshot!.tick + delta }),
    dispose: async () => { await executor.dispose(); rmSync(root, { recursive: true, force: true }) },
  }
}

test('反馈“维修受损建筑”走原生扳手，仅开启未开启者；满血确认完成，无需维修车', async () => {
  const f = await fixture()
  try {
    await f.voice('维修受损的建筑'); await f.tick(); await f.tick()
    assert.deepEqual(f.submitted, [{ kind: 'repairBuilding', unitIds: [2] }])
    assert.equal(f.runtime.goalExecution(f.goals()[0]!.spec.id)?.state, 'running')
    await f.voice('维修受损的建筑'); await f.tick()
    assert.equal(f.submitted.length, 1, '重复语音不关闭已开启的扳手')
    assert.equal(f.goals()[0]!.status, 'cancelled')
    const current = f.goals().at(-1)!
    f.heal(2); await f.tick()
    assert.equal(f.runtime.goalExecution(current.spec.id)?.progress?.completed, 1)
    f.heal(3); await f.tick()
    assert.equal(f.runtime.goalExecution(current.spec.id)?.state, 'completed')
    const before = f.runtime.goals.size
    assert.match(await f.voice('维修受损的建筑'), /没有匹配的受损/)
    assert.equal(f.runtime.goals.size, before)
  } finally { await f.dispose() }
})

test('维修缺钱保持 pending，恢复资金后推进；同局恢复不重复切换维修开关', async () => {
  const f = await fixture()
  try {
    f.credits(0); await f.tick(); await f.voice('维修受损的建筑'); await f.tick()
    assert.equal(f.runtime.goalExecution(f.goals()[0]!.spec.id)?.state, 'pending')
    assert.deepEqual(f.submitted, [])
    f.credits(1000); await f.tick(); await f.tick()
    const restored = await harness(f.executor, { formations: new FormationRegistry() })
    await restored.runtime.onSnapshot(f.runtime.snapshot!)
    restoreState(restored.runtime, JSON.parse(JSON.stringify(persistState(f.runtime))))
    await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 1, tick: f.runtime.snapshot!.tick + 300 })
    assert.deepEqual(restored.submitted, [])
    await f.runtime.cancelGoal(f.goals()[0]!.spec.id); await f.tick(300)
    assert.equal(f.submitted.length, 1)
  } finally { await f.dispose() }
})

test('反馈“卖掉所有建筑”只出售当前己方可售建筑，等待真实离场并保留恢复进度', async () => {
  const f = await fixture()
  try {
    await f.voice('维修受损的建筑')
    const repair = f.goals()[0]!
    const result = await f.voice('卖掉所有的建筑')
    assert.match(result, /规则禁止出售/)
    assert.equal(repair.status, 'cancelled')
    await f.tick()
    const soldIds = f.submitted.flatMap(action => action.kind === 'sellBuilding' ? action.unitIds : [])
    assert.deepEqual(soldIds, [1, 2, 3])
    const sell = f.goals().at(-1)!
    assert.equal(sell.status, 'active', '接口成功不能代替实际离场')
    f.addBuilding(); f.remove([2]); await f.tick()
    assert.equal(f.runtime.goalExecution(sell.spec.id)?.progress?.completed, 1)
    await f.ctx.controller.refresh('global')
    const restored = await harness(f.executor, { formations: new FormationRegistry() })
    await restored.runtime.onSnapshot(f.runtime.snapshot!)
    restoreState(restored.runtime, JSON.parse(JSON.stringify(persistState(f.runtime))))
    await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 1, tick: f.runtime.snapshot!.tick + 15 })
    assert.deepEqual(restored.submitted, [])
    await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, self: f.runtime.snapshot!.self.filter(unit => ![1, 3].includes(unit.id)), seq: f.runtime.snapshot!.seq + 2, tick: f.runtime.snapshot!.tick + 30 })
    assert.equal(restored.runtime.goalExecution(sell.spec.id)?.state, 'completed')
    assert.ok(restored.runtime.snapshot!.self.some(unit => unit.id === 7), '不出售后来新建的建筑')
    assert.ok(restored.runtime.snapshot!.self.some(unit => unit.id === 5), '不出售坦克')
    assert.deepEqual(restored.submitted, [])
  } finally { await f.dispose() }
})

test('取消出售停止后续动作；宿主拒绝将出售或建筑维修作用于车辆和敌人', async () => {
  const f = await fixture()
  try {
    await f.voice('卖掉所有的建筑')
    await f.runtime.cancelGoal(f.goals()[0]!.spec.id)
    await f.tick()
    assert.deepEqual(f.submitted, [])
    const constraints = { allowedUnitIds: [2, 5, 99], enemyIds: [99], mapWidth: 100, mapHeight: 100, allowedActions: ['sellBuilding', 'repairBuilding'] as const }
    for (const kind of ['sellBuilding', 'repairBuilding'] as const) for (const id of [5, 99]) assert.match(validateActions([{ kind, unitIds: [id] }], { ...constraints, allowedActions: [...constraints.allowedActions] }, f.runtime.snapshot!)!, /己方建筑/)
  } finally { await f.dispose() }
})

test('出售回执迟于建筑离场时保留实际完成事实，不误记为失败', async () => {
  const executor = new StepExecutor(), started = deferred<void>(), result = deferred<Array<{ ok: boolean; submitted: number; session: number }>>()
  try {
    const { runtime } = await harness(executor, { formations: new FormationRegistry(), submit: async () => { started.resolve(); return result.promise } })
    const initial = snapshot({ seq: 2, self: [{ id: 1, name: 'GACNST', type: 2, rx: 10, ry: 10, isIdle: true }] })
    await runtime.onSnapshot(initial)
    activate(runtime, { id: 'sell', kind: 'building', operation: 'sell', unitIds: [1], rawText: '出售基地' }, source)
    const sending = runtime.onSnapshot({ ...initial, seq: 3, tick: 30 })
    await started.promise
    const observation = runtime.onSnapshot({ ...initial, self: [], seq: 4, tick: 45 })
    result.resolve([{ ok: true, submitted: 1, session: initial.session }])
    await Promise.all([sending, observation])
    assert.equal(runtime.goalExecution('sell')?.state, 'completed')
    assert.equal(runtime.goalExecution('sell')?.progress?.completed, 1)
  } finally { await executor.dispose() }
})
