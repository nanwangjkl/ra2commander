import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { battleSourceVersion } from './battle-zip.ts'

export interface BattleDownloadView { token: string; battleId: string; state: 'preparing' | 'ready' | 'failed'; error?: string; bytes?: number }
interface Job { view: BattleDownloadView; sourceVersion: string; folder: string; output: string; worker?: Worker; expiry?: NodeJS.Timeout; readers: number; expired: boolean }

/** 一次只转换一个大记录，同局点击复用；下载完成或超时后释放临时文件。 */
export class BattleDownloads {
  private readonly jobs = new Map<string, Job>()
  private closing = false
  constructor(private readonly root: string) {}
  start(id: string): BattleDownloadView {
    if (this.closing) throw new Error('伴随程序正在退出')
    const sourceVersion = battleSourceVersion(this.root, id), old = this.jobs.get(id)
    if (old && (old.view.state === 'preparing' || old.view.state === 'ready' && old.sourceVersion === sourceVersion && existsSync(old.output))) return { ...old.view }
    if ([...this.jobs.values()].some(job => job.view.state === 'preparing')) throw new Error('已有调试包正在准备，请完成后再下载另一局')
    if (old) this.remove(id, old)
    const folder = mkdtempSync(join(tmpdir(), 'ra2c-download-'))
    const job: Job = { view: { token: randomUUID(), battleId: id, state: 'preparing' }, sourceVersion, folder, output: join(folder, `${id}.zip`), readers: 0, expired: false }
    this.jobs.set(id, job)
    let worker: Worker
    try { worker = job.worker = new Worker(new URL('./battle-export-worker.mjs', import.meta.url), { workerData: { root: this.root, id, output: job.output }, execArgv: [] }) }
    catch (error) { this.remove(id, job); throw error }
    const failed = (error: string) => {
      if (job.expired || job.view.state !== 'preparing') return
      job.view = { ...job.view, state: 'failed', error }
      clearTimeout(job.expiry)
      void worker.terminate().then(() => rmSync(folder, { recursive: true, force: true }))
      job.expiry = setTimeout(() => this.remove(id, job), 60_000); job.expiry.unref()
    }
    worker.on('message', (message: { ok: boolean; error?: string; result?: { bundleBytes: number } }) => {
      if (job.expired || job.view.state !== 'preparing') return
      if (!message.ok || !message.result) { failed(message.error ?? '导出失败'); return }
      clearTimeout(job.expiry)
      job.view = { ...job.view, state: 'ready', bytes: message.result.bundleBytes }
      job.expiry = setTimeout(() => this.remove(id, job), 10 * 60_000); job.expiry.unref()
    })
    worker.on('error', error => failed(String(error)))
    worker.on('exit', () => { delete job.worker; if (job.view.state === 'preparing') failed('导出进程意外退出') })
    job.expiry = setTimeout(() => failed('导出超时，请重试'), 5 * 60_000); job.expiry.unref()
    return { ...job.view }
  }
  status(token: string): BattleDownloadView | undefined { const job = this.find(token); return job && { ...job.view } }
  acquire(token: string): { path: string; filename: string; release: () => void } {
    const job = this.find(token)
    if (!job || job.expired || job.view.state !== 'ready' || !existsSync(job.output)) throw new Error('调试包尚未就绪或已过期，请重新下载')
    job.readers++; let released = false
    return { path: job.output, filename: `${job.view.battleId}.zip`, release: () => {
      if (released) return; released = true; job.readers--
      if (!job.readers) this.remove(job.view.battleId, job)
    } }
  }
  private find(token: string): Job | undefined { return [...this.jobs.values()].find(job => job.view.token === token) }
  private remove(id: string, job: Job) {
    job.expired = true; clearTimeout(job.expiry)
    if (this.jobs.get(id) === job) this.jobs.delete(id)
    const cleanup = () => { if (!job.readers) rmSync(job.folder, { recursive: true, force: true }) }
    if (job.worker) void job.worker.terminate().then(cleanup)
    else cleanup()
  }
  close(): void { this.closing = true; for (const [id, job] of this.jobs) this.remove(id, job) }
}
