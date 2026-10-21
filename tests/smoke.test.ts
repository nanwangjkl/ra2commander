import test from 'node:test'
import assert from 'node:assert/strict'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { harness, move, snapshot, spec } from './helpers.ts'

const source = `function step(snapshot, memory) {
  const goal = snapshot.control.goals[0];
  if (!goal || memory.sent) return {actions:[],memory};
  return {actions:[{goalId:goal.spec.id,request:{kind:'move',unitIds:goal.unitIds,x:6,y:6}}],memory:{sent:true}};
}`

test('正常命令经过编译、真实隔离执行和运行时，提交动作并保留进度', async () => {
  const executor = new StepExecutor()
  const provider = { generate: async () => ({ model: 'fixture', durationMs: 0, text: source }) }
  try {
    const { runtime, submitted } = await harness(executor)
    const controller = new ProgramController({ runtime, executor, provider: () => provider as never })
    await controller.submit(spec())
    await runtime.onSnapshot(snapshot({ seq: 2 }))
    await runtime.onSnapshot(snapshot({ seq: 3 }))
    assert.deepEqual(submitted, [move])
    assert.deepEqual(runtime.programs.get('formation:A')!.memory, { sent: true })
  } finally { await executor.dispose() }
})
