import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SnapshotUnit } from '../packages/contracts/src/index.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { loadPrompts } from '../packages/command/src/index.ts'
import { FormationRegistry, persistState, restoreState } from '../packages/runtime/src/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { executeCapabilities } from '../apps/companion/src/capabilities/index.ts'
import { runTranscript } from '../apps/companion/src/transcript.ts'
import { retainBindingScope } from '../apps/companion/src/capabilities/binding-recovery.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { harness, snapshot, production } from './helpers.ts'
import { normalizeOperations } from '../apps/companion/src/transcript-plan.ts'
import { loadGameCatalog } from '../apps/companion/src/game-catalog.ts'
import { loadIceMap } from '../apps/companion/src/map-binding.ts'

const game = loadPrompts().game
const source = `function step(s,m){const actions=[];for(const g of s.control.goals){if(g.spec.kind!=='production')continue;for(const name of g.productionPlan.readyToPlace)actions.push({goalId:g.spec.id,request:{kind:'place',name}});for(const name of g.productionPlan.availableToProduce)actions.push({goalId:g.spec.id,request:{kind:'produce',name,quantity:g.produceRemaining[name]}});const c=s.constraints.goals[g.spec.id];if(c.management?.allowedUnitIds.length)actions.push({goalId:g.spec.id,request:{kind:c.management.kind,formationId:c.management.formationId,unitIds:c.management.allowedUnitIds}});}return {actions,memory:m}}`
const member = (id: number, name: string, deployed = false, x = 50, y = 50): SnapshotUnit => ({ id, name, type: 3, rx: x, ry: y, isIdle: true, canDeploy: true, isDeployed: deployed })
async function fixture(factories = false) {
  const executor = new StepExecutor(), root = mkdtempSync(join(tmpdir(), 'ra2c-unit-deploy-'))
  const h = await harness(executor, { formations: new FormationRegistry(), ...(factories ? {
    factorySites: async () => [{ id: 20, name: 'NAHAND', x: 20, y: 20, factory: 2, foundation: { width: 2, height: 2 }, elevation: 0 }],
    rallyTiles: async (points: Array<{ x: number; y: number }>) => points.map(point => ({ ...point, z: 0, landType: 0 })),
  } : {}) })
  const own: SnapshotUnit[] = [member(1, 'E1'), member(2, 'DESO', true), member(3, 'GGI'), { id: 4, name: 'MTNK', type: 7, rx: 50, ry: 50, isIdle: true, canDeploy: true }, { id: 20, name: 'NAHAND', type: 2, rx: 20, ry: 20, elevation: 0, isIdle: true }]
  await h.runtime.onSnapshot(snapshot({ seq: 2, mapWidth: 200, mapHeight: 200, self: own, production: { ...snapshot().production!, available: ['DESO', 'E1', 'GGI', 'NAHAND'], queues: [{ type: 2, status: 0, size: 0, maxSize: 99, items: [] }] } }))
  const requests: string[] = []
  let operations: unknown[] = []
  const provider = { generate: async ({ messages }: { messages: Array<{ content: string }> }) => {
    const input = JSON.parse(messages[1]!.content)
    requests.push('text' in input ? 'interpret' : 'compile')
    assert.ok(!input.failures, '正确关联生产来源，不需要虚构编队后重试')
    return { text: 'text' in input ? JSON.stringify({ summary: '部署', operations }) : source, model: 'fixture', durationMs: 0 }
  } }
  const ctx = { ...h, controller: new ProgramController({ runtime: h.runtime, executor, provider: () => provider as never }), currentProvider: () => provider,
    bridge: { rules: async (name: string, type: number) => { const entry = game.entry(name); return entry?.type === type ? { ...entry } : undefined } },
  } as unknown as CommandContext
  return { ...h, ctx, requests, own, root,
    setPlan: (value: unknown[]) => { operations = value },
    voice: (text: string) => runTranscript(text, ctx, root),
    cap: (params: Record<string, unknown>) => executeCapabilities([{ capability: 'unit.deploy', params }], ctx, { text: '部署命令' }),
    tick: async (units = own, delta = 30) => h.runtime.onSnapshot({ ...h.runtime.snapshot!, self: units, seq: h.runtime.snapshot!.seq + 1, tick: h.runtime.snapshot!.tick + delta, time: h.runtime.snapshot!.time + delta / 30 }),
    dispose: async () => { await executor.dispose(); rmSync(root, { recursive: true, force: true }) },
  }
}

test('美国大兵、守卫大兵和辐射工兵统一部署，混编队跳过灰熊，重复指令不反向切换', async () => {
  const f = await fixture()
  try {
    f.formations.create('2队', [1, 2, 3, 4])
    f.setPlan([{ capability: 'combat.move', params: { formationId: '2队', regionName: '二楼左下' } }])
    await f.voice('2队部署')
    await f.tick()
    const actions = f.submitted.filter(action => action.kind === 'deploy')
    assert.deepEqual(actions, [{ kind: 'deploy', unitIds: [1], deployed: true }, { kind: 'deploy', unitIds: [3], deployed: true }])
    assert.deepEqual(f.requests, ['interpret'], '姿态流程不调用脚本生成')
    assert.equal(f.runtime.goalExecution([...f.runtime.goals.keys()].at(-1)!)!.state, 'running', '发令不代表完成')
    f.own[0]!.isDeployed = true; f.own[2]!.isDeployed = true
    await f.tick()
    assert.equal(f.runtime.goalExecution([...f.runtime.goals.keys()].at(-1)!)!.state, 'completed')
    await f.cap({ formationId: '2队' }); await f.tick()
    assert.equal(f.submitted.filter(action => action.kind === 'deploy').length, 2)
    assert.deepEqual(f.formations.membersOf('2队'), [1, 2, 3, 4])
    await f.cap({ formationId: '2队', deployed: false }); await f.tick()
    assert.ok(f.submitted.filter(action => action.kind === 'deploy').slice(2).every(action => action.deployed === false && !action.unitIds.includes(4)))
  } finally { await f.dispose() }
})

test('反馈复现：生产两名辐射工兵后前往部署，不虚构编队、不到集结点不抢操作', async () => {
  const f = await fixture(true)
  try {
    f.setPlan([{ capability: 'production.produce', params: { target: 'DESO', quantity: 2 } }, { capability: 'combat.move', params: { formationId: '辐射工兵', regionName: '二楼左下' } }])
    await f.voice('造两个辐射工兵，去二楼左下部署')
    const deployment = [...f.runtime.goals.values()].find(goal => goal.spec.kind === 'unitDeploy')!
    assert.equal(deployment.spec.kind, 'unitDeploy')
    if (deployment.spec.kind !== 'unitDeploy') throw new Error('missing deployment')
    assert.equal(deployment.spec.sources.length, 1)
    assert.equal(deployment.spec.sources[0]!.quantity, 2)
    assert.equal(deployment.spec.formationId, undefined)
    assert.equal(f.formations.list().length, 0)
    assert.deepEqual(f.requests, ['interpret'])
    await f.tick()
    const born = [member(101, 'DESO', false, 21, 21), member(102, 'DESO', false, 21, 21)]
    await f.tick([...f.own, ...born])
    assert.ok(!f.submitted.some(action => ['move', 'deploy', 'stop'].includes(action.kind) && 'unitIds' in action && action.unitIds.some(id => id >= 101)))
    const rally = f.runtime.factoryRallies.state.settings.find(setting => setting.factoryId === 20)!.point!
    const ready = born.map(unit => ({ ...unit, rx: rally.x, ry: rally.y }))
    await f.tick([...f.own, ...ready])
    assert.deepEqual(f.submitted.filter(action => action.kind === 'move').map(action => action.unitIds), [[101], [102]])
    const target = deployment.spec.destination!
    const arrived = ready.map(unit => ({ ...unit, rx: target.x, ry: target.y }))
    await f.tick([...f.own, ...arrived])
    assert.deepEqual(f.submitted.filter(action => action.kind === 'deploy').map(action => action.unitIds), [[101], [102]])
    await f.tick([...f.own, ...arrived.map(unit => ({ ...unit, isDeployed: true }))])
    assert.equal(f.runtime.goalExecution(deployment.spec.id)!.state, 'completed')
    assert.equal(f.runtime.production.filter(record => record.name === 'DESO').length, 1)
    assert.equal(f.runtime.production.find(record => record.name === 'DESO')!.quantity, 2)
    assert.ok(!f.submitted.some(action => 'unitIds' in action && action.unitIds.includes(2)), '不接管先前已有的同兵种')
  } finally { await f.dispose() }
})

test('先解除已有姿态再赶路，抵达后部署；短时部署完成后不反复施放', async () => {
  const f = await fixture()
  try {
    await f.cap({ unitIds: [2], x: 80, y: 80 }); await f.tick()
    assert.deepEqual(f.submitted, [{ kind: 'deploy', unitIds: [2], deployed: false }])
    f.own[1]!.isDeployed = false; await f.tick()
    assert.deepEqual(f.submitted.at(-1), { kind: 'move', unitIds: [2], x: 80, y: 80 })
    f.own[1]!.rx = 80; f.own[1]!.ry = 80; await f.tick()
    assert.deepEqual(f.submitted.at(-1), { kind: 'deploy', unitIds: [2], deployed: true })
    f.own[1]!.isDeployed = true; await f.tick()
    f.own.push(member(6, 'YURI')); await f.tick()
    await f.cap({ unitIds: [6] }); await f.tick()
    f.own.at(-1)!.isDeployed = true; await f.tick()
    const before = f.submitted.length
    f.own.at(-1)!.isDeployed = false; await f.tick(undefined, 300)
    assert.equal(f.submitted.length, before)
  } finally { await f.dispose() }
})

test('同局恢复保留已确认姿态和待处理成员，停止后不恢复部署；Mod 变形明确跳过', async () => {
  const f = await fixture(), other = await fixture()
  try {
    await f.cap({ unitIds: [1, 3] }); await f.tick()
    f.own[0]!.isDeployed = true; await f.tick()
    const state = persistState(f.runtime)
    other.own[0]!.isDeployed = true
    await other.tick()
    restoreState(other.runtime, state)
    await other.tick(undefined, 30)
    assert.equal(other.submitted.length, 0, '不重放已提交而仍在等待的切换')
    await other.runtime.stop('global'); await other.tick(undefined, 300)
    assert.ok(other.submitted.every(action => action.kind === 'stop'))
    const unsupported = await f.cap({ unitIds: [4] })
    assert.equal(unsupported.goals.length, 0)
    assert.ok(unsupported.skipped.length)
    assert.throws(() => retainBindingScope({ capability: 'unit.deploy', params: { unitIds: [1], deployed: true } }, { capability: 'combat.move', params: { formationId: '2队', x: 10, y: 10 } }, loadPrompts()), /不能丢弃部署/)
  } finally { await f.dispose(); await other.dispose() }
})

test('生产衔接不吞掉同句其他编队移动；改令只接管所选成员，同批其余产物继续原部署', async () => {
  const f = await fixture()
  try {
    const catalog = await loadGameCatalog(f.ctx, () => {}, game), { regions } = await loadIceMap()
    const plan = normalizeOperations('造两个辐射工兵去二楼左下部署，1队去三楼右上', [
      { capability: 'production.produce', params: { target: 'DESO', quantity: 2 } },
      { capability: 'combat.move', params: { formationId: '1队', regionName: '三楼右上' } },
      { capability: 'combat.move', params: { formationId: '辐射工兵', regionName: '二楼左下' } },
    ], regions, catalog)
    assert.ok(plan.some(call => call.capability === 'combat.move' && call.params.formationId === '1队'))
    assert.equal(plan.filter(call => call.capability === 'unit.deploy').length, 1)
    const unrelated = [{ capability: 'production.produce' as const, params: { target: 'E1', quantity: 2 } }]
    assert.equal(normalizeOperations('造两个美国大兵，灰熊部署', unrelated, regions, catalog).filter(call => call.capability === 'unit.deploy').length, 0)
    const existingTeam = normalizeOperations('造两个美国大兵，2队部署', unrelated, regions, catalog).find(call => call.capability === 'unit.deploy')!
    assert.equal(existingTeam.params.source, undefined, '现有编队部署不接管无关生产批次')
    f.own.push(member(107, 'E1')); await f.tick()
    f.runtime.upsertGoal(production({ id: 'batch', target: 'E1', targetType: 3, quantity: 3 }))
    f.runtime.production.push({ id: 'batch-record', goalId: 'batch', name: 'E1', quantity: 3, building: false, state: 'submitted', observedIds: [1, 107], placed: false })
    const oldOwner = f.runtime.upsertGoal({ id: 'deploy-batch', kind: 'unitDeploy', rawText: '本批前往部署', executionMode: 'native', unitIds: [], sources: [{ goalId: 'batch', name: 'E1', quantity: 3 }], deployed: true, destination: { x: 80, y: 80 } })
    f.runtime.activateNativeGoals(oldOwner); await f.tick()
    await f.cap({ unitIds: [1], deployed: false })
    const old = f.runtime.goals.get('deploy-batch')!.spec
    assert.equal(old.kind, 'unitDeploy')
    if (old.kind !== 'unitDeploy') throw new Error('missing deployment')
    assert.deepEqual(old.excludedIds, [1])
    const before = f.submitted.length
    f.own.push(member(108, 'E1')); await f.tick()
    assert.ok(f.submitted.slice(before).every(action => !('unitIds' in action) || !action.unitIds.includes(1)))
    assert.ok(f.submitted.slice(before).some(action => action.kind === 'move' && action.unitIds.includes(108)))
    assert.equal(f.runtime.production.length, 1)
  } finally { await f.dispose() }
})

test('同句新建编队的成员先完成生产交接，再分头移动部署', async () => {
  const f = await fixture()
  try {
    f.setPlan([{ capability: 'production.produce', params: { target: 'DESO', quantity: 2, formationId: '2队' } }, { capability: 'unit.deploy', params: { formationId: '2队', selector: 'DESO', source: 'production', x: 80, y: 80 } }])
    await f.voice('造两个辐射工兵编入2队，去80,80部署'); await f.tick()
    const born = [member(101, 'DESO'), member(102, 'DESO')]
    await f.tick([...f.own, ...born]); await f.tick([...f.own, ...born])
    assert.equal(f.formations.ownerOf(101), '2队')
    assert.equal(f.formations.ownerOf(102), '2队')
    assert.ok(f.submitted.some(action => action.kind === 'move' && action.unitIds.includes(101)))
    assert.ok(f.submitted.some(action => action.kind === 'move' && action.unitIds.includes(102)))
    assert.deepEqual(f.requests, ['interpret'])
    f.formations.dissolve('2队')
    const before = f.submitted.length
    await f.tick([...f.own, ...born], 300)
    const deployment = [...f.runtime.goals.values()].find(goal => goal.spec.kind === 'unitDeploy')!
    assert.equal(f.runtime.goalExecution(deployment.spec.id)!.state, 'failed', '已交接成员离队后不无限等交接，也不继续操作')
    assert.equal(f.submitted.length, before)
  } finally { await f.dispose() }
})
