import test from 'node:test'
import assert from 'node:assert/strict'
import { FormationRegistry } from '../packages/runtime/src/index.ts'
import type { StepOutcome } from '../packages/contracts/src/index.ts'
import { activate, code, deferred, harness, move, outcome, snapshot, spec } from './helpers.ts'

for (const revoke of ['stop', 'replace'] as const) {
  test(`执行中${revoke}后旧动作与 memory 均失效`, async () => {
    const pending = deferred<StepOutcome>()
    const { runtime, submitted } = await harness({ run: () => pending.promise })
    activate(runtime)
    const tick = runtime.onSnapshot(snapshot({ seq: 2 }))
    if (revoke === 'stop') await runtime.stop('formation:A')
    if (revoke === 'replace') activate(runtime, spec({ id: 'new' }))
    pending.resolve(outcome([move], { stale: true }))
    await tick
    assert.deepEqual(submitted.map(a => a.kind), revoke === 'stop' ? ['stop'] : [])
    assert.deepEqual(runtime.programs.get('formation:A')!.memory, {})
  })
}

test('编译中停止尚未激活的脚本，迟到回答不能激活', async () => {
  const { runtime } = await harness()
  runtime.upsertGoal(spec())
  const lease = runtime.beginCompile('formation:A')
  await runtime.stop('formation:A')
  assert.equal(lease.signal.aborted, true)
  assert.equal(runtime.commitCompile(lease, code), false)
  assert.equal(runtime.programs.get('formation:A')!.script, undefined)
})

test('新命令编译期间旧任务继续；只接受最新命令', async () => {
  const { runtime, submitted } = await harness()
  activate(runtime)
  runtime.upsertGoal(spec({ id: 'beta' }))
  const first = runtime.beginCompile('formation:A')
  runtime.upsertGoal(spec({ id: 'latest', rawText: '新指令' }))
  const latest = runtime.beginCompile('formation:A')
  await runtime.onSnapshot(snapshot({ seq: 2 }))
  assert.equal(submitted.length, 1)
  assert.equal(runtime.commitCompile(first, code), false)
  assert.equal(runtime.commitCompile(latest, code), true)
  assert.equal(runtime.goals.get('latest')!.activeSpec!.rawText, '新指令')
})

test('同一局部代次的新对局拒绝旧动作、旧编译和迟到快照', async () => {
  const pending = deferred<StepOutcome>()
  const { runtime, submitted } = await harness({ run: () => pending.promise })
  activate(runtime)
  runtime.upsertGoal(spec({ id: 'beta' }))
  const lease = runtime.beginCompile('formation:A')
  const old = runtime.onSnapshot(snapshot({ seq: 2 }))
  const next = runtime.onSnapshot(snapshot({ sessionKey: 'battle-b', seq: 1 }))
  pending.resolve(outcome([move]))
  await Promise.all([old, next])
  assert.deepEqual(submitted, [])
  assert.equal(lease.signal.aborted, true)
  assert.equal(runtime.commitCompile(lease, code), false)
  await runtime.onSnapshot(snapshot({ seq: 100 }))
  assert.equal(runtime.battleKey, 'battle-b')
  assert.equal(runtime.goals.size, 0)
})

test('运行中收到新快照，丢弃旧结果并只处理最新待处理快照', async () => {
  const first = deferred<StepOutcome>()
  const calls: number[] = []
  const { runtime, submitted } = await harness({ run: async (_code, value) => {
    const snap = value as ReturnType<typeof snapshot>
    calls.push(snap.seq)
    return snap.seq === 2 ? first.promise : outcome([{ ...move, x: snap.seq }])
  } })
  activate(runtime)
  const old = runtime.onSnapshot(snapshot({ seq: 2 }))
  const middle = runtime.onSnapshot(snapshot({ seq: 3 }))
  const latest = runtime.onSnapshot(snapshot({ seq: 4 }))
  first.resolve(outcome([move]))
  await Promise.all([old, middle, latest])
  assert.deepEqual(calls, [2, 4])
  assert.deepEqual(submitted, [{ ...move, x: 4 }])
})

test('批次第一条已发送后停止，剩余动作不再发送', async () => {
  const first = deferred<void>()
  const sent: string[] = []
  const { runtime } = await harness({ run: async () => outcome([move, { ...move, x: 7 }]) }, {
    submit: async (actions, context, guard) => {
      if (!guard()) return []
      sent.push(actions[0]!.kind)
      if (actions[0]!.kind === 'move') await first.promise
      return [{ ok: true, submitted: 1, session: context.session }]
    },
  })
  activate(runtime)
  const tick = runtime.onSnapshot(snapshot({ seq: 2 }))
  await new Promise(r => setImmediate(r))
  await runtime.stop('formation:A')
  first.resolve()
  await tick
  assert.deepEqual(sent, ['move', 'stop'])
})

test('转编后旧计算被宿主拒绝，停止旧任务不会停住新编队成员', async () => {
  const formations = new FormationRegistry()
  formations.create('A', [1]); formations.create('B', [2])
  const pending = deferred<StepOutcome>()
  const { runtime, submitted } = await harness({ run: () => pending.promise }, { formations })
  activate(runtime)
  const tick = runtime.onSnapshot(snapshot({ seq: 2 }))
  formations.transfer([1], 'B')
  pending.resolve(outcome([move]))
  await tick
  await runtime.stop('formation:A')
  assert.deepEqual(submitted, [])
})

test('单位停止同时撤销编队脚本和未完成编译', async () => {
  const { runtime } = await harness()
  activate(runtime)
  runtime.upsertGoal(spec({ id: 'beta' }))
  const pending = runtime.beginCompile('formation:A')
  await runtime.stopUnits([1])
  assert.equal(runtime.programs.get('formation:A')!.status, 'stopped')
  assert.equal(pending.signal.aborted, true)
})
