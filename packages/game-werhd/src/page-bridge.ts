import { readFile } from 'node:fs/promises'
import type { BrowserContext, Page } from 'playwright'
import { BINDING, type ActionRequest, type ActionResult, type Snapshot } from '@ra2c/contracts'

/** 页面内桥状态（window.__ra2cState() 的返回）。 */
export interface BridgeState {
  installed: boolean
  session: number
  sessionNote: string
  apiAlive: boolean
  hookedSession: number
  lastTickAt: number
  sampleEvery: number
  stats: { samples: number; collectMsMax: number; degradeCount: number }
}

/**
 * 宿主侧桥：把 bridge.js 注入游戏页面，订阅快照，提交动作。
 *
 * install() 必须在打开任何页面之前调用（exposeBinding/addInitScript 是 context 级）。
 */
export class WerhdBridge {
  private latestSnapshot?: Snapshot
  private readonly listeners = new Set<(s: Snapshot) => void>()

  constructor(private readonly context: BrowserContext) {}

  async install(): Promise<void> {
    const source = await readFile(new URL('./bridge.js', import.meta.url), 'utf8')
    await this.context.exposeBinding(BINDING.snapshot, (_source, snapshot: Snapshot) => {
      this.latestSnapshot = snapshot
      for (const cb of this.listeners) cb(snapshot)
    })
    await this.context.addInitScript(source)
    // 已打开的页面可能没有桥（companion 断连期间页面被刷新过；addInitScript 只对未来导航生效）。
    // 立即补装，实现 companion 重启即恢复。
    for (const page of this.context.pages()) {
      const has = await page.evaluate(`!!window.__ra2cInstalled`).catch(() => false)
      if (!has) {
        await page.evaluate(source).catch(() => {})
      }
    }
  }

  onSnapshot(cb: (s: Snapshot) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  get latest(): Snapshot | undefined {
    return this.latestSnapshot
  }

  private page(): Page {
    const pages = this.context.pages()
    const page = pages[pages.length - 1]
    if (!page) throw new Error('游戏页面尚未打开')
    return page
  }

  async state(): Promise<BridgeState> {
    return this.page().evaluate(() => (window as unknown as {
      __ra2cState: () => BridgeState
    }).__ra2cState())
  }

  /** 等待对局 API 出现（玩家手动开局期间轮询）。 */
  async waitForApi(timeoutMs = 600_000, pollMs = 1000): Promise<BridgeState> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const st = await this.state()
      if (st.apiAlive) return st
      if (Date.now() > deadline) throw new Error('等待对局超时：window.werhd 未出现')
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }

  /** 查询当前有效规则（含地图/MOD 覆盖）；无效名称返回 undefined。 */
  async rules(name: string, type: number): Promise<unknown> {
    return this.page().evaluate(
      `(() => { const w = window.werhd; if (!w) return undefined; return w.rules(${JSON.stringify(name)}, ${type}) })()`,
    )
  }

  /** 提交动作；会话不一致或单位失效时被拒绝。 */
  async submit(action: ActionRequest): Promise<ActionResult> {
    const st = await this.state()
    return this.page().evaluate(
      ([session, act]) => (window as unknown as {
        __ra2cSubmit: (s: number, a: ActionRequest) => ActionResult
      }).__ra2cSubmit(session, act),
      [st.session, action] as const,
    )
  }
}
