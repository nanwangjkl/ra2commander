import test from 'node:test'
import assert from 'node:assert/strict'
import { compileCommand, compileChecks } from '../packages/command/src/index.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { persistState, restoreState } from '../packages/runtime/src/index.ts'
import { activate, harness, production, snapshot } from './helpers.ts'

const wrong = `function step(s,m){const actions=[];const plan=s.productionPlan||{};for(const g of s.control.goals){for(const name of plan.readyToPlace||[])actions.push({goalId:g.spec.id,request:{kind:'place',name}});}return {actions,memory:m}}`
const correct = `function step(s,m){const actions=[];for(const g of s.control.goals){for(const name of g.productionPlan?.readyToPlace||[])actions.push({goalId:g.spec.id,request:{kind:'place',name}});}return {actions,memory:m}}`

test('生产计划不能从快照根级读取，字段名出现在字符串或正确目标中不误报', () => {
  for (const code of [wrong, 'function step(input,m){const p=input["productionPlan"]||{};return {actions:[],memory:m}}', 'function step(input,m){const {productionPlan: p}=input;return {actions:[],memory:m}}']) assert.match(compileChecks(code).join(';'), /快照根级不存在/)
  assert.deepEqual(compileChecks(correct), [])
  assert.deepEqual(compileChecks('function step(s,m){const text="s.productionPlan";return {actions:[],memory:m}}'), [])
})

test('已有矿场不能抵消新增矿场：宿主立即放置、失败继续重试，与旧脚本去重且不重造', async () => {
  const executor = new StepExecutor()
  try {
    const { runtime, submitted } = await harness(executor)
    const old = { id: 100, name: 'NAREFN', type: 2, rx: 20, ry: 20, isIdle: true }
    await runtime.onSnapshot(snapshot({ seq: 2, self: [old] }))
    // 最新胜局的实际错误：场上已有同名建筑就跳过本次新增建筑。
    const selfHas = `function step(s,m){const actions=[];for(const g of s.control.goals)for(const name of g.productionPlan?.readyToPlace||[])if(!s.self.some(u=>u.name===name))actions.push({goalId:g.spec.id,request:{kind:'place',name}});return {actions,memory:m}}`
    activate(runtime, production({ id: 'refinery', target: 'NAREFN', targetType: 2 }), selfHas)
    runtime.production.push({ id: 'ready-refinery', goalId: 'refinery', name: 'NAREFN', quantity: 1, building: true, queueType: 0, state: 'submitted', observedIds: [], placed: false })
    const ready = snapshot({ seq: 3, self: [old], production: { power: { total: 150, drain: 0, isLowPower: false }, available: ['NAREFN'], queues: [{ type: 0, status: 3, size: 1, maxSize: 1, items: [{ name: 'NAREFN', quantity: 1, progress: 1, creditsEach: 2000, creditsSpent: 2000 }] }] } })
    await runtime.onSnapshot(ready)
    assert.deepEqual(submitted, [{ kind: 'place', name: 'NAREFN' }], '不等待模型修复')
    assert.equal(runtime.goals.get('refinery')!.status, 'active')
    const lease = runtime.beginCompile('global'), frame = runtime.compileFrame(lease)
    const original = JSON.stringify(frame)
    const candidates = [wrong, correct]
    const requests: Array<Array<{ role: string; content: string }>> = []
    const result = await compileCommand({ generate: async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
      requests.push(structuredClone(messages))
      return { text: candidates[requests.length - 1]!, model: 'fixture', durationMs: 0 }
    } } as never, frame, executor)
    assert.equal(result.attempts, 2)
    assert.match(result.log[0]!.errors.join(';'), /快照根级不存在/)
    assert.equal(JSON.stringify(frame), original, '编译检查不修改真实目标与生产额度')
    assert.equal(submitted.length, 1, '干跑不操作真实游戏')
    assert.equal(runtime.commitCompile(lease, result.code, result.promptVersion), true)
    await runtime.onSnapshot({ ...ready, seq: 4, tick: 60 })
    assert.deepEqual(submitted, [{ kind: 'place', name: 'NAREFN' }, { kind: 'place', name: 'NAREFN' }], '旧脚本也提出 place 时，同一步仍只放一次')
    assert.equal(runtime.production.length, 1)
    assert.equal(runtime.production[0]!.quantity, 1)
    await runtime.onSnapshot({ ...ready, seq: 5, tick: 75, self: [old, { ...old, id: 101, rx: 25 }], production: { ...ready.production!, queues: [] } })
    assert.equal(runtime.goals.get('refinery')!.status, 'completed')
    assert.equal(submitted.length, 2, '确认新增建筑出现后才停止放置')
  } finally { await executor.dispose() }
})

test('就绪建筑同局恢复继续放置，暂停与取消阻止宿主补发', async () => {
  const executor = new StepExecutor()
  try {
    const { runtime } = await harness(executor)
    activate(runtime, production({ target: 'NAPOWR', targetType: 2 }), 'function step(s,m){return {actions:[],memory:m}}')
    runtime.production.push({ id: 'power', goalId: 'production', name: 'NAPOWR', quantity: 1, building: true, queueType: 0, state: 'submitted', observedIds: [], placed: false })
    const ready = snapshot({ seq: 2, production: { ...snapshot().production!, queues: [{ type: 0, status: 3, size: 1, maxSize: 1, items: [{ name: 'NAPOWR', quantity: 1, progress: 1, creditsEach: 600, creditsSpent: 600 }] }] } })
    await runtime.onSnapshot(ready)
    const saved = persistState(runtime), other = await harness(executor)
    await other.runtime.onSnapshot(ready); restoreState(other.runtime, saved)
    const tick = () => other.runtime.onSnapshot({ ...ready, seq: other.runtime.snapshot!.seq + 1, tick: other.runtime.snapshot!.tick + 15 })
    await tick()
    assert.equal(other.submitted.filter(a => a.kind === 'place').length, 1)
    other.runtime.pause('global'); await tick()
    assert.equal(other.submitted.filter(a => a.kind === 'place').length, 1)
    other.runtime.resume('global'); await tick()
    assert.equal(other.submitted.filter(a => a.kind === 'place').length, 2)
    await other.runtime.cancelGoal('production'); await tick()
    assert.equal(other.submitted.filter(a => a.kind === 'place').length, 2)
    assert.equal(other.submitted.some(a => a.kind === 'produce'), false)
  } finally { await executor.dispose() }
})
