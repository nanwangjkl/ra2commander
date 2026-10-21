import test from 'node:test'
import assert from 'node:assert/strict'
import { FormationRegistry, persistState, restoreState } from '../packages/runtime/src/index.ts'
import { code, deferred, harness, outcome, snapshot, spec } from './helpers.ts'

test('生产目标完成后，修复或恢复任务不会重复下单', async () => {
  const formations = new FormationRegistry()
  const executor = { run: async () => outcome([{ kind: 'produce' as const, name: 'MTNK', quantity: 1 }]) }
  const { runtime, submitted } = await harness(executor, { formations })
  const production = spec({ unitIds: [], originalMembers: [], allowedProduce: ['MTNK'], produceLimits: { MTNK: 1 } })
  runtime.deploy(production, code)
  await runtime.onSnapshot(snapshot({ seq: 2 }))
  assert.equal(submitted.length, 1)
  runtime.pause('alpha')
  const repair = runtime.beginCommand('alpha', snapshot(), true)
  assert.equal(runtime.commitCommand(repair, production, code), true)
  await runtime.onSnapshot(snapshot({ seq: 3 }))
  assert.equal(submitted.length, 1)
  const saved = JSON.parse(JSON.stringify(persistState(runtime, formations, 1)))
  const nextFormations = new FormationRegistry()
  const next = await harness(executor, { formations: nextFormations })
  restoreState(next.runtime, nextFormations, saved)
  await next.runtime.onSnapshot(snapshot({ seq: 4 }))
  assert.deepEqual(next.submitted, [])
})

test('正常部署转换不计阵亡，转换后的身份继续跟踪', async () => {
  const { runtime } = await harness({ run: async () => outcome() })
  const initial = snapshot({ seq: 2, self: [{ ...snapshot().self[0]!, name: 'MCV' }, snapshot().self[1]!] })
  await runtime.onSnapshot(initial)
  runtime.deploy(spec({ unitIds: [1, 2], originalMembers: [1, 2], transforms: { MCV: 'CNST' } }), code)
  const converted = { ...initial.self[0]!, id: 42, name: 'CNST', type: 2 }
  await runtime.onSnapshot(snapshot({ seq: 3, self: [converted, initial.self[1]!] }))
  assert.equal(runtime.tasks.get('alpha')!.authority.lossRatio, 0)
  await runtime.onSnapshot(snapshot({ seq: 4, self: [initial.self[1]!] }))
  assert.equal(runtime.tasks.get('alpha')!.authority.lossRatio, 0.5)
})

test('生产提交确认期间收到新快照，不丢失进度或重复下单', async () => {
  const acknowledged = deferred<void>()
  let submissions = 0
  const { runtime } = await harness({ run: async (_code, _snap, memory) => {
    return (memory as { sent?: boolean }).sent ? outcome([], memory) : outcome([{ kind: 'produce', name: 'MTNK', quantity: 1 }], { sent: true })
  } }, { submit: async () => { submissions++; await acknowledged.promise; return [{ ok: true, submitted: 1, session: 1 }] } })
  runtime.deploy(spec({ unitIds: [], originalMembers: [], allowedProduce: ['MTNK'], produceLimits: { MTNK: 1 } }), code)
  const first = runtime.onSnapshot(snapshot({ seq: 2 }))
  await new Promise(resolve => setImmediate(resolve))
  const latest = runtime.onSnapshot(snapshot({ seq: 3 }))
  acknowledged.resolve()
  await Promise.all([first, latest])
  assert.equal(submissions, 1)
  assert.equal(runtime.tasks.get('alpha')!.stats.errors, 0)
  assert.deepEqual(runtime.tasks.get('alpha')!.memory, { sent: true })
})
