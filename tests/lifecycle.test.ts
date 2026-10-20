import test from 'node:test'
import assert from 'node:assert/strict'
import { FormationRegistry } from '../packages/runtime/src/index.ts'
import type { StepOutcome } from '../packages/contracts/src/index.ts'
import { code, deferred, harness, move, outcome, snapshot, spec } from './helpers.ts'

for (const revoke of ['stop', 'replace', 'pause-resume'] as const) {
  test(`执行中${revoke}后旧动作与 memory 均失效`, async () => {
    const pending = deferred<StepOutcome>()
    const { runtime, submitted } = await harness({ run: () => pending.promise })
    runtime.deploy(spec(), code)
    const tick = runtime.onSnapshot(snapshot({ seq: 2 }))
    if (revoke === 'stop') await runtime.stop('alpha')
    if (revoke === 'replace') runtime.deploy(spec(), code)
    if (revoke === 'pause-resume') { runtime.pause('alpha'); runtime.resume('alpha') }
    pending.resolve(outcome([move], { stale: true }))
    await tick
    assert.deepEqual(submitted.map(a => a.kind), revoke === 'stop' ? ['stop'] : [])
    assert.deepEqual(runtime.tasks.get('alpha')!.memory, {})
  })
}

test('编译中停止尚未部署的任务，迟到回答不能激活', async () => {
  const { runtime } = await harness()
  const lease = runtime.beginCommand('alpha', snapshot(), false, [1])
  await runtime.stop('alpha')
  assert.equal(lease.signal.aborted, true)
  assert.equal(runtime.commitCommand(lease, spec(), code), false)
  assert.equal(runtime.tasks.size, 0)
})

test('新命令编译期间旧任务继续；只接受最新命令', async () => {
  const { runtime, submitted } = await harness()
  runtime.deploy(spec(), code)
  const first = runtime.beginCommand('alpha', snapshot())
  const latest = runtime.beginCommand('alpha', snapshot())
  await runtime.onSnapshot(snapshot({ seq: 2 }))
  assert.equal(submitted.length, 1)
  assert.equal(runtime.commitCommand(first, spec(), code), false)
  assert.equal(runtime.commitCommand(latest, spec(), code), true)
  assert.equal(runtime.tasks.get('alpha')!.script!.version, 2)
})

test('普通改令失败保持旧任务，释放旧请求不会取消后来的命令', async () => {
  const { runtime } = await harness()
  runtime.deploy(spec(), code)
  const old = runtime.tasks.get('alpha')
  const first = runtime.beginCommand('alpha', snapshot())
  const latest = runtime.beginCommand('alpha', snapshot())
  runtime.releaseCommand(first)
  assert.equal(latest.signal.aborted, false)
  runtime.releaseCommand(latest)
  assert.equal(runtime.tasks.get('alpha'), old)
  assert.equal(old!.status, 'active')
})

for (const next of ['stop', 'replace'] as const) {
  test(`修复期间${next}，迟到修复不复活或覆盖任务`, async () => {
    const { runtime } = await harness()
    runtime.deploy(spec(), code)
    runtime.pause('alpha')
    const repair = runtime.beginCommand('alpha', snapshot(), true)
    if (next === 'stop') await runtime.stop('alpha')
    else runtime.deploy(spec({ rawText: '新命令' }), code)
    assert.equal(runtime.commitCommand(repair, spec(), code), false)
    assert.equal(runtime.tasks.get('alpha')!.status, next === 'stop' ? 'stopped' : 'active')
  })
}

test('同一局部代次的新对局拒绝旧动作、旧编译和迟到快照', async () => {
  const pending = deferred<StepOutcome>()
  const { runtime, submitted } = await harness({ run: () => pending.promise })
  runtime.deploy(spec(), code)
  const lease = runtime.beginCommand('beta', snapshot())
  const old = runtime.onSnapshot(snapshot({ seq: 2 }))
  const next = runtime.onSnapshot(snapshot({ sessionKey: 'battle-b', seq: 1 }))
  pending.resolve(outcome([move]))
  await Promise.all([old, next])
  assert.deepEqual(submitted, [])
  assert.equal(lease.signal.aborted, true)
  assert.equal(runtime.commitCommand(lease, spec({ id: 'beta' }), code), false)
  await runtime.onSnapshot(snapshot({ seq: 100 }))
  assert.equal(runtime.battleKey, 'battle-b')
})

test('运行中收到新快照，丢弃旧结果并只处理最新待处理快照', async () => {
  const first = deferred<StepOutcome>()
  const calls: number[] = []
  const { runtime, submitted } = await harness({ run: async (_code, value) => {
    const snap = value as ReturnType<typeof snapshot>
    calls.push(snap.seq)
    return snap.seq === 2 ? first.promise : outcome([{ ...move, x: snap.seq }])
  } })
  runtime.deploy(spec(), code)
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
  runtime.deploy(spec(), code)
  const tick = runtime.onSnapshot(snapshot({ seq: 2 }))
  await new Promise(r => setImmediate(r))
  await runtime.stop('alpha')
  first.resolve()
  await tick
  assert.deepEqual(sent, ['move', 'stop'])
})

test('转编后旧计算被宿主拒绝，停止旧任务不会停住新编队成员', async () => {
  const formations = new FormationRegistry()
  formations.create('A', [1]); formations.create('B', [2])
  const pending = deferred<StepOutcome>()
  const { runtime, submitted } = await harness({ run: () => pending.promise }, { formations })
  runtime.deploy(spec({ formationId: 'A' }), code)
  const tick = runtime.onSnapshot(snapshot({ seq: 2 }))
  formations.transfer([1], 'B')
  pending.resolve(outcome([move]))
  await tick
  await runtime.stop('alpha')
  assert.deepEqual(submitted, [])
})

test('单位停止同时撤销运行任务和未完成编译', async () => {
  const { runtime } = await harness()
  runtime.deploy(spec(), code)
  const pending = runtime.beginCommand('beta', snapshot(), false, [1])
  await runtime.stopUnits([1])
  assert.equal(runtime.tasks.get('alpha')!.status, 'stopped')
  assert.equal(pending.signal.aborted, true)
})

test('转编使编译时的绑定失效；换局清理旧编队', async () => {
  const formations = new FormationRegistry()
  const { runtime } = await harness(undefined, { formations })
  formations.create('A', [1]); formations.create('B', [2])
  const lease = runtime.beginCommand('alpha', snapshot(), false, [1])
  formations.transfer([1], 'B')
  assert.equal(runtime.commitCommand(lease, spec({ formationId: 'A' }), code), false)
  await runtime.onSnapshot(snapshot({ sessionKey: 'next-battle' }))
  assert.deepEqual(formations.list(), [])
})

test('宿主越区纠正批次发送期间转编，旧队剩余纠正动作失效', async () => {
  const formations = new FormationRegistry()
  formations.create('A', [1]); formations.create('B', [2])
  const parked = deferred<void>()
  const sent: string[] = []
  const { runtime } = await harness(undefined, { formations, submit: async (actions, context, guard) => {
    for (const action of actions) {
      if (!guard()) break
      sent.push(action.kind)
      if (action.kind === 'stop') await parked.promise
    }
    return [{ ok: true, submitted: 1, session: context.session }]
  } })
  runtime.deploy(spec({ formationId: 'A' }), code)
  const tick = runtime.onSnapshot(snapshot({ seq: 2, self: snapshot().self.map(u => u.id === 1 ? { ...u, rx: 12 } : u) }))
  formations.transfer([1], 'B')
  parked.resolve()
  await tick
  assert.deepEqual(sent, ['stop'])
})
