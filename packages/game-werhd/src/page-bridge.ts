import { readFile } from 'node:fs/promises'
import type { BrowserContext, Page } from 'playwright'
import { BINDING, type ActionRequest, type ActionResult, type Snapshot, type ActionContext } from '@ra2c/contracts'

/** 页面内桥状态（window.__ra2cState() 的返回）。 */
export interface BridgeState {
  installed: boolean
  session: number
  sessionKey: string
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
/** 桥版本（与 bridge.js 的 BRIDGE_VERSION 保持一致；升级后对已开页面重装）。 */
const BRIDGE_VERSION = 3

export class WerhdBridge {
  private latestSnapshot?: Snapshot
  private readonly listeners = new Set<(s: Snapshot) => void>()

  constructor(private readonly context: BrowserContext, private readonly gameUrl?: string) {}

  async install(): Promise<void> {
    const source = await readFile(new URL('./bridge.js', import.meta.url), 'utf8')
    await this.context.exposeBinding(BINDING.snapshot, (source, snapshot: Snapshot) => {
      if (this.gameUrl && !source.page.url().startsWith(this.gameUrl)) return
      this.latestSnapshot = snapshot
      for (const cb of this.listeners) cb(snapshot)
    })
    await this.context.addInitScript(source)
    // 已打开的页面：桥缺失（断连期间刷新过）或版本旧（companion 升级）都重装；
    // bridge.js 自带版本比较与旧轮询清理。
    for (const page of this.context.pages()) {
      const ver = (await page.evaluate(`window.__ra2cVersion ?? 0`).catch(() => 0)) as number
      if (ver < BRIDGE_VERSION) {
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
    const page = this.gameUrl ? pages.find(p => p.url().startsWith(this.gameUrl!)) : pages[pages.length - 1]
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
  async submit(action: ActionRequest, context: ActionContext | undefined = this.latestSnapshot, guard: () => boolean = () => true): Promise<ActionResult> {
    if (!context || !guard()) return { ok: false, reason: 'revoked-or-no-snapshot', submitted: 0, session: context?.session ?? -1 }
    // guard 与 evaluate 之间不 await；撤权后不再向浏览器排入旧动作。
    return this.page().evaluate(
      ([ctx, act]) => (window as unknown as {
        __ra2cSubmit: (s: number, a: ActionRequest, seq: number, key: string) => ActionResult
      }).__ra2cSubmit(ctx.session, act, ctx.seq, ctx.sessionKey),
      [context, action] as const,
    )
  }
}
