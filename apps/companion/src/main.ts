import { ExplorationObserver } from './exploration.ts'
import { MiningObserver } from './mining.ts'
import { readFactorySites } from './factory-rally.ts'
import { compileChecks, loadPrompts } from '@ra2c/command'
import { scriptedFixedKinds } from './execution-modes.ts'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { createScriptExecutors } from '@ra2c/js-worker'
import { ModelSettings } from './model-settings.ts'
import { BattleDownloads } from './battle-downloads.ts'
import { restoreBrowserDownloads } from './browser-downloads.ts'
import { SpeechSettings } from './speech-settings.ts'
import { TranscriptQueue, type TranscriptTurn } from './transcript-queue.ts'
import {
  FormationRegistry,
  persistState,
  restoreState,
  TaskRuntime,
  type PersistedState,
  saveStateFile,
  readStateFile,
} from '@ra2c/runtime'
import { createGameDefaultsSource, setupCdnProxy, WerhdBridge } from '@ra2c/game-werhd'
import { dismissStartupDialogs } from './auto-import.ts'
import { startStaticServer } from './static-server.ts'
import { handleCommand, usage, type CommandContext } from './commands.ts'
import { ProgramController } from './controller.ts'
import { prepareGoals } from './prepare-goals.ts'
import { buildWorkbench, openWorkbench, refreshCommandPanel, WORKBENCH_PATH } from './workbench.ts'
import { CommandLog } from './command-log.ts'
import { runTranscript } from './transcript.ts'
import { localGameResources } from './game-resources.ts'
import { WorkbenchApi } from './workbench-api.ts'
import { bindDefaultMap, loadIceMap } from './map-binding.ts'
import { BattleRecords } from './battle-records.ts'

// import.meta.dirname = apps/companion/src，仓库根需上溯三级。
const ROOT = resolve(import.meta.dirname, '../../..')
const DATA_ROOT = resolve(process.env.RA2C_DATA_ROOT ?? ROOT)
const ELECTRON = process.env.RA2C_BROWSER === 'electron'
const PROFILE_DIR = process.env.RA2C_PROFILE ?? join(DATA_ROOT, '.runtime/profile')
const GAME_DIR = process.env.RA2C_GAME_DIR ?? (process.env.RA2C_PACKAGED === '1' ? join(ROOT, 'resources/game-site') : join(homedir(), 'my/code/ra2web.github.io'))
const PACK_PATH = process.env.RA2C_PACK ?? join(homedir(), 'Downloads/full-pack.7z')
const PORT = Number(process.env.RA2C_PORT ?? 8787)
/** 命令通道端口：一行一条命令，返回多行结果；供自动化脚本与外部进程使用。 */
const CMD_PORT = Number(process.env.RA2C_CMD_PORT ?? 8790)
/** 浏览器 CDP 端口：浏览器常驻独立进程，companion 重启只断连不杀对局。 */
const CDP_PORT = Number(process.env.RA2C_CDP_PORT ?? 9222)
/** 任务/编队持久化状态文件。 */
const STATE_FILE = join(DATA_ROOT, '.runtime/state.json')

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
  if (!ELECTRON && !(await alive())) {
    await new Promise((r) => setTimeout(r, 1500))
  }
  if (!ELECTRON && !(await alive())) {
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
        '--window-size=1480,960',
        'about:blank',
      ],
      { detached: true, stdio: 'ignore' },
    ).unref()
    for (let i = 0; i < 40 && !(await alive()); i++) {
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (!(await alive())) throw new Error('常驻 Chromium 启动超时（CDP 未就绪）')
  }
  if (ELECTRON && !(await alive())) throw new Error('Electron 窗口尚未建立连接，未启动外部浏览器')
  // macOS 上浏览器可能常驻但已没有窗口；先建立 target，避免 CDP context 初始化失败。
  const targets = await fetch(`${cdpUrl}/json/list`).then(r => r.json()) as Array<{ type: string }>
  if (!targets.some(t => t.type === 'page')) {
    if (ELECTRON) throw new Error('Electron 游戏窗口尚未建立')
    const created = await fetch(`${cdpUrl}/json/new?about:blank`, { method: 'PUT' })
    if (!created.ok) throw new Error('无法创建浏览器窗口')
  }
  const browser = await chromium.connectOverCDP(cdpUrl)
  const context = browser.contexts()[0]
  if (!context) throw new Error('CDP 连接没有可用 context')
  await restoreBrowserDownloads(browser)
  return { browser, context }
}

async function main(): Promise<void> {
  let running = true, hardQuit = false
  const lifetime = new AbortController()
  let quit = () => { running = false; lifetime.abort() }
  // Electron 管理宿主生命周期，关闭窗口与父进程断开均走正常保存退出。
  if (ELECTRON) {
    process.on('message', message => { if ((message as { type?: string })?.type === 'ra2c-stop') quit() })
    process.on('disconnect', () => quit())
  }
  try {
    process.loadEnvFile(join(ROOT, '.env'))
  } catch (err) {
    console.log('[companion] .env 未加载；可在设置页配置模型')
  }

  const scriptKinds = scriptedFixedKinds()
  const resources = await localGameResources(ROOT, GAME_DIR, { required: ELECTRON,
    ...(process.env.RA2C_GAME_RESOURCES_DIR ? { directory: process.env.RA2C_GAME_RESOURCES_DIR } : {}) })
  const models = new ModelSettings(DATA_ROOT), providers = models.providers
  if (models.view().warning) console.log(`[companion] ${models.view().warning}`)

  let bridge: WerhdBridge | undefined
  // 阶段 2：命令记录与事件流；HTTP 端点在 ctx 建立前注册，处理函数延后绑定。
  const records = new BattleRecords(DATA_ROOT)
  records.importTranscripts(DATA_ROOT)
  const commandLog = new CommandLog(records)
  let submitSay: ((text: string, source: 'sidebar' | 'voice' | 'cli', commandId: string) => Promise<string>) | undefined
  const speech = new SpeechSettings(DATA_ROOT, process.env, ROOT)
  const voiceTurns = new Map<string, TranscriptTurn>()
  void speech.recognizer.start().catch(error => console.log(`[companion] ${String(error)}`))
  const api = new WorkbenchApi({ log: commandLog, records, models, speech, downloads: new BattleDownloads(DATA_ROOT), ready: () => running && !!submitSay,
    submit: (text, commandId, source) => submitSay!(text, source, commandId),
    reserveVoice: id => {
      if (!commandContext) throw new Error('指挥系统尚未就绪')
      const turn = (commandContext.transcripts ??= new TranscriptQueue()).register(commandContext.runtime.battleKey)
      voiceTurns.set(id, turn)
      return { signal: turn.signal, finish: () => { turn.finish(); voiceTurns.delete(id) } }
    },
    status: async () => (await bridge?.state())?.apiAlive ? 'ready' : bridge ? 'waiting' : 'loading',
  })
  let resourceOrigin = ''
  const server = await startStaticServer({
    root: GAME_DIR,
    extraFiles: { '/pack.7z': PACK_PATH, ...resources?.filePaths, ...buildWorkbench(ROOT) },
    port: PORT,
    tlsDir: join(DATA_ROOT, '.runtime/certs'),
    handleRequest: async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'https://127.0.0.1').pathname
      if (resources?.handleRequest(req, res, resourceOrigin)) return true
      if (pathname === WORKBENCH_PATH.slice(0, -1)) { res.writeHead(308, { location: WORKBENCH_PATH }); res.end(); return true }
      return api.handle(req, res)
    },
  })
  resourceOrigin = server.url
  if (resources) console.log(`[companion] 使用本机游戏资源 ${resources.id}（${resources.files} 个文件）`)
  console.log(`[companion] 游戏站点: ${server.url}  (目录 ${GAME_DIR})`)
  if (ELECTRON) process.send?.({ type: 'ra2c-listening', url: server.url })

  mkdirSync(PROFILE_DIR, { recursive: true })
  const { browser, context } = await ensureBrowserContext()
  console.log(ELECTRON ? '[companion] 已连接 Electron 独立窗口' : '[companion] 浏览器常驻模式（CDP）：companion 重启不再关闭对局')
  // 游戏 CDN 对本地 origin 无 CORS 头，经 Node 侧转发并补头；资源随后缓存进 profile。
  await setupCdnProxy(context)
  await resources?.installMaps(context)
  await context.addInitScript({ content: createGameDefaultsSource(server.url) })
  const gameProfile = loadPrompts().game, crushing = gameProfile.crushing()
  const foundations = Object.fromEntries(gameProfile.entries().flatMap(item =>
    item.type === 2 && item.foundation ? [[item.name, item.foundation]] : []))
  const gameBridge = new WerhdBridge(context, server.url, foundations, crushing)
  bridge = gameBridge
  await gameBridge.install()

  const executors = createScriptExecutors()
  const formations = new FormationRegistry()
  const iceMap = await loadIceMap()
  let controller!: ProgramController
  const currentModel = models.current
  const runtime: TaskRuntime = new TaskRuntime({
    executor: executors.runtime, formations,
    ...(crushing ? { crushing } : {}),
    regionsAt: (x,y) => iceMap.regions.regionsAt(x,y).map(region=>({id:region.id,name:region.name,polygons:region.polygons})),
    checkpoint: () => saveStateFile(STATE_FILE, persistState(runtime)),
    coverRanges: (pairs, snap) => gameBridge.coverRanges(pairs, snap.sessionKey),
    factorySites: snap => readFactorySites(gameBridge, snap),
    buildingFoundation: name => foundations[name],
    rallyTiles: (points, snap) => gameBridge.rallyTiles(points, snap.sessionKey),
    rallyClear: point => iceMap.obstacles.clear3x3(point.x, point.y) && [-1, 0, 1].every(dx => [-1, 0, 1].every(dy => iceMap.area.contains(point.x + dx, point.y + dy))),
    submit: async (actions, context, guard) => {
      const results = []
      for (const action of actions) {
        if (!guard()) break
        results.push(await gameBridge.submit(action, context, guard))
      }
      return results
    },
    onProgramFaulted: id => controller.fault(id),
    onProgramStalled: (id, reason) => controller.fault(id, reason),
    log: message => console.log(message),
  })
  controller = new ProgramController({
    runtime, executor: executors.compilation, provider: currentModel,
    recordCompilation: records.compilation,
    prepare: (goals, signal, prompts, ruleCache) => {
      const snap = runtime.snapshot
      if (!snap) throw new Error('当前没有有效快照')
      return prepareGoals(goals, snap, (name, type) => gameBridge.rules(name, type), signal, prompts.game, ruleCache)
    },
    log: message => console.log(message),
  })

  let pendingRestore: PersistedState | undefined
  try { pendingRestore = readStateFile(STATE_FILE) }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.log(`[companion] 未恢复旧状态：${String(err).slice(0, 180)}`) }
  let lastSessionKey = ''
  const explorationObserver = new ExplorationObserver()
  const miningObserver = new MiningObserver()
  let lastMiningWarning = 0
  let lastExplorationWarning = 0
  let commandContext: CommandContext | undefined
  let mapAttemptSession = ''
  let stateDirty = false
  const markDirty = () => { stateDirty = true }
  const saveState = () => {
    // 等待当前页面的第一份快照时，不能用空状态覆盖待恢复文件。
    if (!runtime.snapshot) return
    try { saveStateFile(STATE_FILE, persistState(runtime)); stateDirty = false }
    catch (err) { console.log(`[companion] 状态保存失败：${String(err).slice(0, 120)}`) }
    records.observe(runtime)
  }
  const saveTimer = setInterval(() => { if (stateDirty) saveState() }, 3000)
  saveTimer.unref()

  const unbindSnapshots = gameBridge.onSnapshot(snap => {
    if (!running) return
    if (runtime.battleKey && runtime.battleKey !== snap.sessionKey) records.observe(runtime)
    records.setSession(snap.sessionKey)
    if (snap.sessionKey !== lastSessionKey) {
      lastSessionKey = snap.sessionKey
      console.log(`[companion] 当前对局 ${snap.sessionKey}，tick=${snap.tick}，己方=${snap.self.length}`)
    }
    const advance = runtime.onSnapshot(snap)
    commandContext?.transcripts?.setSession(runtime.battleKey)
    if (commandContext && mapAttemptSession !== runtime.battleKey) {
      mapAttemptSession = runtime.battleKey
      void bindDefaultMap(commandContext).catch(error => console.log(`[companion] 默认分区绑定失败：${String(error)}`))
    }
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
      if (!running) return
      markDirty()
      if (commandContext) void explorationObserver.poll(commandContext).catch(error => {
        if (Date.now() - lastExplorationWarning > 10000) { lastExplorationWarning = Date.now(); console.log(`[companion] 地图观察暂不可用：${String(error).slice(0, 160)}`) }
      })
      if (commandContext) void miningObserver.poll(commandContext).catch(error => {
        if (Date.now() - lastMiningWarning > 10000) { lastMiningWarning = Date.now(); console.log(`[companion] 矿格观察暂不可用：${String(error).slice(0, 160)}`) }
      })
      if (restored) {
        commandLog.restoreCurrent(DATA_ROOT, runtime)
        controller.useScriptExecution(scriptKinds)
      }
      commandLog.syncRuntime(runtime)
      records.observe(runtime)
      if (restored) {
        for (const program of runtime.programs.values()) {
          if (program.status !== 'stopped') controller.activateNative(program.id)
          if (!['paused', 'stopped'].includes(program.status)) void controller.prepareNative(program.id).catch(err => console.log(`[companion] 恢复本机准备失败：${String(err)}`))
          const waiting = program.goalIds.some(id => { const goal = runtime.goals.get(id); return goal && goal.spec.executionMode !== 'native' && !['cancelled', 'completed', 'partial', 'failed'].includes(goal.status) && JSON.stringify(goal.spec) !== JSON.stringify(goal.activeSpec) })
          if (waiting && program.status !== 'paused' && program.status !== 'stopped') void controller.refresh(program.id).catch(err => console.log(`[companion] 恢复待生效目标失败：${String(err)}`))
          else if (program.status === 'active' && program.script) {
            const errors = compileChecks(program.script.code)
            if (errors.length) controller.fault(program.id, `恢复脚本不符合当前契约：${errors.join('；')}`)
          }
        }
      }
    }).catch(err => console.error(`[runtime] 快照处理错误：${String(err)}`))
  })

  const { page, frame, reused, legacy } = await openWorkbench(context, server.url)
  gameBridge.bindGameFrame(frame)
  if (legacy) console.log('[companion] 保留正在进行的旧版对局；结束后打开工作台，不自动迁移或刷新')
  else console.log(`[companion] 工作台: ${new URL(WORKBENCH_PATH, server.url).href}`)
  if (!reused) {
    const dialogs = dismissStartupDialogs(frame, { signal: lifetime.signal })
    if (ELECTRON) void dialogs.catch(error => { if (!lifetime.signal.aborted) console.log(`[companion] 启动提示处理失败：${String(error).slice(0, 180)}`) })
    else await dialogs
  }
  if (reused && !legacy) await refreshCommandPanel(page).catch(error => console.log(`[companion] 侧栏更新失败，保留原界面：${String(error)}`))

  if (!providers.size) {
    console.log('[companion] 未配置云模型，可在设置页填写 URL、Key 和模型名称；桥命令不受影响。')
  }
  const ctx: CommandContext = {
    browser, bridge: gameBridge, page, runtime, formations, providers, controller, dataRoot: DATA_ROOT,
    currentProvider: currentModel,
    selectProvider: () => { models.current() },
    commandLog,
  }
  commandContext = ctx
  commandLog.follow(controller, runtime)
  if (runtime.snapshot) commandLog.restoreCurrent(DATA_ROOT, runtime)
  await bindDefaultMap(ctx).catch(error => console.log(`[companion] 默认分区绑定失败：${String(error)}`))
  submitSay = async (text, source, commandId) => {
    const turn = source === 'voice' ? voiceTurns.get(commandId) : undefined
    try { return await runTranscript(text, ctx, DATA_ROOT, { commandId, source, log: commandLog, ...(turn ? { turn } : {}) }) }
    finally { markDirty(); saveState(); commandLog.syncRuntime(runtime) }
  }
  controller.setProvider(() => ctx.currentProvider())
  const requested = !running
  let closing = false
  quit = () => {
    if (closing) return
    closing = true
    running = false; lifetime.abort(); unbindSnapshots(); clearInterval(saveTimer)
    api.close(); runtime.cancelAllCommands(); ctx.transcripts?.cancelAll(new Error('伴随程序正在退出')); saveState()
  }
  if (requested) quit()
  const runLine = async (line: string): Promise<string> => {
    if (!running) return '程序正在退出'
    let out: string
    try { out = await handleCommand(line, ctx) }
    finally { markDirty(); saveState(); commandLog.syncRuntime(runtime) } // 成功和失败的目标变更都在回显前保存
    if (out === '__QUIT__' || out === '__QUIT_HARD__') {
      hardQuit = out === '__QUIT_HARD__'
      quit()
      return 'bye'
    }
    return out
  }

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
  if (ELECTRON) process.send?.({ type: 'ra2c-ready', url: server.url })

  console.log('[companion] 游戏已就绪。请在浏览器窗口手动进入 单机模式 → 遭遇战开局。')
  if (!ELECTRON) console.log(usage())

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

  quit()
  records.observe(runtime)
  records.close()
  if (ELECTRON) console.log('[companion] 记录已保存，正在断开游戏窗口')
  if (hardQuit) {
    const session = await browser.newBrowserCDPSession()
    await session.send('Browser.close').catch(() => {})
  } else {
    // connectOverCDP 的 close 仅断连：浏览器与对局保留，重启 companion 即恢复。
    await browser.close()
  }
  if (ELECTRON) console.log('[companion] 游戏连接已断开')
  await executors.dispose()
  server.close()
  server.closeAllConnections()
  cmdServer.close()
  if (ELECTRON && process.connected) process.disconnect()
  if (ELECTRON) console.log('[companion] 指挥服务已停止')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
