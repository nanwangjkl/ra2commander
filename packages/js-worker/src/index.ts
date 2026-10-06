import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { ActionRequest, StepConstraints, StepOutcome } from '@ra2c/contracts'
import { compileChecks } from '@ra2c/command'

export type { StepConstraints, StepOutcome }
export { compileChecks }

/**
 * Step 执行器：单个 worker 跑所有任务脚本（M2 规模足够），同步超时用 terminate 兜底，
 * 之后自动重建 worker。code 经 compileChecks 通过后才可运行。
 */
export class StepExecutor {
  private worker?: Worker | undefined
  private runSeq = 0
  private pending = new Map<number, { resolve: (o: StepOutcome) => void }>()

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const w = new Worker(new URL('./worker.mjs', import.meta.url))
    w.on('message', (msg: { runId: number; ok: boolean; actions?: ActionRequest[]; memory?: unknown; error?: string }) => {
      this.pending.get(msg.runId)?.resolve({
        ok: msg.ok,
        actions: msg.actions ?? [],
        memory: msg.memory ?? {},
        error: msg.error ?? (msg.ok ? undefined : '未知错误'),
      })
      this.pending.delete(msg.runId)
    })
    w.on('exit', () => {
      this.worker = undefined
      // worker 意外退出：所有在途请求按失败结算。
      for (const [id, p] of this.pending) {
        p.resolve({ ok: false, actions: [], memory: {}, error: '执行器退出（脚本超时或崩溃）' })
        this.pending.delete(id)
      }
    })
    this.worker = w
    return w
  }

  async run(
    code: string,
    snapshot: unknown,
    memory: unknown,
    constraints: StepConstraints,
    timeoutMs = 60,
  ): Promise<StepOutcome> {
    const runId = ++this.runSeq
    const w = this.ensureWorker()
    const outcome = await new Promise<StepOutcome>((resolve) => {
      this.pending.set(runId, { resolve })
      w.postMessage({ runId, code, snapshot, memory, constraints })
      setTimeout(() => {
        if (this.pending.has(runId)) {
          this.pending.delete(runId)
          resolve({ ok: false, actions: [], memory: {}, error: `脚本执行超时（>${timeoutMs}ms）` })
          void w.terminate().then(() => {
            this.worker = undefined
          })
        }
      }, timeoutMs)
    })
    return outcome
  }

  async dispose(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate()
      this.worker = undefined
    }
  }
}

export function codeHash(code: string): string {
  return createHash('sha256').update(code).digest('hex').slice(0, 16)
}
