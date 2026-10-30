import test from 'node:test'
import assert from 'node:assert/strict'
import { FormationRegistry, persistState, restoreState } from '../packages/runtime/src/index.ts'
import type { Snapshot } from '../packages/contracts/src/index.ts'
import { activate, code, deferred, harness, outcome, production, snapshot, spec } from './helpers.ts'
import { emptyCoverMotion } from '../packages/runtime/src/cover.ts'

const producer = { run: async (_code: string, value: unknown) => {
  const goal = (value as Snapshot).control!.goals[0]!
  const remaining = goal.produceRemaining.MTNK ?? 0
  return outcome(remaining ? [{ kind: 'produce', name: 'MTNK', quantity: remaining }] : [], {}, goal.spec.id)
} }

test('旧 v3/v4 掩护字段中的发令与集火记录恢复为通用事实，不重复发令或改选目标', async () => {
  for (const version of [3, 4] as const) {
    const h = await harness({ run: async () => outcome() })
    const own = [{ ...snapshot().self[0]!, isIdle: false }]
    const enemies = [{ ...snapshot().enemies[0]!, rx: 80 }, { ...snapshot().enemies[0]!, id: 100, rx: 6 }]
    const frame = snapshot({ seq: 2, self: own, enemies })
    await h.runtime.onSnapshot(frame)
    const goal = spec({ executionMode: 'native', region: { name: '全图', x1: 0, y1: 0, x2: 99, y2: 99 },
      objective: { coordination: 'focus', target: { kind: 'enemies', names: [] }, search: { kind: 'map' }, completion: { ground: 'continuous', aircraft: 'single-shot' } } })
    h.runtime.activateNativeGoals(h.runtime.upsertGoal(goal))
    const saved = persistState(h.runtime)
    saved.version = version
    // 旧版本真实字段形状：普通作战也把订单和主目标写在 coverMotion 下。
    saved.goals[0]![1].facts.coverMotion = Object.assign(emptyCoverMotion(), {
      orders: { 1: { kind: 'attack', targetId: 99, tick: frame.tick } }, focusTargetId: 99,
    })
    const original = structuredClone(saved)
    const next = await harness({ run: async () => outcome() }, { formations: new FormationRegistry() })
    await next.runtime.onSnapshot(frame)
    restoreState(next.runtime, saved)
    const facts = next.runtime.goals.get(goal.id)!.facts
    assert.equal(facts.unitOrders!.focusTargetId, 99)
    assert.equal(Object.hasOwn(facts.coverMotion!, 'orders'), false)
    await next.runtime.onSnapshot({ ...frame, seq: 3 })
    assert.deepEqual(next.submitted, [], '仍忙于原目标时沿用已确认的攻击，不改打更近目标')
    next.runtime.pause('formation:A'); next.runtime.resume('formation:A')
    await next.runtime.onSnapshot({ ...frame, seq: 4 })
    assert.deepEqual(next.submitted, [{ kind: 'attack', unitIds: [1], targetId: 99 }])
    assert.deepEqual(saved, original, '兼容转换不改写调用方传入的旧检查点')
  }
})

test('普通本机攻击仅保存通用发令事实，失败回执不抑制重试，成功后去重及恢复均有效', async () => {
  let attempts = 0
  const h = await harness({ run: async () => outcome() }, { submit: async () => {
    attempts++
    return [{ ok: attempts > 1, submitted: attempts > 1 ? 1 : 0, session: 1, ...(attempts === 1 ? { reason: 'stale-snapshot' } : {}) }]
  } })
  const frame = snapshot({ seq: 2, self: [{ ...snapshot().self[0]!, isIdle: false }] })
  h.runtime.activateNativeGoals(h.runtime.upsertGoal(spec({ executionMode: 'native' })))
  await h.runtime.onSnapshot(frame)
  assert.deepEqual(h.runtime.goals.get('alpha')!.facts.unitOrders!.orders, {})
  await h.runtime.onSnapshot({ ...frame, seq: 3 })
  await h.runtime.onSnapshot({ ...frame, seq: 4 })
  assert.equal(attempts, 2)
  assert.equal(h.runtime.goals.get('alpha')!.facts.coverMotion, undefined)
  const next = await harness({ run: async () => outcome() }, { formations: new FormationRegistry() })
  await next.runtime.onSnapshot({ ...frame, seq: 4 })
  restoreState(next.runtime, persistState(h.runtime))
  await next.runtime.onSnapshot({ ...frame, seq: 5 })
  assert.deepEqual(next.submitted, [])
})

test('生产提交后，修复或恢复脚本不会重复下单', async () => {
  const { runtime, submitted } = await harness(producer)
  activate(runtime, production())
  await runtime.onSnapshot(snapshot({ seq: 2 }))
  assert.equal(submitted.length, 1)
  runtime.pause('global')
  const repair = runtime.beginCompile('global', true)
  assert.equal(runtime.commitCompile(repair, code), true)
  await runtime.onSnapshot(snapshot({ seq: 3 }))
  assert.equal(submitted.length, 1)
  const saved = JSON.parse(JSON.stringify(persistState(runtime)))
  const next = await harness(producer, { formations: new FormationRegistry() })
  restoreState(next.runtime, saved)
  await next.runtime.onSnapshot(snapshot({ seq: 4 }))
  assert.deepEqual(next.submitted, [])
})

test('正常部署转换不计阵亡，转换后的身份继续跟踪', async () => {
  const formations = new FormationRegistry()
  formations.create('A', [1, 2])
  const { runtime } = await harness({ run: async () => outcome() }, { formations })
  const initial = snapshot({ seq: 2, self: [{ ...snapshot().self[0]!, name: 'MCV' }, snapshot().self[1]!] })
  await runtime.onSnapshot(initial)
  activate(runtime, spec({ transforms: { MCV: 'CNST' } }))
  const converted = { ...initial.self[0]!, id: 42, name: 'CNST', type: 2 }
  await runtime.onSnapshot(snapshot({ seq: 3, self: [converted, initial.self[1]!] }))
  assert.equal(runtime.goals.get('alpha')!.facts.lossRatio, 0)
  await runtime.onSnapshot(snapshot({ seq: 4, self: [initial.self[1]!] }))
  assert.equal(runtime.goals.get('alpha')!.facts.lossRatio, 0.5)
})

test('移动和守区全灭后结束原任务、保留队名；明确生产与载员存活不会误判全灭', async () => {
  for (const mode of ['move', 'hold', 'assault'] as const) {
    const env = await harness({ run: async () => outcome() })
    activate(env.runtime, spec({ mode, ...(mode === 'move' ? { destination: { x: 9, y: 9 } } : {}) }))
    activate(env.runtime, production({ formationId: 'A' }))
    await env.runtime.onSnapshot(snapshot({ seq: 2, self: [] }))
    assert.equal(env.runtime.goals.get('alpha')!.status, 'active', '明确生产尚未结束，暂时空队保持等待')
    await env.runtime.cancelGoal('production')
    const carrier = { ...snapshot().self[0]!, id: 50, transport: { occupied: 1, capacity: 5, unitIds: [1] } }
    await env.runtime.onSnapshot(snapshot({ seq: 3, self: [carrier] }))
    assert.equal(env.runtime.goals.get('alpha')!.status, 'active', '上车成员仍存活')
    await env.runtime.onSnapshot(snapshot({ seq: 4, self: [] }))
    assert.equal(env.runtime.goalExecution('alpha')!.state, 'failed')
    assert.match(env.runtime.goalExecution('alpha')!.detail!, /保留队名/)
    assert.ok(env.formations.list().some(formation => formation.id === 'A'))
    assert.equal(env.runtime.programs.get('formation:A')!.status, 'idle')
    const saved = persistState(env.runtime), restored = await harness({ run: async () => outcome() }, { formations: new FormationRegistry() })
    await restored.runtime.onSnapshot(snapshot({ seq: 4, self: [] }))
    restoreState(restored.runtime, saved)
    restored.formations.transfer([60], 'A')
    await restored.runtime.onSnapshot(snapshot({ seq: 5, self: [{ ...snapshot().self[0]!, id: 60 }] }))
    assert.equal(restored.runtime.goals.get('alpha')!.status, 'failed', '补进新成员不自动复活已经结束的原任务')
    assert.deepEqual(restored.submitted, [])
  }
})

test('取消或替换任务后冻结旧变形事实，附近新产物正常记入生产', async () => {
  for (const exit of ['cancel', 'replace'] as const) {
    const { runtime } = await harness({ run: async () => outcome() })
    const tank = snapshot().self[0]!
    await runtime.onSnapshot(snapshot({ seq: 2, self: [tank] }))
    activate(runtime, spec({ transforms: { MTNK: 'DMTK', DMTK: 'MTNK' } }))
    await runtime.onSnapshot(snapshot({ seq: 3, self: [{ ...tank, id: 40, name: 'DMTK', type: 2 }] }))
    if (exit === 'cancel') await runtime.cancelGoal('alpha')
    else activate(runtime, spec({ id: 'replacement' }))
    const frozen = structuredClone(runtime.goals.get('alpha')!.facts)
    activate(runtime, production())
    runtime.production.push({ id: 'queued', goalId: 'production', name: 'MTNK', quantity: 1, building: false, state: 'submitted', observedIds: [], placed: false })
    await runtime.onSnapshot(snapshot({ seq: 4, self: [{ ...tank, id: 50 }] }))
    assert.deepEqual(runtime.goals.get('alpha')!.facts, frozen, exit)
    assert.deepEqual(runtime.production[0]!.observedIds, [50], exit)
    assert.equal(runtime.goalExecution('production')!.state, 'completed', exit)
  }
})

test('生产提交确认期间收到新快照，不丢失进度或重复下单', async () => {
  const acknowledged = deferred<void>()
  let submissions = 0
  const { runtime } = await harness({ run: async (_code, value, memory) => {
    const view = (value as Snapshot).control!.goals[0]!
    return view.produceRemaining.MTNK ? outcome([{ kind: 'produce', name: 'MTNK', quantity: 1 }], { sent: true }, view.spec.id) : outcome([], memory)
  } }, { submit: async () => { submissions++; await acknowledged.promise; return [{ ok: true, submitted: 1, session: 1 }] } })
  activate(runtime, production())
  const first = runtime.onSnapshot(snapshot({ seq: 2 }))
  await new Promise(resolve => setImmediate(resolve))
  const latest = runtime.onSnapshot(snapshot({ seq: 3 }))
  acknowledged.resolve()
  await Promise.all([first, latest])
  assert.equal(submissions, 1)
  assert.equal(runtime.programs.get('global')!.stats.errors, 0)
  assert.deepEqual(runtime.programs.get('global')!.memory, { sent: true })
})
