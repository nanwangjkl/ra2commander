import test from 'node:test'
import assert from 'node:assert/strict'
import { validateActions, type StepConstraints } from '../packages/contracts/src/index.ts'
import { FormationRegistry, ProductionLedger, persistState, restoreState } from '../packages/runtime/src/index.ts'
import { combatOptions, productionOptions } from '../apps/companion/src/command-options.ts'
import { code, harness, outcome, snapshot, spec } from './helpers.ts'

const constraints: StepConstraints = { allowedUnitIds: [1], enemyIds: [99], mapWidth: 100, mapHeight: 100, allowedActions: ['move', 'attack', 'attackMove', 'gather'], region: spec().region! }

for (const action of [
  { kind: 'produce', name: 'NAPOWR', quantity: 99 },
  { kind: 'place', name: 'NAPOWR' },
  { kind: 'pauseQueue', queueType: 2 },
  { kind: 'resumeQueue', queueType: 2 },
  { kind: 'cancel', name: 'NAPOWR', quantity: 1 },
]) test(`战斗任务缺省禁止 ${action.kind}`, () => {
  assert.ok(validateActions([action], constraints, snapshot()))
})

test('生产权限逐项目、逐队列限制，批次累计不能超额', () => {
  const c = { ...constraints, allowedProduce: ['MTNK'], produceRemaining: { MTNK: 2 }, allowedQueueTypes: [2] }
  assert.equal(validateActions([{ kind: 'produce', name: 'MTNK', quantity: 2 }, { kind: 'pauseQueue', queueType: 2 }], c), undefined)
  assert.ok(validateActions([{ kind: 'produce', name: 'MTNK', quantity: 2 }, { kind: 'produce', name: 'MTNK', quantity: 1 }], c))
  assert.ok(validateActions([{ kind: 'produce', name: 'NAPOWR', quantity: 1 }], c))
  assert.ok(validateActions([{ kind: 'pauseQueue', queueType: 3 }], c))
  assert.ok(validateActions([{ kind: 'cancel', name: 'MTNK', quantity: 1 }], c))
})

for (const kind of ['move', 'attackMove', 'gather']) test(`${kind} 无法越过守区或提前回撤`, () => {
  assert.ok(validateActions([{ kind, unitIds: [1], x: 80, y: 80 }], constraints))
  assert.ok(validateActions([{ kind, unitIds: [1], x: 9, y: 9 }], { ...constraints, retreat: { x: 9, y: 9, active: false } }))
  assert.equal(validateActions([{ kind, unitIds: [1], x: 6, y: 6 }], constraints), undefined)
})

test('攻击复查可见性与每个单位的合法射程，允许区外射程内目标', () => {
  const snap = snapshot({ enemies: [{ id: 99, name: 'ENEMY', type: 7, rx: 11, ry: 5, isIdle: true }] })
  const attack = { kind: 'attack', unitIds: [1], targetId: 99 }
  assert.equal(validateActions([attack], constraints, snap), undefined)
  assert.ok(validateActions([attack], constraints, snapshot({ enemies: [] })))
  snap.enemies[0]!.rx = 12
  assert.ok(validateActions([attack], constraints, snap))
  assert.ok(validateActions([{ kind: 'guard', unitIds: [1] }], { ...constraints, allowedActions: ['guard'] }, snap))
})

test('即使执行器绕过检查，宿主仍拒绝越权生产和移动', async () => {
  const { runtime, submitted } = await harness({ run: async () => outcome([{ kind: 'produce', name: 'NAPOWR', quantity: 99 }]) })
  runtime.deploy(spec(), code)
  await runtime.onSnapshot(snapshot({ seq: 2 }))
  assert.deepEqual(submitted, [])
  assert.equal(runtime.tasks.get('alpha')!.stats.errors, 1)
})

test('生产累计额度跨 step、修复与进程状态恢复保持', async () => {
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
  const next = await harness(executor, { formations: new FormationRegistry() })
  restoreState(next.runtime, new FormationRegistry(), saved)
  await next.runtime.onSnapshot(snapshot({ seq: 4 }))
  assert.deepEqual(next.submitted, [])
  assert.equal(next.runtime.tasks.get('alpha')!.authority.produced.MTNK, 1)
})

test('无授权历史的旧版本持久化状态拒绝恢复', async () => {
  const { runtime } = await harness()
  assert.throws(() => restoreState(runtime, new FormationRegistry(), { version: 1 } as never), /旧状态/)
})

test('生产队列的后续操作覆盖旧归属，旧任务不能恢复别人的暂停', () => {
  const ledger = new ProductionLedger()
  ledger.pause('A', 2)
  ledger.resume('B', 2)
  ledger.pause('B', 2)
  assert.deepEqual(ledger.takePaused('A'), [])
  assert.deepEqual(ledger.takePaused('B'), [2])
})

test('战损六成不回撤，超过六成才允许，触发后禁止返回或攻击', async () => {
  const { runtime, submitted } = await harness({ run: async (_code, value, _memory, c) => {
    const snap = value as ReturnType<typeof snapshot>
    return outcome([{ kind: 'move', unitIds: c.allowedUnitIds, x: snap.seq === 4 ? 5 : 80, y: snap.seq === 4 ? 5 : 80 }])
  } })
  runtime.deploy(spec({ unitIds: snapshot().self.map(u => u.id), originalMembers: snapshot().self.map(u => u.id), retreat: { lossAbove: 0.6, x: 80, y: 80 } }), code)
  await runtime.onSnapshot(snapshot({ seq: 2, self: snapshot().self.slice(6) }))
  assert.equal(runtime.tasks.get('alpha')!.authority.lossRatio, 0.6)
  assert.deepEqual(submitted, [])
  await runtime.onSnapshot(snapshot({ seq: 3, self: snapshot().self.slice(7) }))
  assert.equal(submitted.length, 1)
  assert.equal(runtime.tasks.get('alpha')!.authority.retreatTriggered, true)
  await runtime.onSnapshot(snapshot({ seq: 4, self: snapshot().self.slice(7) }))
  assert.equal(submitted.length, 1)
})

test('正常部署转换不计阵亡，转换后的身份继续跟踪', async () => {
  const { runtime } = await harness({ run: async () => outcome() })
  const initial = snapshot({ seq: 2, self: [{ ...snapshot().self[0]!, name: 'MCV' }, snapshot().self[1]!] })
  await runtime.onSnapshot(initial)
  runtime.deploy(spec({ unitIds: [1, 2], originalMembers: [1, 2], transforms: { MCV: 'CNST' }, retreat: { lossAbove: 0.4, x: 80, y: 80 } }), code)
  const converted = { ...initial.self[0]!, id: 42, name: 'CNST', type: 2 }
  await runtime.onSnapshot(snapshot({ seq: 3, self: [converted, initial.self[1]!] }))
  assert.equal(runtime.tasks.get('alpha')!.authority.lossRatio, 0)
  await runtime.onSnapshot(snapshot({ seq: 4, self: [initial.self[1]!] }))
  assert.equal(runtime.tasks.get('alpha')!.authority.lossRatio, 0.5)
  assert.equal(runtime.tasks.get('alpha')!.authority.retreatTriggered, true)
})

test('任务战损基准取生效时存活成员，编译期间的损失不冒充执行期阵亡', async () => {
  const { runtime } = await harness()
  const lease = runtime.beginCommand('alpha', snapshot())
  await runtime.onSnapshot(snapshot({ seq: 2, self: snapshot().self.slice(1) }))
  assert.equal(runtime.commitCommand(lease, spec({ unitIds: [1, 2], originalMembers: [1, 2] }), code), true)
  assert.deepEqual(runtime.tasks.get('alpha')!.spec.originalMembers, [2])
})

test('CLI 显式绑定地域、模式、回撤、生产数量和队列；缺失绑定失败', () => {
  assert.throws(() => combatOptions(['守桥'], snapshot()), /显式绑定/)
  assert.throws(() => combatOptions(['--region=0,0,10,10', '战损六成回撤'], snapshot()), /条件尚未绑定/)
  const combat = combatOptions(['--region=0,0,10,10', '--retreat=0.6,80,80', '--mode=move', '赶路'], snapshot())
  assert.deepEqual(combat.allowedActions, ['move', 'gather', 'stop'])
  assert.equal(combat.retreat!.lossAbove, 0.6)
  assert.deepEqual(productionOptions(['5', '--pause-queues=2,4', '优先生产']), { quantity: 5, queues: [2, 4], text: '优先生产' })
  assert.throws(() => productionOptions(['0']), /生产数量/)
  assert.throws(() => productionOptions(['--pause-queues=6']), /队列编号/)
})

test('守区原生追击偏移由宿主停车并纠正，不等待模型脚本', async () => {
  let runs = 0
  const { runtime, submitted } = await harness({ run: async () => { runs++; return outcome() } })
  runtime.deploy(spec(), code)
  const self = snapshot().self.map(u => u.id === 1 ? { ...u, rx: 12 } : u)
  await runtime.onSnapshot(snapshot({ seq: 2, self }))
  assert.equal(runs, 0)
  assert.deepEqual(submitted, [{ kind: 'stop', unitIds: [1] }, { kind: 'move', unitIds: [1], x: 10, y: 5 }])
})

test('明确未发送的生产请求退款，不确定回执保留额度防止超造', async () => {
  for (const reason of ['stale-snapshot', 'api-error']) {
    const { runtime } = await harness({ run: async () => outcome([{ kind: 'produce', name: 'MTNK', quantity: 1 }]) }, {
      submit: async () => [{ ok: false, submitted: 0, session: 1, reason }],
    })
    runtime.deploy(spec({ unitIds: [], originalMembers: [], allowedProduce: ['MTNK'], produceLimits: { MTNK: 1 } }), code)
    await runtime.onSnapshot(snapshot({ seq: 2 }))
    assert.equal(runtime.tasks.get('alpha')!.authority.produced.MTNK, reason === 'stale-snapshot' ? 0 : 1)
  }
})

test('与对象原型同名的项目仍按真实额度累计', async () => {
  const { runtime, submitted } = await harness({ run: async () => outcome([{ kind: 'produce', name: 'constructor', quantity: 1 }]) })
  runtime.deploy(spec({ unitIds: [], originalMembers: [], allowedProduce: ['constructor'], produceLimits: { constructor: 1 } }), code)
  await runtime.onSnapshot(snapshot({ seq: 2 }))
  await runtime.onSnapshot(snapshot({ seq: 3 }))
  assert.equal(submitted.length, 1)
})

test('队列权限不等于恢复别人暂停的队列；空授权参数不能隐式授权队列零', () => {
  const c = { ...constraints, allowedQueueTypes: [2] }
  assert.ok(validateActions([{ kind: 'resumeQueue', queueType: 2 }], c))
  assert.equal(validateActions([{ kind: 'resumeQueue', queueType: 2 }], { ...c, resumableQueueTypes: [2] }), undefined)
  assert.ok(validateActions([{ kind: 'pauseQueue', queueType: 2 }], c, snapshot()))
  assert.throws(() => productionOptions(['--pause-queues=']), /空值/)
  assert.throws(() => combatOptions(['--region=,,,', '守区'], snapshot()), /空值/)
})

test('生产提交已确认时到来的新采样不抹掉下单进度', async () => {
  let finish!: () => void
  const acknowledged = new Promise<void>(resolve => { finish = resolve })
  const { runtime } = await harness({ run: async (_code, _snap, memory) => {
    return (memory as { sent?: boolean }).sent ? outcome([], memory) : outcome([{ kind: 'produce', name: 'MTNK', quantity: 1 }], { sent: true })
  } }, { submit: async () => { await acknowledged; return [{ ok: true, submitted: 1, session: 1 }] } })
  runtime.deploy(spec({ unitIds: [], originalMembers: [], allowedProduce: ['MTNK'], produceLimits: { MTNK: 1 } }), code)
  const first = runtime.onSnapshot(snapshot({ seq: 2 }))
  await new Promise(resolve => setImmediate(resolve))
  const latest = runtime.onSnapshot(snapshot({ seq: 3 }))
  finish()
  await Promise.all([first, latest])
  assert.equal(runtime.tasks.get('alpha')!.stats.errors, 0)
  assert.deepEqual(runtime.tasks.get('alpha')!.memory, { sent: true })
})
