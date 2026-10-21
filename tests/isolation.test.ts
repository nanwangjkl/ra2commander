import test from 'node:test'
import assert from 'node:assert/strict'
import { compileChecks } from '../packages/command/src/script-contract.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { snapshot } from './helpers.ts'

const constraints = { allowedUnitIds: [1], enemyIds: [99], mapWidth: 100, mapHeight: 100 }

test('检查候选脚本时不执行顶层副作用或死循环', () => {
  const marker = '__ra2cIsolationTest'
  for (const source of [
    `function step(s,m) { return {} }; this['${marker}'] = true`,
    'while(true){}; function step(s,m){}',
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

test('脚本抛错或死循环后，执行器仍能运行正常脚本', async () => {
  const executor = new StepExecutor()
  try {
    for (const source of [
      'function step(s,m){while(true){}}',
      "function step(s,m){throw new Error('模拟生成脚本出错')}",
    ]) {
      const bad = await executor.run(source, snapshot(), {}, constraints, 50)
      assert.equal(bad.ok, false)
      const healthy = await executor.run('function step(s,m){return {actions:[],memory:{ok:true}}}', snapshot(), {}, constraints)
      assert.equal(healthy.ok, true)
    }
  } finally { await executor.dispose() }
})
