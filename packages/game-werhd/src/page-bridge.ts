import { readFile } from 'node:fs/promises'
import type { BrowserContext, Frame } from 'playwright'
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
const BRIDGE_VERSION = 13

export function isGameDocument(url: string, gameUrl: string): boolean {
  try {
    const current = new URL(url), expected = new URL(gameUrl)
    return current.origin === expected.origin && [expected.pathname, `${expected.pathname}index.html`].includes(current.pathname)
  } catch { return false }
}

export class WerhdBridge {
  private ruleSession = ''
  private ruleCache = new Map<string, unknown>()
  private latestSnapshot: Snapshot | undefined
  private readonly listeners = new Set<(s: Snapshot) => void>()
  private targetFrame: Frame | undefined

  constructor(private readonly context: BrowserContext, private readonly gameUrl?: string) {}

  async install(): Promise<void> {
    const source = await readFile(new URL('./bridge.js', import.meta.url), 'utf8')
    await this.context.exposeBinding(BINDING.snapshot, (source, snapshot: Snapshot) => {
      if (this.gameUrl && !isGameDocument(source.frame.url(), this.gameUrl)) return
      if (source.frame !== this.findFrame()) return
      this.latestSnapshot = snapshot
      for (const cb of this.listeners) cb(snapshot)
    })
    // 工作台与游戏同源，但只有游戏文档安装采样桥。
    const game = this.gameUrl && new URL(this.gameUrl)
    const bootstrap = game ? `if (location.origin === ${JSON.stringify(game.origin)} && ${JSON.stringify([game.pathname, `${game.pathname}index.html`])}.includes(location.pathname)) {\n${source}\n}` : source
    await this.context.addInitScript(bootstrap)
    // 已打开的页面：桥缺失（断连期间刷新过）或版本旧（companion 升级）都重装；
    // bridge.js 自带版本比较与旧轮询清理。
    for (const frame of this.context.pages().flatMap(page => page.frames())) {
      if (this.gameUrl && !isGameDocument(frame.url(), this.gameUrl)) continue
      const ver = (await frame.evaluate(`window.__ra2cVersion ?? 0`).catch(() => 0)) as number
      if (ver < BRIDGE_VERSION) {
        await frame.evaluate(source).catch(() => {})
      }
    }
  }

  bindGameFrame(frame: Frame): void {
    if (this.targetFrame !== frame) this.latestSnapshot = undefined
    this.targetFrame = frame
  }

  onSnapshot(cb: (s: Snapshot) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  get latest(): Snapshot | undefined {
    return this.latestSnapshot
  }

  /** visible 表示黑幕已揭开，不是当前交战视野，也不证明可通行。 */
  async readMapBatch(cells: number[], width: number, sessionKey: string): Promise<{ seen: number[]; impassable: number[]; ore?: number[] }> {
    if (cells.length > 256) throw new Error('地图观察批次过大')
    return this.frame.evaluate(({ cells, width, sessionKey }) => {
      const win = window as unknown as { __ra2cSessionKey?: string; werhd?: { map: { visible(x: number, y: number): boolean; tile(x: number, y: number): { landType?: number; onBridge?: boolean; bridge?: unknown } | undefined } } }
      if (win.__ra2cSessionKey !== sessionKey || !win.werhd) throw new Error('地图观察对局已变化')
      const seen: number[] = [], impassable: number[] = [], ore: number[] = []
      for (const cell of cells) {
        const x = cell % width, y = Math.floor(cell / width)
        if (!win.werhd.map.visible(x, y)) continue
        const tile = win.werhd.map.tile(x, y)
        if (!tile) continue
        seen.push(cell)
        if (tile.landType === 9) ore.push(cell)
        if (!tile.onBridge && !tile.bridge && [7, 8, 10].includes(tile.landType ?? -1)) impassable.push(cell)
      }
      if (win.__ra2cSessionKey !== sessionKey) throw new Error('地图观察对局已变化')
      return { seen, impassable, ore }
    }, { cells, width, sessionKey })
  }

  private findFrame(): Frame | undefined {
    if (this.targetFrame && !this.targetFrame.isDetached()) return this.targetFrame
    const pages = this.context.pages()
    if (!this.gameUrl) return pages[pages.length - 1]?.mainFrame()
    const frames = pages.flatMap(page => page.frames()).filter(frame => isGameDocument(frame.url(), this.gameUrl!))
    return frames.find(frame => frame.name() === 'ra2c-game') ?? frames[0]
  }

  get frame(): Frame {
    const frame = this.findFrame()
    if (!frame) throw new Error('游戏页面尚未打开')
    return frame
  }

  async state(): Promise<BridgeState> {
    const frame = this.findFrame()
    if (!frame) throw new Error('游戏 frame 尚未建立')
    try {
      return await frame.evaluate(`window.__ra2cState()`)
    } catch {
      // 工作台刷新会重建同源游戏 iframe，init script 不覆盖该场景——此处补装后重试。
      await this.ensureBridge(frame)
      return await frame.evaluate(`window.__ra2cState()`)
    }
  }

  /** 确保目标 frame 内桥已安装且为当前版本（可重入；刷新/重绑后自愈）。 */
  private async ensureBridge(frame: Frame): Promise<void> {
    const source = (this.bridgeSource ??= await readFile(new URL('./bridge.js', import.meta.url), 'utf8'))
    const ver = (await frame.evaluate(`window.__ra2cVersion ?? 0`).catch(() => 0)) as number
    if (ver < BRIDGE_VERSION) await frame.evaluate(source).catch(() => {})
  }

  private bridgeSource?: string

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
    if (this.latestSnapshot) return (await this.rulesMany([{ name, type }], this.latestSnapshot.sessionKey))[0]?.rule
    return this.frame.evaluate(
      `(() => { const w = window.werhd; if (!w) return undefined; return w.rules(${JSON.stringify(name)}, ${type}) })()`,
    )
  }

  /** 按本局缓存静态规则，批量查询不经过逐 tick 回调；可造性始终读取最新快照。 */
  async rulesMany(requests: Array<{ name: string; type: number }>, sessionKey: string): Promise<Array<{ name: string; type: number; rule: unknown }>> {
    if (this.ruleSession !== sessionKey) { this.ruleSession = sessionKey; this.ruleCache.clear() }
    const missing = requests.filter(request => !this.ruleCache.has(`${request.type}:${request.name}`))
    for (let start = 0; start < missing.length; start += 64) {
      const chunk = missing.slice(start, start + 64)
      const rules = await this.frame.evaluate(({ requests, key }) => {
        const win = window as unknown as { __ra2cSessionKey?: string; werhd?: { rules(name: string, type: number): unknown } }
        if (win.__ra2cSessionKey !== key || !win.werhd) throw new Error('规则查询对局已变化')
        return requests.map(request => win.werhd!.rules(request.name, request.type))
      }, { requests: chunk, key: sessionKey })
      if (this.ruleSession !== sessionKey) throw new Error('规则查询已过期')
      chunk.forEach((request, index) => this.ruleCache.set(`${request.type}:${request.name}`, rules[index]))
    }
    return requests.map(request => ({ ...request, rule: this.ruleCache.get(`${request.type}:${request.name}`) }))
  }

  /** 提交动作；会话不一致或单位失效时被拒绝。 */
  async submit(action: ActionRequest, context: ActionContext | undefined = this.latestSnapshot, guard: () => boolean = () => true): Promise<ActionResult> {
    if (!context || !guard()) return { ok: false, reason: 'revoked-or-no-snapshot', submitted: 0, session: context?.session ?? -1 }
    // guard 与 evaluate 之间不 await；撤权后不再向浏览器排入旧动作。
    return this.frame.evaluate(
      ([ctx, act]) => (window as unknown as {
        __ra2cSubmit: (s: number, a: ActionRequest, seq: number, key: string) => ActionResult
      }).__ra2cSubmit(ctx.session, act, ctx.seq, ctx.sessionKey),
      [context, action] as const,
    )
  }
}
