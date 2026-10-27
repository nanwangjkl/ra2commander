import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { FormationRegistry, persistState, restoreState, type RuntimeDeps, type PersistedState } from '../packages/runtime/src/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { runTranscript } from '../apps/companion/src/transcript.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import type { ActionRequest, SnapshotUnit, ProductionQueueState } from '../packages/contracts/src/index.ts'
import { activate, deferred, harness, production, snapshot } from './helpers.ts'

const source = `function step(s,m){const actions=[];for(const g of s.control.goals){if(g.spec.kind==='production'&&g.produceRemaining[g.spec.target]>0)actions.push({goalId:g.spec.id,request:{kind:'produce',name:g.spec.target,quantity:g.produceRemaining[g.spec.target]}});}return {actions,memory:m}}`
async function fixture(extra: Partial<RuntimeDeps> = {}) {
  const executor = new StepExecutor(), root = mkdtempSync(join(tmpdir(), 'ra2c-cancel-'))
  let own: SnapshotUnit[] = [], queued: Array<{ name: string; quantity: number }> = [], nextId = 100, generations = 0
  const actions: ActionRequest[] = []
  const submit: RuntimeDeps['submit'] = async (requests, context, guard) => {
    if (!guard()) return []
    for (const request of requests) {
      actions.push(request)
      if (request.kind === 'produce') queued.push({ name: request.name, quantity: request.quantity })
      if (request.kind === 'cancel') {
        let remaining = request.quantity
        for (const item of queued) if (item.name === request.name) { const count = Math.min(item.quantity, remaining); item.quantity -= count; remaining -= count }
        queued = queued.filter(item => item.quantity)
      }
    }
    return requests.map(() => ({ ok: true, submitted: 1, session: context.session }))
  }
  const env = await harness(executor, { formations: new FormationRegistry(), submit, ...extra })
  let runtime = env.runtime
  const current = () => snapshot({ seq: runtime.snapshot!.seq + 1, tick: runtime.snapshot!.tick + 30, self: structuredClone(own), production: {
    ...snapshot().production!, available: ['ORCA', 'CMIN', 'MTNK'], queues: [3, 4].map(type => {
      const items = queued.filter(item => (item.name === 'ORCA' ? 4 : 3) === type).map(item => ({ ...item, progress: 0.5, creditsEach: 1000, creditsSpent: 500 }))
      return { type, status: items.length ? 1 : 0, size: items.reduce((n, item) => n + item.quantity, 0), maxSize: 99, items }
    }) as ProductionQueueState[],
  } })
  await runtime.onSnapshot(current())
  const provider = { generate: async ({ messages }: { messages: Array<{ content: string }> }) => {
    const payload = JSON.parse(messages[1]!.content)
    if (!('text' in payload)) { generations++; return { text: source, model: 'fixture', durationMs: 0 } }
    const target = /矿车/.test(payload.text) ? 'CMIN' : 'ORCA'
    const goal = payload.goals.find((goal: { target: string }) => goal.target === target)
    assert.ok(goal, '旧已取消但仍有未决提交的目标也应出现在理解上下文')
    return { text: JSON.stringify({ summary: '停止生产', operations: [{ capability: 'goal.cancel', params: { goalId: goal.id } }] }), model: 'fixture', durationMs: 0 }
  } }
  const controller = () => new ProgramController({ runtime, executor, provider: () => provider as never })
  const ctx = { runtime, formations: runtime.formations, controller: controller(), currentProvider: () => provider, bridge: { rules: async (name: string, type: number) => ['ORCA', 'CMIN', 'MTNK'].includes(name) ? { label: name, prerequisite: [], type } : undefined } } as unknown as CommandContext
  return { ctx, get runtime() { return runtime }, executor, actions, queued: () => queued, generations: () => generations,
    tick: () => runtime.onSnapshot(current()), voice: (text: string) => runTranscript(text, ctx, root),
    start: (id: string, name = 'ORCA', quantity = 4) => activate(runtime, production({ id, target: name, quantity, targetType: name === 'ORCA' ? 1 : 7 }), source),
    born: (name: string, count: number) => {
      for (let n = 0; n < count; n++) { own.push({ id: nextId++, name, type: name === 'ORCA' ? 1 : 7, rx: 5, ry: 5, isIdle: true }); const item = queued.find(item => item.name === name && item.quantity); if (item) item.quantity-- }
      queued = queued.filter(item => item.quantity)
    },
    restore: async (saved: PersistedState = persistState(runtime)) => {
      const restored = await harness(executor, { formations: new FormationRegistry(), submit, ...extra })
      await restored.runtime.onSnapshot(current()); restoreState(restored.runtime, saved)
      runtime = restored.runtime; ctx.runtime = runtime; ctx.formations = runtime.formations; ctx.controller = controller()
    },
    dispose: async () => { ctx.commandLog?.ensureArchive(root).close(); await executor.dispose(); rmSync(root, { recursive: true, force: true }) },
  }
}

test('反馈飞机已造2架、还排2架：取消只撤剩余，保留其他生产并允许后来重新造飞机', async () => {
  const f = await fixture()
  try {
    f.start('aircraft'); await f.tick()
    f.born('ORCA', 2); await f.tick()
    f.start('tanks', 'MTNK', 1); await f.tick()
    const result = await f.voice('把飞机制造停了')
    assert.match(result, /已停止追加/)
    assert.deepEqual(f.actions.filter(action => action.kind === 'cancel'), [{ kind: 'cancel', name: 'ORCA', quantity: 2 }])
    assert.ok(f.queued().some(item => item.name === 'MTNK' && item.quantity === 1))
    assert.equal(f.generations(), 0, '取消不为其他未变目标重新生成代码')
    assert.match(f.runtime.goalExecution('aircraft')!.detail!, /等待队列撤销确认/)
    await f.tick()
    assert.match(f.runtime.goalExecution('aircraft')!.detail!, /已确认撤销排队2个/)
    assert.equal(f.runtime.production[0]!.observedIds.length, 2)
    f.start('new-aircraft', 'ORCA', 1); await f.tick()
    assert.ok(f.queued().some(item => item.name === 'ORCA' && item.quantity === 1), '旧未完成额度不再阻塞同名新目标')
    f.born('ORCA', 1); await f.tick()
    assert.equal(f.runtime.goalExecution('new-aircraft')!.state, 'completed')
    assert.equal(f.runtime.production[0]!.observedIds.length, 2, '新产物不落进旧账本')
  } finally { await f.dispose() }
})

test('矿车未入队可立即取消；旧已取消目标仍有队列时再次发令能够撤销', async () => {
  const f = await fixture()
  try {
    f.start('miners', 'CMIN', 3)
    await f.voice('停止造矿车'); await f.tick()
    assert.equal(f.actions.filter(action => ['produce', 'cancel'].includes(action.kind)).length, 0)
    f.start('aircraft'); await f.tick(); f.born('ORCA', 2); await f.tick()
    await f.runtime.cancelGoal('aircraft') // 模拟旧版本只停止追加的状态。
    await f.voice('把飞机制造停了'); await f.tick()
    assert.equal(f.queued().filter(item => item.name === 'ORCA').length, 0)
    assert.equal(f.actions.filter(action => action.kind === 'cancel').length, 1)
  } finally { await f.dispose() }
})

test('撤销回执与真实队列分开确认，重复取消及同局恢复不重复撤队列', async () => {
  const f = await fixture()
  try {
    f.start('aircraft'); await f.tick(); await f.tick()
    await f.runtime.cancelProductionGoal('aircraft')
    await f.runtime.cancelProductionGoal('aircraft')
    assert.equal(f.actions.filter(action => action.kind === 'cancel').length, 1)
    const checkpoint = persistState(f.runtime)
    checkpoint.production[0]!.cancellation!.state = 'prepared' // 崩溃发生在游戏执行撤销后、收到回执前。
    await f.restore(checkpoint); await f.tick()
    assert.equal(f.actions.filter(action => action.kind === 'cancel').length, 1)
    assert.match(f.runtime.goalExecution('aircraft')!.detail!, /已确认撤销排队4个/)
    assert.equal(f.runtime.production[0]!.quantity, 4, '保留原始提交事实')
  } finally { await f.dispose() }
})

test('生产正在提交时取消，迟到入队仍会撤销；预留检查点失败时不发撤销请求', async () => {
  const started = deferred<void>(), released = deferred<void>()
  let failSave = false, cancellations = 0
  const queued: ActionRequest[] = []
  const { runtime } = await harness({ run: async () => ({ ok: true, actions: [{ goalId: 'aircraft', request: { kind: 'produce', name: 'ORCA', quantity: 4 } }], memory: {} }) }, {
    formations: new FormationRegistry(), checkpoint: () => { if (failSave) throw new Error('disk') }, submit: async (actions, context, guard) => {
      if (!guard()) return []
      if (actions[0]!.kind === 'produce') { started.resolve(); await released.promise }
      else cancellations++
      queued.push(...actions)
      return actions.map(() => ({ ok: true, submitted: 1, session: context.session }))
    },
  })
  const snap = snapshot({ seq: 2, production: { ...snapshot().production!, available: ['ORCA'], queues: [{ type: 4, status: 0, size: 0, maxSize: 4, items: [] }] } })
  await runtime.onSnapshot(snap)
  activate(runtime, production({ id: 'aircraft', target: 'ORCA', targetType: 1, quantity: 4 }))
  const sending = runtime.onSnapshot({ ...snap, seq: 3 })
  await started.promise
  await runtime.cancelProductionGoal('aircraft')
  released.resolve(); await sending
  failSave = true
  const inQueue = { ...snap, seq: 4, production: { ...snap.production!, queues: [{ type: 4, status: 1, size: 4, maxSize: 4, items: [{ name: 'ORCA', quantity: 4, progress: 0.5, creditsEach: 1000, creditsSpent: 500 }] }] } }
  await runtime.onSnapshot(inQueue)
  assert.equal(cancellations, 0)
  failSave = false
  await runtime.onSnapshot({ ...inQueue, seq: 5 })
  assert.equal(cancellations, 1)
  assert.equal(queued.filter(action => action.kind === 'produce').length, 1)
})

test('撤销同时有飞机完工，实际完工不计作撤销，新生产仍能继续', async () => {
  const { runtime } = await harness({ run: async () => ({ ok: true, actions: [], memory: {} }) }, { formations: new FormationRegistry() })
  const base = snapshot({ seq: 2, self: [], production: { ...snapshot().production!, available: ['ORCA'], queues: [{ type: 4, status: 1, size: 2, maxSize: 4, items: [{ name: 'ORCA', quantity: 2, progress: 0.99, creditsEach: 1000, creditsSpent: 990 }] }] } })
  await runtime.onSnapshot(base)
  activate(runtime, production({ id: 'aircraft', target: 'ORCA', targetType: 1, quantity: 2 }))
  runtime.production.push({ id: 'sent', goalId: 'aircraft', name: 'ORCA', quantity: 2, building: false, queueType: 4, state: 'submitted', observedIds: [], placed: false })
  await runtime.cancelProductionGoal('aircraft')
  const plane = { id: 100, name: 'ORCA', type: 1, rx: 5, ry: 5, isIdle: true }
  await runtime.onSnapshot({ ...base, seq: 3, self: [plane], production: { ...base.production!, queues: [{ type: 4, status: 0, size: 0, maxSize: 4, items: [] }] } })
  assert.deepEqual(runtime.production[0]!.observedIds, [100])
  assert.equal(runtime.production[0]!.cancellation!.removed, 1)
  assert.equal(runtime.pendingProductionCount('aircraft'), 0)
  assert.match(runtime.goalExecution('aircraft')!.detail!, /已确认撤销排队1个/)
})

test('只看到部分入队时只确认实际撤销量，剩余迟到入队继续撤销', async () => {
  const requests: ActionRequest[] = []
  const { runtime } = await harness({ run: async () => ({ ok: true, actions: [], memory: {} }) }, {
    formations: new FormationRegistry(), submit: async (actions, context) => { requests.push(...actions); return actions.map(() => ({ ok: true, submitted: 1, session: context.session })) },
  })
  const queued = (seq: number, quantity: number) => snapshot({ seq, self: [], production: { ...snapshot().production!, queues: [{ type: 4, status: quantity ? 1 : 0, size: quantity, maxSize: 4,
    items: quantity ? [{ name: 'ORCA', quantity, progress: 0.5, creditsEach: 1000, creditsSpent: 500 }] : [] }] } })
  await runtime.onSnapshot(queued(2, 2))
  activate(runtime, production({ id: 'aircraft', target: 'ORCA', targetType: 1, quantity: 4 }))
  runtime.production.push({ id: 'sent', goalId: 'aircraft', name: 'ORCA', quantity: 4, building: false, queueType: 4, state: 'submitted', observedIds: [], placed: false })
  await runtime.cancelProductionGoal('aircraft'); await runtime.onSnapshot(queued(3, 0))
  assert.equal(runtime.production[0]!.cancelledQuantity, 2)
  assert.equal(runtime.pendingProductionCount('aircraft'), 2, '没有实际撤销的提交不能直接清账')
  await runtime.onSnapshot(queued(4, 2)); await runtime.onSnapshot(queued(5, 0))
  assert.deepEqual(requests.filter(action => action.kind === 'cancel').map(action => action.quantity), [2, 2])
  assert.equal(runtime.production[0]!.cancelledQuantity, 4)
  assert.equal(runtime.pendingProductionCount('aircraft'), 0)
  assert.match(runtime.goalExecution('aircraft')!.detail!, /已确认撤销排队4个/)
})
