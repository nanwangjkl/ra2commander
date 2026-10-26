import test from 'node:test'
import assert from 'node:assert/strict'
import { FormationRegistry, initialMining, observeOre, persistState, restoreState } from '../packages/runtime/src/index.ts'
import type { GoalSpec, MiningGoal } from '../packages/contracts/src/index.ts'
import { activate, harness, outcome, production, snapshot, spec } from './helpers.ts'

const region = { id: 'r', name: '矿区', polygons: [{ outer: [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]] as [number, number][], holes: [] }] }
const mining: MiningGoal = { id: 'mining', rawText: '采矿', kind: 'mining', unitIds: [2], targetRegion: region, destination: { x: 10, y: 10 } }
const idle = { run: async () => outcome([]) }

test('新命令与恢复共用规格校验；恢复校验失败不留下半套状态', async () => {
  const cases: Array<{ valid: GoalSpec; invalid: GoalSpec }> = [
    { valid: production(), invalid: production({ quantity: 0 }) },
    { valid: spec(), invalid: spec({ route: [{ x: -1, y: 3 }] }) },
    { valid: mining, invalid: { ...mining, destination: { x: 40, y: 40 } } },
  ]
  for (const { valid, invalid } of cases) {
    const source = await harness(idle)
    source.runtime.upsertGoal(valid)
    const saved = persistState(source.runtime)
    let message = ''
    assert.throws(() => source.runtime.upsertGoal(invalid), error => { message = (error as Error).message; return true })
    saved.goals[0]![1].spec = invalid
    const target = await harness(idle, { formations: new FormationRegistry() })
    assert.throws(() => restoreState(target.runtime, saved), error => (error as Error).message === message)
    assert.equal(target.runtime.goals.size, 0)
    assert.equal(target.runtime.programs.size, 0)
    assert.equal(target.formations.list().length, 0)
  }
  const source = await harness(idle)
  source.runtime.upsertGoal(mining)
  source.runtime.goals.get(mining.id)!.facts.mining = { ...initialMining(), cursor: -1 }
  assert.throws(() => source.runtime.upsertGoal(mining), /采矿观察或发令进度非法/)
  const target = await harness(idle, { formations: new FormationRegistry() })
  assert.throws(() => restoreState(target.runtime, persistState(source.runtime)), /采矿观察或发令进度非法/)
  assert.equal(target.runtime.goals.size, 0)

})

test('同一快照内，额度、矿格观察与归属变化立即进入执行帧和状态展示', async () => {
  const { runtime, formations } = await harness(idle)
  activate(runtime, production())
  activate(runtime, mining)
  const lease = runtime.beginCompile('global')
  const before = runtime.compileFrame(lease)
  const beforeProduction = before.snapshot.control!.goals.find(goal => goal.spec.kind === 'production')!
  assert.equal(beforeProduction.produceRemaining.MTNK, 1)
  assert.equal(before.snapshot.control!.goals.find(goal => goal.spec.kind === 'mining')!.mining!.knownOre, 0)
  runtime.production.push({ id: 'reserved', goalId: 'production', name: 'MTNK', quantity: 1, building: false, state: 'reserved', observedIds: [], placed: false })
  const facts = runtime.goals.get(mining.id)!.facts.mining ??= initialMining()
  observeOre(facts, mining, 100, { ore: [1010], seen: [1010] }, { cursor: 1, passes: 0 }, runtime.snapshot!.tick)
  const current = runtime.compileFrame(lease)
  assert.equal(current.constraints.goals!.production!.produceRemaining!.MTNK, 0)
  assert.equal(current.snapshot.control!.goals.find(goal => goal.spec.kind === 'mining')!.mining!.knownOre, 1)
  assert.equal(runtime.goalExecution('production')!.state, 'blocked')
  runtime.releaseCommand(lease)
  assert.equal(formations.create('矿队', [2]).ok, true)
  const next = runtime.beginCompile('global'), transferred = runtime.compileFrame(next)
  assert.deepEqual(transferred.constraints.goals!.mining!.allowedUnitIds, [])
  assert.equal(transferred.snapshot.control!.goals.find(goal => goal.spec.kind === 'mining')!.mining!.total, 0)
  runtime.releaseCommand(next)
  assert.equal(runtime.snapshot!.seq, snapshot().seq, '以上变化没有等待新快照')
})

test('旧 v4 的 done 不控制完成，恢复保留生产台账与待生效要求', async () => {
  const source = await harness(idle)
  activate(source.runtime, production({ quantity: 2 }))
  source.runtime.upsertGoal(production({ quantity: 3 }))
  source.runtime.production.push({ id: 'sent', goalId: 'production', name: 'MTNK', quantity: 1, building: false, state: 'submitted', observedIds: [], placed: false })
  const saved = JSON.parse(JSON.stringify(persistState(source.runtime)))
  saved.goals[0][1].facts.done = true
  const target = await harness({ run: async (_code, value) => {
    const view = (value as import('../packages/contracts/src/index.ts').Snapshot).control!.goals[0]!
    return outcome(view.produceRemaining.MTNK ? [{ kind: 'produce', name: 'MTNK', quantity: view.produceRemaining.MTNK }] : [], {}, view.spec.id)
  } }, { formations: new FormationRegistry() })
  restoreState(target.runtime, saved)
  const goal = target.runtime.goals.get('production')!
  assert.equal(goal.spec.kind === 'production' && goal.spec.quantity, 3)
  assert.equal(goal.activeSpec?.kind === 'production' && goal.activeSpec.quantity, 2)
  assert.equal('done' in goal.facts, false)
  await target.runtime.onSnapshot(snapshot({ seq: 2 }))
  await target.runtime.onSnapshot(snapshot({ seq: 3 }))
  assert.deepEqual(target.submitted, [{ kind: 'produce', name: 'MTNK', quantity: 1 }], '生效总量仍为 2，旧提交不重放，待生效增量不提前执行')
  assert.equal(goal.status, 'active', '提交未代替实际完成')
  assert.equal(persistState(target.runtime).version, 4)
})
