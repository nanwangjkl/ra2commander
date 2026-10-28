import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BattleRecords } from '../apps/companion/src/battle-records.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { runTranscript } from '../apps/companion/src/transcript.ts'
import { handleCommand, type CommandContext } from '../apps/companion/src/commands.ts'
import { RecoveryMonitor } from '../packages/runtime/src/recovery.ts'
import { activate, code, deferred, harness, production, snapshot } from './helpers.ts'
import type { GoalView, Snapshot } from '../packages/contracts/src/index.ts'

const source = `function step(s,m){const actions=[];for(const g of s.control.goals){const p=g.spec;
if(p.kind==='production'&&g.produceRemaining[p.target]>0)actions.push({goalId:p.id,request:{kind:'produce',name:p.target,quantity:g.produceRemaining[p.target]}});
if(p.kind==='rally'&&g.unitIds.length)actions.push({goalId:p.id,request:{kind:'move',unitIds:g.unitIds,x:p.x,y:p.y}});
}return {actions,memory:m}}`
const reply = (text: string) => ({ text, model: 'fixture', durationMs: 0 })

async function bindingFixture(cancel = false) {
  const executor = new StepExecutor(), root = mkdtempSync(join(tmpdir(), 'ra2c-recovery-'))
  const { runtime, formations, submitted } = await harness(executor)
  const started = deferred<void>(), late = deferred<ReturnType<typeof reply>>()
  let retries = 0
  const successful = { capability: 'production.produce', params: { target: 'MTNK', quantity: 2 } }
  const provider = { generate: async ({ messages }: { messages: Array<{ content: string }> }) => {
    const input = JSON.parse(messages[1]!.content)
    if (input.failures) {
      retries++
      assert.equal(runtime.programs.get('global')!.status, 'active', '可执行部分在请求修正前已经生效')
      assert.equal(input.accepted.length, 1)
      assert.match(input.failures[0].error, /编队不存在/)
      started.resolve()
      if (cancel) return late.promise
      return reply(JSON.stringify({ repairs: [{ index: 0, operations: [{ ...successful, params: { ...successful.params, target: '灰熊坦克' } }, { capability: 'management.rally', params: { unitIds: [2, 3], x: 20, y: 20 } }] }] }))
    }
    if ('text' in input) return reply(JSON.stringify({ summary: '生产并集结', operations: [successful, { capability: 'combat.move', params: { formationId: '不存在', regionName: '基地附近' } }] }))
    return reply(source)
  } }
  const controller = new ProgramController({ runtime, executor, provider: () => provider as never })
  const ctx = { runtime, formations, controller, currentProvider: () => provider,
    bridge: { rules: async (name: string, type: number) => name === 'MTNK' && type === 7 ? { label: 'Grizzly Battle Tank', prerequisite: [] } : undefined },
  } as unknown as CommandContext
  return { runtime, ctx, executor, root, submitted, started, late, retries: () => retries,
    dispose: async () => { await executor.dispose(); rmSync(root, { recursive: true, force: true }) } }
}

test('失败绑定单独交回模型，成功目标先执行且不会重复创建；修正过程归档', async () => {
  const f = await bindingFixture()
  try {
    const output = await runTranscript('造两辆坦克，现有未编队坦克去20,20', f.ctx, f.root)
    assert.equal(f.retries(), 1)
    assert.doesNotMatch(output, /未执行部分/)
    assert.equal([...f.runtime.goals.values()].filter(goal => goal.spec.kind === 'production').length, 1)
    assert.equal([...f.runtime.goals.values()].filter(goal => goal.spec.kind === 'rally').length, 1)
    const archive = new BattleRecords(f.root)
    const record = Object.values(archive.read(archive.list()[0]!.id)!.transcripts)[0]!
    const repairs = record.bindingRepairs as Array<{ response: { text: string } }>
    assert.equal(repairs.length, 1)
    assert.ok(repairs[0]!.response.text)
    await f.runtime.onSnapshot(snapshot({ seq: 2, tick: 30 }))
    assert.deepEqual(f.submitted.flatMap(action => action.kind === 'produce' ? [action.quantity] : []), [2])
  } finally { await f.dispose() }
})

test('绑定修正期间停止命令优先，迟到模型结果不能追加目标或恢复脚本', async () => {
  const f = await bindingFixture(true)
  try {
    const pending = runTranscript('造两辆坦克，现有未编队坦克去20,20', f.ctx, f.root)
    await f.started.promise
    await handleCommand('global stop', f.ctx)
    f.late.resolve(reply(JSON.stringify({ repairs: [{ index: 0, operations: [{ capability: 'management.rally', params: { unitIds: [2], x: 20, y: 20 } }] }] })))
    assert.match(await pending, /中止|停止|取消/)
    assert.equal(f.runtime.programs.get('global')!.status, 'stopped')
    assert.ok([...f.runtime.goals.values()].every(goal => goal.status === 'cancelled'))
    assert.ok(![...f.runtime.goals.values()].some(goal => goal.spec.kind === 'rally'))
  } finally { await f.dispose() }
})

test('生产空转会携带实际执行证据修复；替换期间旧脚本继续且累计生产不重置', async () => {
  const executor = new StepExecutor(), effective = deferred<void>()
  let controller!: ProgramController, requests = 0
  const { runtime, submitted } = await harness(executor, { recovery: { stallTicks: 30, cooldownTicks: 30 }, onProgramStalled: (id, reason) => controller.fault(id, reason) })
  const provider = { generate: async ({ messages }: { messages: Array<{ content: string }> }) => {
    requests++
    const input = JSON.parse(messages[1]!.content)
    assert.equal(input.control.goals[0].submitted.MTNK, 2)
    assert.ok(input.recoveryEvidence.recent.some((trace: { detail: { kind?: string } }) => trace.detail.kind === 'script'))
    assert.ok(input.recoveryEvidence.progress.some((goal: { actionable: boolean }) => goal.actionable))
    assert.equal(runtime.programs.get('global')!.status, 'active')
    return reply(source)
  } }
  controller = new ProgramController({ runtime, executor, provider: () => provider as never })
  controller.subscribe(event => { if (event.stage === 'effective') effective.resolve() })
  try {
    activate(runtime, production({ quantity: 5 }))
    runtime.production.push({ id: 'already-sent', goalId: 'production', name: 'MTNK', quantity: 2, building: false, state: 'submitted', observedIds: [500, 501], placed: false })
    await runtime.onSnapshot(snapshot({ seq: 2, tick: 30 }))
    await runtime.onSnapshot(snapshot({ seq: 3, tick: 75 }))
    await effective.promise
    assert.equal(requests, 1)
    assert.equal(runtime.programs.get('global')!.script!.version, 2)
    await runtime.onSnapshot(snapshot({ seq: 4, tick: 90 }))
    assert.deepEqual(submitted.flatMap(action => action.kind === 'produce' ? [action.quantity] : []), [3])
  } finally { await executor.dispose() }
})

test('正常等待、实际进展与同 tick 采样不会误触发；停滞诊断有冷却', () => {
  const monitor = new RecoveryMonitor(30, 60)
  const goal: GoalView = { spec: production(), unitIds: [], produceRemaining: { MTNK: 1 }, submitted: {}, observed: {}, uncertain: [], lossRatio: 0, retreatActive: false,
    productionPlan: { missingPrerequisites: [], pendingPrerequisites: [], availableToProduce: ['MTNK'], readyToPlace: [] } }
  const c = { production: { allowedUnitIds: [], enemyIds: [], mapWidth: 100, mapHeight: 100, productionQueueTypes: { MTNK: 3 } } }
  const observe = (tick: number, extra: Partial<Snapshot> = {}, waiting = false) => monitor.observe('global', 'battle-a:1', snapshot({ tick, ...extra }), [goal], c, new Set(waiting ? ['production'] : []))
  for (const tick of [0, 100, 200]) assert.equal(observe(tick, { credits: 0 }), undefined)
  goal.uncertain = ['MTNK']
  assert.equal(observe(300), undefined)
  goal.uncertain = []
  goal.productionPlan!.availableToProduce = []
  assert.equal(observe(400), undefined, '队列占满或科技未就绪时不启动计时')
  goal.productionPlan!.availableToProduce = ['MTNK']
  assert.equal(observe(500, {}, true), undefined, '等待交接或无合法建筑落点时不启动计时')
  assert.equal(observe(600), undefined)
  assert.equal(observe(600), undefined)
  goal.submitted.MTNK = 1
  assert.equal(observe(630), undefined, '真实提交进度变化重新计时')
  assert.match(observe(660)!, /没有实际进展/)
  assert.equal(observe(690), undefined)
  assert.match(observe(720)!, /没有实际进展/)
})

test('自动修复按当前目标限次，新目标重置；停滞修复的迟到结果不能越过停止', async () => {
  const executor = new StepExecutor(), { runtime } = await harness(executor)
  let requests = 0, delayed = false
  const started = deferred<void>(), late = deferred<ReturnType<typeof reply>>()
  const controller = new ProgramController({ runtime, executor, provider: () => ({ generate: async () => {
    requests++
    if (delayed) { started.resolve(); return late.promise }
    return reply(code)
  } }) as never })
  const repair = async () => {
    const effective = deferred<void>()
    const unsubscribe = controller.subscribe(event => { if (event.stage === 'effective') effective.resolve() })
    controller.fault('global', '有条件但未推进')
    await effective.promise
    unsubscribe()
  }
  try {
    activate(runtime, production())
    await repair(); await repair()
    controller.fault('global', '同一目标再次停滞')
    assert.equal(requests, 2)
    runtime.upsertGoal(production({ id: 'next-production' }))
    delayed = true
    controller.fault('global', '新目标执行停滞')
    await started.promise
    await runtime.stop('global')
    late.resolve(reply(code))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(requests, 3)
    assert.equal(runtime.programs.get('global')!.status, 'stopped')
    assert.equal(runtime.programs.get('global')!.script!.version, 3)
    assert.ok([...runtime.goals.values()].every(goal => goal.status === 'cancelled'))
  } finally { await executor.dispose() }
})
