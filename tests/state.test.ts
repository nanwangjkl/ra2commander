import test from 'node:test'
import assert from 'node:assert/strict'
import { FormationRegistry, persistState, restoreState } from '../packages/runtime/src/index.ts'
import type { Snapshot } from '../packages/contracts/src/index.ts'
import { activate, code, deferred, harness, outcome, production, snapshot, spec } from './helpers.ts'

const producer = { run: async (_code: string, value: unknown) => {
  const goal = (value as Snapshot).control!.goals[0]!
  const remaining = goal.produceRemaining.MTNK ?? 0
  return outcome(remaining ? [{ kind: 'produce', name: 'MTNK', quantity: remaining }] : [], {}, goal.spec.id)
} }

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
