import test from 'node:test'
import assert from 'node:assert/strict'
import { compileChecks } from '../packages/command/src/script-contract.ts'
import { compileCommand } from '../packages/command/src/compile.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { snapshot } from './helpers.ts'

const constraints = { allowedUnitIds: [1], enemyIds: [99], mapWidth: 100, mapHeight: 100 }

test('校验只解析源码，拒绝顶层副作用、死循环、默认参数、异步与额外声明', () => {
  const marker = '__ra2cIsolationTest'
  for (const source of [
    `function step(s,m) { return {} }; this['${marker}'] = true`,
    'while(true){}; function step(s,m){}',
    'function step(s = (() => {while(true){}})(),m){}',
    'async function step(s,m){}',
    'function* step(s,m){}',
    'function step(s,m){}; function another(){}',
  ]) assert.ok(compileChecks(source).length)
  assert.equal((globalThis as Record<string, unknown>)[marker], undefined)
  assert.deepEqual(compileChecks('function step(s,m){return {actions:[],memory:{}}}'), [])
})

test('QuickJS 无 Node/浏览器/网络能力，构造器不能逃到宿主，全局按步隔离', async () => {
  const executor = new StepExecutor()
  try {
    const first = await executor.run(`function step(s,m) {
      const g = ({}).constructor.constructor('return this')();
      const forbidden = ['process','require','fetch','window','document','WebSocket'];
      const host = forbidden.some(key => typeof g[key] !== 'undefined');
      g.persisted = 1;
      return {actions:[],memory:{host}};
    }`, snapshot(), {}, constraints)
    assert.equal(first.ok, true)
    assert.deepEqual(first.memory, { host: false })
    const second = await executor.run("function step(s,m){const g=({}).constructor.constructor('return this')(); return {actions:[],memory:{leaked:g.persisted===1}}}", snapshot(), {}, constraints)
    assert.equal(second.ok, true)
    assert.deepEqual(second.memory, { leaked: false })
  } finally { await executor.dispose() }
})

test('死循环、内存膨胀、栈溢出与巨型输出受限，后续健康脚本继续', async () => {
  const executor = new StepExecutor()
  try {
    for (const source of [
      'function step(s,m){while(true){}}',
      'function step(s,m){const a=[];while(true)a.push(new Array(10000).fill(1))}',
      'function step(s,m){function f(){return f()}return f()}',
      "function step(s,m){return {actions:[],memory:{data:'x'.repeat(1000000)}}}",
      'function step(s,m){return {actions:[],memory:{get data(){while(true){}}}}}',
    ]) {
      const bad = await executor.run(source, snapshot(), {}, constraints, 50)
      assert.equal(bad.ok, false)
      const healthy = await executor.run('function step(s,m){return {actions:[],memory:{ok:true}}}', snapshot(), {}, constraints)
      assert.equal(healthy.ok, true)
    }
  } finally { await executor.dispose() }
})

test('并发任务排队不消耗对方执行预算；一个故障不取消健康任务', async () => {
  const executor = new StepExecutor()
  try {
    const results = await Promise.all([
      executor.run('function step(s,m){while(true){}}', snapshot(), {}, constraints, 50),
      executor.run('function step(s,m){return {actions:[],memory:{healthy:true}}}', snapshot(), {}, constraints, 50),
    ])
    assert.equal(results[0]!.ok, false)
    assert.equal(results[1]!.ok, true)
  } finally { await executor.dispose() }
})

test('云端忽略取消信号并迟到返回，编译器仍拒绝结果', async () => {
  const abort = new AbortController()
  const provider = { generate: async () => {
    abort.abort()
    return { text: '```js\nfunction step(s,m){return {actions:[],memory:{}}}\n```', model: 'fake', durationMs: 1 }
  } }
  await assert.rejects(compileCommand(provider as never, { rawText: '守区', binding: { unitIds: [] } }, { run: async () => { throw new Error('取消后不应执行干跑') } }, { signal: abort.signal }), /abort/i)
})
