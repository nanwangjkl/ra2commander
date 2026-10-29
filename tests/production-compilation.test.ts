import test from 'node:test'
import assert from 'node:assert/strict'
import { compileCommand, compileChecks } from '../packages/command/src/index.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { activate, harness, production, snapshot } from './helpers.ts'

const wrong = `function step(s,m){const actions=[];const plan=s.productionPlan||{};for(const g of s.control.goals){for(const name of plan.readyToPlace||[])actions.push({goalId:g.spec.id,request:{kind:'place',name}});}return {actions,memory:m}}`
const correct = `function step(s,m){const actions=[];for(const g of s.control.goals){for(const name of g.productionPlan?.readyToPlace||[])actions.push({goalId:g.spec.id,request:{kind:'place',name}});}return {actions,memory:m}}`

test('生产计划不能从快照根级读取，字段名出现在字符串或正确目标中不误报', () => {
  for (const code of [wrong, 'function step(input,m){const p=input["productionPlan"]||{};return {actions:[],memory:m}}', 'function step(input,m){const {productionPlan: p}=input;return {actions:[],memory:m}}']) assert.match(compileChecks(code).join(';'), /快照根级不存在/)
  assert.deepEqual(compileChecks(correct), [])
  assert.deepEqual(compileChecks('function step(s,m){const text="s.productionPlan";return {actions:[],memory:m}}'), [])
})

test('重现矿场百分百后空转：初版与无效修复均被拒绝，正确放置版本生效且不重造', async () => {
  const executor = new StepExecutor()
  try {
    const { runtime, submitted } = await harness(executor)
    activate(runtime, production({ id: 'factory', target: 'NAWEAP', targetType: 2, prerequisites: ['NAREFN', 'NAHAND'] }), wrong)
    runtime.production.push({ id: 'ready-refinery', goalId: 'factory', name: 'NAREFN', quantity: 1, building: true, queueType: 0, state: 'submitted', observedIds: [], placed: false })
    const ready = snapshot({ seq: 2, production: { power: { total: 150, drain: 0, isLowPower: false }, available: ['NAHAND'], queues: [{ type: 0, status: 3, size: 1, maxSize: 1, items: [{ name: 'NAREFN', quantity: 1, progress: 1, creditsEach: 2000, creditsSpent: 2000 }] }] } })
    await runtime.onSnapshot(ready)
    assert.deepEqual(submitted, [], '原错误脚本没有发出放置动作')
    const lease = runtime.beginCompile('global', true), frame = runtime.compileFrame(lease)
    const original = JSON.stringify(frame)
    const candidates = [wrong, wrong.replace('const plan=s.productionPlan', 'const alias=s;const plan=alias.productionPlan'), correct]
    const requests: Array<Array<{ role: string; content: string }>> = []
    const result = await compileCommand({ generate: async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
      requests.push(structuredClone(messages))
      return { text: candidates[requests.length - 1]!, model: 'fixture', durationMs: 0 }
    } } as never, { ...frame, diagnostic: { code: wrong, error: '建筑已就绪但未放置' } }, executor)
    assert.equal(result.attempts, 3)
    assert.match(result.log[0]!.errors.join(';'), /快照根级不存在/)
    assert.match(result.log[1]!.errors.join(';'), /没有提出 place 动作/)
    assert.equal(JSON.stringify(frame), original, '编译检查不修改真实目标与生产额度')
    assert.deepEqual(submitted, [], '干跑不操作真实游戏')
    assert.equal(runtime.commitCompile(lease, result.code, result.promptVersion), true)
    await runtime.onSnapshot({ ...ready, seq: 3, tick: 45 })
    await runtime.onSnapshot({ ...ready, seq: 4, tick: 60 })
    assert.deepEqual(submitted, [{ kind: 'place', name: 'NAREFN' }, { kind: 'place', name: 'NAREFN' }], '尚未观察到落地时继续放置，不重复生产')
    assert.equal(runtime.production.length, 1)
    assert.equal(runtime.production[0]!.quantity, 1)
  } finally { await executor.dispose() }
})
