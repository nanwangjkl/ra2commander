import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import type { Snapshot } from '../packages/contracts/src/index.ts'
import { FormationRegistry } from '../packages/runtime/src/index.ts'
import { createScriptExecutors } from '../packages/js-worker/src/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { activate, code, deferred, harness, outcome, production, snapshot, spec } from './helpers.ts'

const moving = `function step(s,m){const g=s.control.goals[0];return {actions:[{goalId:g.spec.id,request:{kind:'move',unitIds:g.unitIds,x:6,y:6}}],memory:m}}`

test('新快照持续抢占时轮转全局与各队，旧动作仍丢弃，稳定后各队都能提交', async () => {
  let runtime!: Awaited<ReturnType<typeof harness>>['runtime'], updates = 0
  const calls: Array<{ owner: string; seq: number }> = []
  const executor = { run: async (_code: string, value: unknown) => {
    const snap = value as Snapshot, owner = snap.control!.owner
    const id = owner.kind === 'global' ? 'global' : owner.formationId
    calls.push({ owner: id, seq: snap.seq })
    await Promise.resolve()
    if (updates++ < 6) void runtime.onSnapshot(snapshot({ seq: snap.seq + 1, tick: snap.tick + 15 }))
    const goal = snap.control!.goals[0]!
    return outcome(owner.kind === 'global' ? [] : [{ kind: 'move', unitIds: goal.unitIds, x: snap.seq, y: 6 }], { seq: snap.seq }, goal.spec.id)
  } }
  const env = await harness(executor)
  runtime = env.runtime
  runtime.formations.create('B', [2])
  activate(runtime, spec())
  activate(runtime, spec({ id: 'beta', formationId: 'B' }))
  activate(runtime, production())
  await runtime.onSnapshot(snapshot({ seq: 2, tick: 30 }))
  assert.deepEqual(calls.slice(0, 6).map(call => call.owner), ['A', 'B', 'global', 'A', 'B', 'global'])
  assert.deepEqual(env.submitted, [{ kind: 'move', unitIds: [1], x: 8, y: 6 }, { kind: 'move', unitIds: [2], x: 8, y: 6 }])
  assert.ok([...runtime.programs.values()].every(program => (program.memory as { seq: number }).seq === 8), '旧快照的脚本记忆同样失效')
})

test('较长调度轮次让出事件循环，停止能在整轮结束前生效，剩余队伍不丢步', async () => {
  const calls: string[] = [], count = 32
  const { runtime } = await harness({ run: async (_code, value) => {
    const owner = (value as Snapshot).control!.owner
    calls.push(owner.kind === 'formation' ? owner.formationId : 'global')
    return outcome([])
  } }, { formations: new FormationRegistry() })
  const initial = snapshot({ seq: 2, self: Array.from({ length: count }, (_, index) => ({ ...snapshot().self[0]!, id: index + 1 })) })
  await runtime.onSnapshot(initial)
  for (let index = 0; index < count; index++) {
    const name = `T${index}`
    runtime.formations.create(name, [index + 1])
    activate(runtime, spec({ id: name, formationId: name }))
  }
  let callsAtStop = 0
  const stopping = new Promise<void>((resolve, reject) => setImmediate(() => {
    callsAtStop = calls.length
    void runtime.stop('formation:T31').then(resolve, reject)
  }))
  await Promise.all([runtime.onSnapshot({ ...initial, seq: 3, tick: 30 }), stopping])
  assert.ok(callsAtStop > 0 && callsAtStop < count, '轮次预算应允许外部停止插入，不等待全部对象跑完')
  assert.ok(!calls.includes('T31'))
  assert.equal(new Set(calls).size, count - 1)
  assert.equal(calls.length, count - 1, '同一快照的其他队伍各执行一次，不因分片重复发令')
})

test('一个编队的真实 QuickJS 脚本超时后，其他编队继续提交动作', async () => {
  const executors = createScriptExecutors()
  try {
    const { runtime, submitted } = await harness(executors.runtime)
    runtime.formations.create('B', [2])
    activate(runtime, spec(), 'function step(s,m){while(true){}}')
    activate(runtime, spec({ id: 'beta', formationId: 'B' }), moving)
    await runtime.onSnapshot(snapshot({ seq: 2, tick: 30 }))
    assert.match(runtime.programs.get('formation:A')!.stats.lastError!, /超时|interrupt/)
    assert.deepEqual(submitted, [{ kind: 'move', unitIds: [2], x: 6, y: 6 }])
    runtime.pause('formation:A')
    await runtime.onSnapshot(snapshot({ seq: 3, tick: 45 }))
    assert.equal(submitted.filter(action => action.kind === 'move').length, 2)
    assert.equal(runtime.programs.get('formation:B')!.status, 'active')
  } finally { await executors.dispose() }
})

test('候选干跑占用编译进程时实战仍响应，停止使迟到候选失效', async () => {
  const executors = createScriptExecutors(), dryStarted = deferred<void>()
  try {
    // 先就绪，避免把冷启动时间混入“干跑是否阻塞实战”的比较。
    const constraints = { allowedUnitIds: [], enemyIds: [], mapWidth: 100, mapHeight: 100 }
    await Promise.all([executors.runtime.run(code, snapshot(), {}, constraints), executors.compilation.run(code, snapshot(), {}, constraints)])
    const { runtime, submitted } = await harness(executors.runtime)
    activate(runtime, spec(), moving)
    runtime.upsertGoal(spec({ id: 'replacement' }))
    const controller = new ProgramController({ runtime, provider: () => ({ generate: async () => ({ text: 'function step(s,m){while(true){}}', model: 'fixture', durationMs: 0 }) }) as never,
      executor: { run: async (source, snap, memory, constraints) => {
        dryStarted.resolve()
        return executors.compilation.run(source, snap, memory, constraints, 1000)
      } },
    })
    let compiled = false
    const candidate = controller.refresh('formation:A').finally(() => { compiled = true })
    await dryStarted.promise
    const started = performance.now()
    await runtime.onSnapshot(snapshot({ seq: 2, tick: 30 }))
    const firstActionWait = performance.now() - started
    assert.equal(compiled, false, `首个实战动作等待${Math.round(firstActionWait)}ms，仍应早于编译干跑结束`)
    assert.deepEqual(submitted, [{ kind: 'move', unitIds: [1], x: 6, y: 6 }])
    await runtime.stop('formation:A')
    await candidate
    assert.equal(runtime.programs.get('formation:A')!.status, 'stopped')
    assert.equal(runtime.programs.get('formation:A')!.script!.version, 1)
    assert.equal(runtime.goals.get('replacement')!.activeSpec, undefined)
    assert.deepEqual(submitted.map(action => action.kind), ['move', 'stop'])
  } finally { await executors.dispose() }
})
