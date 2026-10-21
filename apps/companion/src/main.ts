import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { StepExecutor } from '@ra2c/js-worker'
import { configuredProviderNames, providerFromEnv, type OpenAICompatibleProvider } from '@ra2c/model-providers'
import {
  FormationRegistry,
  persistState,
  restoreState,
  TaskRuntime,
  type PersistedState,
  saveStateFile,
  readStateFile,
} from '@ra2c/runtime'
import { setupCdnProxy, WerhdBridge } from '@ra2c/game-werhd'
import { dismissStartupDialogs } from './auto-import.ts'
import { startStaticServer } from './static-server.ts'
import { handleCommand, usage, type CommandContext } from './commands.ts'
import { ProgramController } from './controller.ts'
import { prepareGoals } from './prepare-goals.ts'

// import.meta.dirname = apps/companion/src，仓库根需上溯三级。
const ROOT = resolve(import.meta.dirname, '../../..')
const PROFILE_DIR = process.env.RA2C_PROFILE ?? join(ROOT, '.runtime/profile')
const GAME_DIR = process.env.RA2C_GAME_DIR ?? join(homedir(), 'my/code/ra2web.github.io')
const PACK_PATH = process.env.RA2C_PACK ?? join(homedir(), 'Downloads/full-pack.7z')
const PORT = Number(process.env.RA2C_PORT ?? 8787)
/** 命令通道端口：一行一条命令，返回多行结果；供自动化脚本与外部进程使用。 */
const CMD_PORT = Number(process.env.RA2C_CMD_PORT ?? 8790)
/** 浏览器 CDP 端口：浏览器常驻独立进程，companion 重启只断连不杀对局。 */
const CDP_PORT = Number(process.env.RA2C_CDP_PORT ?? 9222)
/** 任务/编队持久化状态文件。 */
const STATE_FILE = join(ROOT, '.runtime/state.json')

/**
 * 确保 Chromium 常驻运行并经 CDP 连接。
 * 首次由 companion 拉起（detached，companion 退出后存活），之后任何 companion 实例直接复用；
 * 代码改动只需重启 companion，桥留在页面里，重连即恢复快照流。
 */
async function ensureBrowserContext(): Promise<{ browser: Browser; context: BrowserContext }> {
  const cdpUrl = `http://127.0.0.1:${CDP_PORT}`
  const alive = () => fetch(`${cdpUrl}/json/version`).then((r) => r.ok).catch(() => false)
  // 防竞态双检查：上一次 companion/任务清理的瞬间窗口里 CDP 可能短暂不可达，
  // 误判"无浏览器"会 spawn 同 profile 第二实例并引发实例更替（对局丢失）。
  if (!(await alive())) {
    await new Promise((r) => setTimeout(r, 1500))
  }
  if (!(await alive())) {
    mkdirSync(PROFILE_DIR, { recursive: true })
    spawn(
      chromium.executablePath(),
      [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--ignore-certificate-errors', // 本地 https 为自签证书
        // 资源 CDN 对本地 origin 不回 CORS 头。浏览器级关闭同源策略（专用实例无浏览风险），
        // 使跨源资源请求不依赖 Playwright route——companion 断连/重启时代理失效曾触发
        // 游戏的资源校验失败 → location.reload() → 单机对局丢失。
        '--disable-web-security',
        '--test-type', // 抑制 Chrome for Testing 的"仅用于自动测试"信息条
        '--disable-infobars',
        'about:blank',
      ],
      { detached: true, stdio: 'ignore' },
    ).unref()
    for (let i = 0; i < 40 && !(await alive()); i++) {
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (!(await alive())) throw new Error('常驻 Chromium 启动超时（CDP 未就绪）')
  }
  const browser = await chromium.connectOverCDP(cdpUrl)
  const context = browser.contexts()[0]
  if (!context) throw new Error('CDP 连接没有可用 context')
  return { browser, context }
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile(join(ROOT, '.env'))
  } catch (err) {
    console.log(`[companion] .env 未加载（${String(err).slice(0, 120)}）；仅桥命令可用`)
  }

  const providers = new Map<string, OpenAICompatibleProvider>()
  for (const name of configuredProviderNames(process.env)) {
    try {
      providers.set(name, providerFromEnv(name, process.env))
    } catch (err) {
      console.log(`[companion] 云模型 ${name} 不可用: ${String(err).slice(0, 120)}`)
    }
  }

  const server = await startStaticServer({
    root: GAME_DIR,
    extraFiles: { '/pack.7z': PACK_PATH },
    port: PORT,
    tlsDir: join(ROOT, '.runtime/certs'),
  })
  console.log(`[companion] 游戏站点: ${server.url}  (目录 ${GAME_DIR})`)

  mkdirSync(PROFILE_DIR, { recursive: true })
  const { browser, context } = await ensureBrowserContext()
  console.log('[companion] 浏览器常驻模式（CDP）：companion 重启不再关闭对局')
  // 游戏 CDN 对本地 origin 无 CORS 头，经 Node 侧转发并补头；资源随后缓存进 profile。
  await setupCdnProxy(context)
  const bridge = new WerhdBridge(context, server.url)
  await bridge.install()

  const executor = new StepExecutor()
  const formations = new FormationRegistry()
  let controller!: ProgramController
  let currentProvider: OpenAICompatibleProvider | undefined
  const currentModel = () => {
    currentProvider ??= providers.values().next().value
    if (!currentProvider) throw new Error('没有可用的云模型（检查 .env 的 *_API_KEY）')
    return currentProvider
  }
  const runtime: TaskRuntime = new TaskRuntime({
    executor, formations,
    checkpoint: () => saveStateFile(STATE_FILE, persistState(runtime)),
    submit: async (actions, context, guard) => {
      const results = []
      for (const action of actions) {
        if (!guard()) break
        results.push(await bridge.submit(action, context, guard))
      }
      return results
    },
    onProgramFaulted: id => controller.fault(id),
    log: message => console.log(message),
  })
  controller = new ProgramController({
    runtime, executor, provider: currentModel,
    prepare: (goals, signal) => {
      const snap = runtime.snapshot
      if (!snap) throw new Error('当前没有有效快照')
      return prepareGoals(goals, snap, (name, type) => bridge.rules(name, type), signal)
    },
    log: message => console.log(message),
  })

  let pendingRestore: PersistedState | undefined
  try { pendingRestore = readStateFile(STATE_FILE) }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.log(`[companion] 未恢复旧状态：${String(err).slice(0, 180)}`) }
  let lastSessionKey = ''
  let stateDirty = false
  const markDirty = () => { stateDirty = true }
  const saveState = () => {
    // 等待当前页面的第一份快照时，不能用空状态覆盖待恢复文件。
    if (!runtime.snapshot) return
    try { saveStateFile(STATE_FILE, persistState(runtime)); stateDirty = false }
    catch (err) { console.log(`[companion] 状态保存失败：${String(err).slice(0, 120)}`) }
  }
  setInterval(() => { if (stateDirty) saveState() }, 3000).unref()

  bridge.onSnapshot(snap => {
    if (snap.sessionKey !== lastSessionKey) {
      lastSessionKey = snap.sessionKey
      console.log(`[companion] 当前对局 ${snap.sessionKey}，tick=${snap.tick}，己方=${snap.self.length}`)
    }
    const advance = runtime.onSnapshot(snap)
    let restored = false
    if (pendingRestore) {
      const state = pendingRestore
      pendingRestore = undefined
      try {
        const count = restoreState(runtime, state)
        restored = true
        console.log(`[companion] 同局恢复 ${count} 份脚本、${runtime.goals.size} 个目标`)
      } catch (err) { console.log(`[companion] 未恢复：${String(err).slice(0, 180)}`) }
    }
    void advance.then(() => {
      markDirty()
      if (restored) {
        for (const program of runtime.programs.values()) {
          const waiting = program.goalIds.some(id => { const goal = runtime.goals.get(id); return goal && goal.status !== 'cancelled' && goal.status !== 'completed' && JSON.stringify(goal.spec) !== JSON.stringify(goal.activeSpec) })
          if (waiting && program.status !== 'paused' && program.status !== 'stopped') void controller.refresh(program.id).catch(err => console.log(`[companion] 恢复待生效目标失败：${String(err)}`))
        }
      }
    }).catch(err => console.error(`[runtime] 快照处理错误：${String(err)}`))
  })

  // 找到游戏页（companion 重启后页面还在，桥也还在）。
  const gameUrl = `127.0.0.1:${PORT}`
  const page =
    context.pages().find((p) => p.url().includes(gameUrl)) ??
    context.pages()[0] ??
    (await context.newPage())
  await page.setViewportSize({ width: 1152, height: 864 }).catch(() => {})
  if (!page.url().includes(gameUrl)) {
    // load 事件在大资源页可能很久；domcontentloaded 足够启动对话框陪跑，超时容忍（页面继续加载）。
    await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((err) => {
      console.log(`[companion] 页面加载等待超时（继续，页面自行完成加载）: ${String(err).slice(0, 100)}`)
    })
    await dismissStartupDialogs(page)
  }

  if (!providers.size) {
    console.log('[companion] 未配置任何云模型 key（.env），task new 不可用；桥命令不受影响。')
  }
  const ctx: CommandContext = {
    browser, bridge, page, runtime, formations, providers, controller,
    currentProvider: currentModel,
  }
  controller.setProvider(() => ctx.currentProvider())
  let running = true
  const runLine = async (line: string): Promise<string> => {
    if (!running) return '程序正在退出'
    let out: string
    try { out = await handleCommand(line, ctx) }
    finally { markDirty(); saveState() } // 成功和失败的目标变更都在回显前保存
    if (out === '__QUIT__' || out === '__QUIT_HARD__') {
      hardQuit = out === '__QUIT_HARD__'
      running = false
      runtime.cancelAllCommands()
      saveState()
      return 'bye'
    }
    return out
  }
  let hardQuit = false

  // 命令通道：一行一命令，回显结果（自动化脚本与外部进程用）。
  const cmdServer = createServer((socket) => {
    let pendingText = ''
    socket.setEncoding('utf8')
    socket.on('data', (buf) => {
      pendingText += buf
      if (pendingText.length > 65_536) { socket.destroy(); return }
      const lines = pendingText.split('\n')
      pendingText = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line) continue
        void runLine(line).then(out => {
          if (!socket.destroyed) socket.write(`${out}\n`)
          if (!running) socket.end()
        }).catch(err => { if (!socket.destroyed) socket.write(`错误: ${String(err)}\n`) })
      }
    })
    socket.on('error', () => {})
  })
  await new Promise<void>((res, rej) => {
    cmdServer.once('error', rej)
    cmdServer.listen(CMD_PORT, '127.0.0.1', () => res())
  })
  console.log(`[companion] 命令通道: 127.0.0.1:${CMD_PORT}（nc 127.0.0.1 ${CMD_PORT} <<< "status"）`)

  console.log('[companion] 游戏已就绪。请在浏览器窗口手动进入 单机模式 → 遭遇战开局。')
  console.log(usage())

  // 本地终端入口（后台运行无 TTY 时跳过）。
  if (process.stdin.isTTY) {
    const rl = createInterface({ input, output })
    rl.setPrompt('ra2c> ')
    rl.prompt()
    await new Promise<void>(resolve => {
      rl.on('line', line => {
        if (!line.trim()) { rl.prompt(); return }
        void runLine(line.trim()).then(out => {
          console.log(out)
          if (!running) { rl.close(); resolve() } else rl.prompt()
        }).catch(err => { console.error(`错误: ${String(err)}`); rl.prompt() })
      })
      rl.on('close', resolve)
    })
    rl.close()
  } else {
    await new Promise<void>((res) => {
      const check = setInterval(() => {
        if (!running) {
          clearInterval(check)
          res()
        }
      }, 500)
    })
  }

  runtime.cancelAllCommands()
  if (hardQuit) {
    const session = await browser.newBrowserCDPSession()
    await session.send('Browser.close').catch(() => {})
  } else {
    // connectOverCDP 的 close 仅断连：浏览器与对局保留，重启 companion 即恢复。
    await browser.close()
  }
  await executor.dispose()
  server.close()
  cmdServer.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
