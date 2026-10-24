import { createHash } from 'node:crypto'
import { fork, type ChildProcess } from 'node:child_process'
import { validateScriptActions, liveScriptActions, type StepConstraints, type StepOutcome, type Snapshot } from '@ra2c/contracts'
import { compileChecks } from '@ra2c/command'

export type { StepConstraints, StepOutcome }
export { compileChecks }

const fail = (error: string): StepOutcome => ({ ok: false, actions: [], memory: {}, error })
interface Instance {
  child: ChildProcess
  ready: Promise<void>
  finish?: ((value: StepOutcome) => void) | undefined
}

/** 独立进程承载 QuickJS WASM。串行执行，计时从进程就绪后开始，故障只结算当前请求。 */
export class StepExecutor {
  private instance?: Instance | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private disposed = false

  private start(): Instance {
    if (this.instance) return this.instance
    const child = fork(new URL('./worker.mjs', import.meta.url), [], {
      execArgv: ['--max-old-space-size=64'],
      env: {},
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json',
    })
    let readyResolve!: () => void
    let readyReject!: (error: Error) => void
    const instance: Instance = {
      child,
      ready: new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject }),
    }
    const timer = setTimeout(() => {
      readyReject(new Error('执行器启动超时'))
      child.kill('SIGKILL')
    }, 5000)
    const lost = () => {
      clearTimeout(timer)
      if (this.instance === instance) this.instance = undefined
      readyReject(new Error('执行器进程退出'))
      instance.finish?.(fail('执行器进程退出'))
    }
    child.on('error', lost)
    child.on('exit', lost)
    child.on('message', (message: unknown) => {
      const msg = message as { ready?: boolean; ok?: boolean; json?: string; error?: string }
      if (msg.ready) {
        clearTimeout(timer)
        readyResolve()
      } else if (msg.ok && typeof msg.json === 'string' && Buffer.byteLength(msg.json) <= 131_072) {
        try {
          const out = JSON.parse(msg.json) as { actions: unknown[]; memory: unknown }
          instance.finish?.({ ok: true, actions: out.actions as StepOutcome['actions'], memory: out.memory })
        } catch { instance.finish?.(fail('执行器返回非法 JSON')) }
      } else {
        instance.finish?.(fail(String(msg.error ?? '执行器输出超过上限').slice(0, 500)))
      }
    })
    this.instance = instance
    return instance
  }

  async run(code: string, snapshot: unknown, memory: unknown, constraints: StepConstraints, timeoutMs = 60): Promise<StepOutcome> {
    const errors = compileChecks(code)
    if (errors.length) return fail(errors.join('; '))
    let input: string
    try {
      const memoryJson = JSON.stringify(memory ?? {})
      if (Buffer.byteLength(memoryJson) > 65_536) return fail('脚本 memory 超过 64 KiB')
      input = JSON.stringify({ snapshot, memory: memory ?? {} })
      if (Buffer.byteLength(input) > 1_048_576) return fail('执行器输入超过 1 MiB')
    } catch { return fail('执行器输入必须可 JSON 序列化') }
    const request = this.tail.then(async () => {
      if (this.disposed) return fail('执行器已关闭')
      let instance: Instance
      try { instance = this.start(); await instance.ready } catch (err) { return fail(String(err)) }
      if (this.disposed) return fail('执行器已关闭')
      const budget = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(1000, timeoutMs)) : 60
      const outcome = await new Promise<StepOutcome>((resolve) => {
        const timer = setTimeout(() => {
          finish(fail(`脚本执行超时（>${budget}ms）`))
          if (this.instance === instance) this.instance = undefined
          instance.child.kill('SIGKILL')
        }, budget + 100)
        const finish = (out: StepOutcome) => {
          clearTimeout(timer)
          instance.finish = undefined
          resolve(out)
        }
        instance.finish = finish
        instance.child.send({ code, input, timeoutMs: budget }, err => {
          if (err) finish(fail('执行器 IPC 发送失败'))
        })
      })
      if (!outcome.ok) return outcome
      outcome.actions = liveScriptActions(outcome.actions, constraints, snapshot as Snapshot)
      const error = validateScriptActions(outcome.actions, constraints, snapshot as Snapshot)
      return error ? fail(error) : outcome
    })
    this.tail = request.catch(() => {})
    return request
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.instance?.child.kill('SIGKILL')
    await this.tail
    this.instance = undefined
  }
}

export function codeHash(code: string): string {
  return createHash('sha256').update(code).digest('hex').slice(0, 16)
}
