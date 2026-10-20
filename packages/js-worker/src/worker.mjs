// 仅作为隔离子进程启动。生成代码只在 QuickJS 内运行，不注入任何宿主函数/模块。
import { getQuickJS } from 'quickjs-emscripten'

const QuickJS = await getQuickJS()
process.send({ ready: true })
process.on('disconnect', () => process.exit(0))
process.on('message', ({ code, input, timeoutMs }) => {
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(8 * 1024 * 1024)
  runtime.setMaxStackSize(256 * 1024)
  const deadline = Date.now() + timeoutMs
  runtime.setInterruptHandler(() => Date.now() > deadline)
  const context = runtime.newContext()
  try {
    // 每步建立全新 context/runtime，唯一跨步状态为有界 JSON memory。
    const result = context.evalCode(`(() => {
      'use strict';
      const stringify = JSON.stringify.bind(JSON);
      const input = JSON.parse(${JSON.stringify(input)});
      ${code}
      const out = step(input.snapshot, input.memory);
      if (!out || typeof out !== 'object' || typeof out.then === 'function' || !Array.isArray(out.actions)) throw new Error('step 必须同步返回 actions 数组与 memory');
      const memory = stringify(out.memory ?? {});
      if (typeof memory !== 'string' || memory.length > 16384) throw new Error('memory 超过上限或不可序列化');
      const json = stringify({actions: out.actions, memory: out.memory ?? {}});
      if (json.length > 32768) throw new Error('脚本输出超过上限');
      return json;
    })()`, 'task.js')
    if (result.error) {
      // 不 dump 不可信错误对象，避免在宿主遍历巨型属性。
      result.error.dispose()
      process.send({ ok: false, error: Date.now() > deadline ? '脚本执行超时' : '脚本执行失败（异常、内存/栈/输出限制）' })
    } else {
      const json = context.getString(result.value)
      result.value.dispose()
      process.send({ ok: true, json })
    }
  } catch {
    process.send({ ok: false, error: '隔离执行器异常' })
  } finally {
    context.dispose()
    runtime.dispose()
  }
})
