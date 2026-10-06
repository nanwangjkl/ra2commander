import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { ActionRequest, Snapshot } from '@ra2c/contracts'
import { compileCommand, type CompileInput } from '@ra2c/command'
import { StepExecutor } from '@ra2c/js-worker'
import { configuredProviderNames, providerFromEnv, type OpenAICompatibleProvider } from '@ra2c/model-providers'
import { computePrerequisiteClosure, FormationRegistry, TaskRuntime, type TaskSpec } from '@ra2c/runtime'
import { setupCdnProxy, WerhdBridge } from '@ra2c/game-werhd'
import { dismissStartupDialogs } from './auto-import.ts'
import { startStaticServer } from './static-server.ts'

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

function usage(): string {
  return [
    '命令：',
    '  status                 桥状态、会话代次、采样统计',
    '  units [n]              列出最近快照中的己方单位（默认前 20）',
    '  move <ids|all> <x> <y> 移动',
    '  amove <ids|all> <x> <y> 攻击移动',
    '  gather <ids|all> <x> <y> 集结',
    '  attack <ids|all> <targetId> 攻击目标',
    '  stop <ids|all>         停止',
    '  enemy [n]              列出当前可见敌人（默认前 20）',
    '  providers              列出已配置的云模型',
    '  form create <名> <tanks|infantry|vehicles|all> [--force]  建编队（冲突不静默抢占）',
    '  form list / form transfer <ids> <名> / form dissolve <名>',
    '  task new <id> [@编队] <命令>  编译并部署战斗任务（@编队 绑定编队，否则当前全部车辆/步兵）',
    '  task list              任务与运行状态',
    '  task stop <id>         立即撤权停止任务',
    '  task pause <id> / task resume <id>',
    '  produce <目标建筑或单位名>  生产任务（自动计算必要前置闭包，授权仅限闭包内）',
    '  prod                   显示生产状态（电力/队列/可造）',
    '  model <名称>           切换编译用的云模型',
    '  shot                   截图到 .runtime/shots/',
    '  quit                   退出（断开连接，浏览器与对局保留）',
    '  quit hard              退出并关闭常驻浏览器',
  ].join('\n')
}

function parseIds(spec: string, snap: Snapshot | undefined): number[] | undefined {
  if (!snap) return undefined
  if (spec === 'all') return snap.self.filter((u) => u.type === 3 || u.type === 7).map((u) => u.id)
  const ids: number[] = []
  for (const part of spec.split(',')) {
    const range = part.match(/^(\d+)-(\d+)$/)
    if (range) {
      for (let i = Number(range[1]); i <= Number(range[2]); i++) ids.push(i)
    } else if (/^\d+$/.test(part)) {
      ids.push(Number(part))
    } else {
      return undefined
    }
  }
  return ids
}

interface CommandContext {
  browser: Browser
  bridge: WerhdBridge
  page: Page
  runtime: TaskRuntime
  executor: StepExecutor
  formations: FormationRegistry
  providers: Map<string, OpenAICompatibleProvider>
  currentProvider: () => OpenAICompatibleProvider
  /** 任务原始编译输入（同授权修复用）。 */
  compileInputs: Map<string, CompileInput>
  repairCounts: Map<string, number>
}

const TYPE_LABEL: Record<number, string> = { 1: '空军', 2: '建筑', 3: '步兵', 7: '车辆' }

/** 单条命令 → 输出文本；quit 由调用方根据返回值处理。 */
async function handleCommand(line: string, ctx: CommandContext): Promise<string> {
  const [cmd, ...args] = line.split(/\s+/)
  const { bridge, page } = ctx
  switch (cmd) {
    case 'help':
      return usage()
    case 'status': {
      const st = await bridge.state()
      const snap = bridge.latest
      const lines = [JSON.stringify(st, null, 2)]
      lines.push(
        snap
          ? `最新快照: session=${snap.session} seq=${snap.seq} tick=${snap.tick} 单位=${snap.self.length} 资金=${snap.credits}`
          : '尚无快照（未进局或资源未就绪）',
      )
      return lines.join('\n')
    }
    case 'units': {
      const snap = bridge.latest
      if (!snap) return '尚无快照'
      const n = args[0] ? Number(args[0]) : 20
      const lines = snap.self.slice(0, n).map((u) =>
        `  #${u.id} ${u.name} (${TYPE_LABEL[u.type] ?? `type${u.type}`}) (${u.rx},${u.ry}) hp=${u.hitPoints ?? '?'}/${u.maxHitPoints ?? '?'} ${u.isIdle ? 'idle' : 'busy'}`,
      )
      lines.push(`  共 ${snap.self.length} 个单位；可见敌人 ${snap.enemies.length}；地图 ${snap.mapWidth}x${snap.mapHeight}`)
      return lines.join('\n')
    }
    case 'enemy': {
      const snap = bridge.latest
      if (!snap) return '尚无快照'
      const n = args[0] ? Number(args[0]) : 20
      const lines = snap.enemies.slice(0, n).map((u) =>
        `  #${u.id} ${u.name} (${TYPE_LABEL[u.type] ?? `type${u.type}`}) (${u.rx},${u.ry}) hp=${u.hitPoints ?? '?'}/${u.maxHitPoints ?? '?'}`,
      )
      lines.push(`  可见敌人 ${snap.enemies.length} 个`)
      return lines.join('\n')
    }
    case 'providers': {
      const list = [...ctx.providers.values()]
        .map((p) => `  ${p.config.name}: ${p.model} @ ${p.config.baseUrl}`)
      return list.length ? list.join('\n') : '（未配置任何云模型：检查 .env 的 *_API_KEY）'
    }
    case 'model': {
      const name = args[0]
      const p = name ? ctx.providers.get(name) : undefined
      if (!p) return `用法: model <${[...ctx.providers.keys()].join('|')}>`
      ctx.currentProvider = () => p
      return `编译模型切换为 ${p.config.name} (${p.model})`
    }
    case 'form': {
      const sub = args[0]
      const snap = bridge.latest
      if (sub === 'create') {
        const name = args[1]
        const filter = args[2]
        if (!name || !filter) return '用法: form create <名> <tanks|infantry|vehicles|all> [--force]'
        if (!snap) return '尚无快照'
        const force = args.includes('--force')
        const matched = snap.self.filter((u) => {
          if (u.type === 3) return filter === 'infantry' || filter === 'all'
          if (u.type === 7) {
            if (filter === 'vehicles' || filter === 'all') return true
            // tanks：按规则排除矿车/维修车等非战斗车辆（名称启发式，待规则目录化）。
            if (filter === 'tanks') return !/HARV|CMIN|MINR|TRUCK|AMBULANCE/i.test(u.name)
            return false
          }
          return false
        })
        if (!matched.length) return '没有匹配的单位'
        const result = ctx.formations.create(
          name,
          matched.map((u) => u.id),
          { force },
        )
        if (!result.ok) {
          const detail = result.conflicts?.map((c) => `#${c.unit}(在${c.from})`).slice(0, 5).join('，')
          return `建队失败: ${result.reason}${detail ? `；冲突: ${detail}` : ''}`
        }
        return `编队 "${name}" 建立：${result.formation!.memberIds.length} 个单位（原始成员基准同此）`
      }
      if (sub === 'list') {
        const lines = ctx.formations.list().map(
          (f) => `  ${f.id}: 成员 ${f.memberIds.length}/${f.originalMemberIds.length}（原始基准）`,
        )
        return lines.length ? lines.join('\n') : '（无编队）'
      }
      if (sub === 'transfer') {
        const ids = parseIds(args[1] ?? '', snap)
        const to = args[2]
        if (!ids?.length || !to) return '用法: form transfer <ids> <编队名>'
        const r = ctx.formations.transfer(ids, to)
        return r.ok ? `已转编 ${ids.length} 个单位到 "${to}"` : `转编失败: ${r.reason}`
      }
      if (sub === 'dissolve') {
        ctx.formations.dissolve(args[1] ?? '')
        return `编队 ${args[1]} 已解散`
      }
      return '用法: form create|list|transfer|dissolve …'
    }
    case 'prod': {
      const p = bridge.latest?.production
      if (!p) return '尚无生产数据（未进局）'
      const lines = [`电力: ${p.power.drain}/${p.power.total}${p.power.isLowPower ? '（低电）' : ''} 资金: ${Math.floor(bridge.latest!.credits)}`]
      for (const q of p.queues) {
        const items = q.items.map((i) => `${i.name}x${i.quantity}@${Math.floor(i.progress * 100)}%`).join(', ')
        lines.push(`  队列 type${q.type} [${['空闲', '生产中', '暂停', '就绪'][q.status] ?? q.status}] ${items || '空'}`)
      }
      lines.push(`可造(${p.available.length}): ${p.available.slice(0, 40).join(',')}`)
      return lines.join('\n')
    }
    case 'produce': {
      const target = args[0]
      if (!target) return '用法: produce <目标名>（如 produce GAWEAP）'
      const snap = bridge.latest
      if (!snap?.production) return '尚无生产数据（未进局）'
      // 固定程序计算必要前置闭包（模型不参与）。
      const closure = await computePrerequisiteClosure(
        target,
        {
          prerequisites: async (name: string) => {
            const r = (await bridge.rules(name, 2)) as { prerequisite?: string[] } | undefined | null
            return r?.prerequisite
          },
          available: async () => bridge.latest?.production?.available ?? [],
        },
        snap.self,
      )
      if (closure.unknown.length) {
        return `规则查询失败（名称可能无效）: ${closure.unknown.join(',')}；用 prod 查看可造清单`
      }
      const list = [...closure.toBuild, closure.target]
      console.log(`[companion] 必要前置闭包: ${list.join(' → ')}${closure.toBuild.length ? '' : '（已有全部前置）'}`)
      const provider = ctx.currentProvider()
      console.log(`[companion] 编译中：${provider.config.name} …`)
      const input: CompileInput = {
        rawText: `尽快完成生产目标 ${target}`,
        binding: { unitIds: [], production: { target, closure: closure.toBuild } },
        snapshot: snap,
      }
      const outcome = await compileCommand(provider, input, ctx.executor)
      const spec: TaskSpec = {
        id: `prod-${target}-${Date.now() % 10000}`,
        rawText: `生产 ${target}`,
        unitIds: [],
        originalMembers: [],
        allowedProduce: list,
      }
      ctx.compileInputs.set(spec.id, input)
      ctx.runtime.deploy(spec, outcome.code)
      return `生产任务 ${spec.id} 已部署（授权仅限: ${list.join(',')}）`
    }
    case 'task': {
      const sub = args[0]
      if (sub === 'new') {
        const id = args[1]
        const rest = args.slice(2)
        const formationId = rest[0]?.startsWith('@') ? rest[0]!.slice(1) : undefined
        const text = (formationId ? rest.slice(1) : rest).join(' ')
        if (!id || !text) return '用法: task new <id> [@编队] <命令文本>'
        const snap = bridge.latest
        if (!snap) return '尚无快照：请先进入对局'
        let unitIds: number[]
        let originalMembers: number[]
        if (formationId) {
          unitIds = ctx.formations.membersOf(formationId)
          originalMembers = ctx.formations.originalOf(formationId)
          if (!unitIds.length) return `编队 "${formationId}" 不存在或无成员（form list 查看）`
        } else {
          const units = snap.self.filter((u) => u.type === 3 || u.type === 7)
          if (!units.length) return '当前没有可绑定的车辆/步兵单位'
          unitIds = units.map((u) => u.id)
          originalMembers = unitIds
        }
        const provider = ctx.currentProvider()
        console.log(`[companion] 编译中：${provider.config.name} 绑定 ${unitIds.length} 个单位${formationId ? `（编队 ${formationId}）` : ''}…`)
        const input: CompileInput = { rawText: text, binding: { unitIds }, snapshot: snap }
        const outcome = await compileCommand(provider, input, ctx.executor)
        const spec: TaskSpec = { id, rawText: text, unitIds, originalMembers, ...(formationId ? { formationId } : {}) }
        ctx.compileInputs.set(id, input)
        ctx.runtime.deploy(spec, outcome.code)
        const last = outcome.log[outcome.log.length - 1]!
        return `任务 ${id} 已部署（v1，${outcome.attempts} 轮编译，${last.model} ${last.durationMs}ms）`
      }
      if (sub === 'list') {
        const lines: string[] = []
        for (const t of ctx.runtime.tasks.values()) {
          const s = t.stats
          // 编队任务显示动态成员数（转编后授权实时收窄）。
          const memberCount = t.spec.formationId
            ? ctx.formations.membersOf(t.spec.formationId).length
            : t.spec.unitIds.length
          lines.push(
            `  ${t.spec.id} [${t.status}] v${t.script?.version ?? '-'} 「${t.spec.rawText.slice(0, 30)}」 单位=${memberCount}${t.spec.formationId ? `（编队${t.spec.formationId}）` : ''}${t.spec.allowedProduce ? ` 生产=${t.spec.allowedProduce.length}项` : ''} steps=${s.steps} actions=${s.actions} 拒绝=${s.rejected}${s.lastError ? ` 错误=${s.lastError.slice(0, 60)}` : ''}`,
          )
        }
        return lines.length ? lines.join('\n') : '（无任务）'
      }
      if (sub === 'stop') {
        await ctx.runtime.stop(args[1] ?? '')
        return `任务 ${args[1]} 已停止`
      }
      if (sub === 'pause') {
        ctx.runtime.pause(args[1] ?? '')
        return `任务 ${args[1]} 已暂停`
      }
      if (sub === 'resume') {
        ctx.runtime.resume(args[1] ?? '')
        return `任务 ${args[1]} 已恢复`
      }
      return '用法: task new|list|stop|pause|resume …'
    }
    case 'move':
    case 'amove':
    case 'gather': {
      const ids = parseIds(args[0] ?? '', bridge.latest)
      const x = Number(args[1])
      const y = Number(args[2])
      if (!ids?.length || !Number.isFinite(x) || !Number.isFinite(y)) return `用法: ${cmd} <ids|all> <x> <y>`
      const kind = cmd === 'move' ? 'move' : cmd === 'amove' ? 'attackMove' : 'gather'
      const action: ActionRequest = { kind, unitIds: ids, x, y }
      return JSON.stringify(await bridge.submit(action))
    }
    case 'attack': {
      const ids = parseIds(args[0] ?? '', bridge.latest)
      const targetId = Number(args[1])
      if (!ids?.length || !Number.isFinite(targetId)) return '用法: attack <ids|all> <targetId>'
      return JSON.stringify(await bridge.submit({ kind: 'attack', unitIds: ids, targetId }))
    }
    case 'stop': {
      const ids = parseIds(args[0] ?? '', bridge.latest)
      if (!ids?.length) return '用法: stop <ids|all>'
      return JSON.stringify(await bridge.submit({ kind: 'stop', unitIds: ids }))
    }
    case 'shot': {
      mkdirSync(join(ROOT, '.runtime/shots'), { recursive: true })
      const file = join(ROOT, `.runtime/shots/${Date.now()}.png`)
      await page.screenshot({ path: file })
      return `截图: ${file}`
    }
    case 'quit':
      return args[0] === 'hard' ? '__QUIT_HARD__' : '__QUIT__'
    default:
      return `未知命令: ${cmd}\n${usage()}`
  }
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
  const bridge = new WerhdBridge(context)
  await bridge.install()

  // M2/M3：任务运行时（执行器 + 批量提交通道 + 编队注册表 + 同授权修复）。
  const executor = new StepExecutor()
  const formations = new FormationRegistry()
  const compileInputs = new Map<string, CompileInput>()
  const repairCounts = new Map<string, number>()
  const runtime = new TaskRuntime({
    executor,
    formations,
    submit: async (actions) => {
      const results = []
      for (const a of actions) results.push(await bridge.submit(a))
      return results
    },
    onTaskFaulted: (taskId) => {
      const input = compileInputs.get(taskId)
      const count = (repairCounts.get(taskId) ?? 0) + 1
      repairCounts.set(taskId, count)
      if (!input || count > 2) {
        console.log(`[companion] 任务 ${taskId} 不再自动修复（${!input ? '无原始输入' : `已达修复限额(${count - 1})`}）`)
        return
      }
      console.log(`[companion] 任务 ${taskId} 第 ${count} 次同授权修复编译…`)
      void (async () => {
        try {
          const provider = providers.values().next().value
          if (!provider) return
          const out = await compileCommand(provider, input, executor)
          // 保留原 spec（含编队/生产授权），仅替换代码。
          const task = runtime.tasks.get(taskId)
          if (!task) return
          runtime.deploy(task.spec, out.code)
          runtime.resume(taskId)
          console.log(`[companion] 任务 ${taskId} 修复完成并恢复（v${task.script ? task.script.version + 1 : 1}）`)
        } catch (err) {
          console.log(`[companion] 任务 ${taskId} 修复失败: ${String(err).slice(0, 120)}`)
        }
      })()
    },
    log: (msg) => console.log(msg),
  })

  let lastSession = 0
  bridge.onSnapshot((snap) => {
    if (snap.session !== lastSession) {
      lastSession = snap.session
      console.log(`\n[companion] 检测到对局会话 #${snap.session}，快照 tick=${snap.tick}，己方单位 ${snap.self.length}，可见敌人 ${snap.enemies.length}`)
    }
    // 快照驱动任务运行时；异常不阻断桥回调。
    void runtime.onSnapshot(snap).catch((err) => console.error(`[runtime] 快照处理错误: ${String(err)}`))
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
  let currentProvider: OpenAICompatibleProvider | undefined
  const ctx: CommandContext = {
    browser,
    bridge,
    page,
    runtime,
    executor,
    formations,
    providers,
    compileInputs,
    repairCounts,
    currentProvider: () => {
      if (!currentProvider) currentProvider = providers.values().next().value
      if (!currentProvider) throw new Error('没有可用的云模型（检查 .env 的 *_API_KEY）')
      return currentProvider
    },
  }
  let running = true
  const runLine = async (line: string): Promise<string> => {
    const out = await handleCommand(line, ctx)
    if (out === '__QUIT__' || out === '__QUIT_HARD__') {
      hardQuit = out === '__QUIT_HARD__'
      running = false
      return 'bye'
    }
    return out
  }
  let hardQuit = false

  // 命令通道：一行一命令，回显结果（自动化脚本与外部进程用）。
  const cmdServer = createServer((socket) => {
    socket.on('data', async (buf) => {
      for (const raw of buf.toString('utf8').split('\n')) {
        const line = raw.trim()
        if (!line) continue
        try {
          socket.write(`${await runLine(line)}\n`)
        } catch (err) {
          socket.write(`错误: ${String(err)}\n`)
        }
        if (!running) {
          socket.end()
          return
        }
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
    while (running) {
      const line = (await rl.question('ra2c> ')).trim()
      if (!line) continue
      try {
        console.log(await runLine(line))
      } catch (err) {
        console.error(`错误: ${String(err)}`)
      }
    }
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
