import test from 'node:test'
import assert from 'node:assert/strict'
import { compileCommand } from '../packages/command/src/compile.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { harness, move, snapshot, spec } from './helpers.ts'

test('正常命令经过编译、真实隔离执行和运行时，提交动作并保留进度', async () => {
  const executor = new StepExecutor()
  const task = spec({ rawText: '移动到指定地点' })
  // 固定模型响应只替代云端生成；校验、干跑、执行和运行时均使用真实实现。
  const provider = { generate: async () => ({ model: 'fixture', durationMs: 0, text: `\`\`\`js
function step(snapshot, memory) {
  if (memory.sent) return { actions: [], memory };
  return { actions: [{ kind: 'move', unitIds: [1], x: 6, y: 6 }], memory: { sent: true } };
}
\`\`\`` }) }
  try {
    const compiled = await compileCommand(provider as never, {
      rawText: task.rawText, snapshot: snapshot(),
      binding: { unitIds: task.unitIds, region: task.region!, allowedActions: task.allowedActions! },
    }, executor)
    const { runtime, submitted } = await harness(executor)
    runtime.deploy(task, compiled.code)
    await runtime.onSnapshot(snapshot({ seq: 2 }))
    await runtime.onSnapshot(snapshot({ seq: 3 }))
    assert.deepEqual(submitted, [move])
    assert.deepEqual(runtime.tasks.get(task.id)!.memory, { sent: true })
  } finally { await executor.dispose() }
})
