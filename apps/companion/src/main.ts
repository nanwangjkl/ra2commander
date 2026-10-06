import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { chromium, type Page } from 'playwright'
import type { ActionRequest, Snapshot } from '@ra2c/contracts'
import { setupCdnProxy, WerhdBridge } from '@ra2c/game-werhd'
import { dismissStartupDialogs } from './auto-import.ts'
import { startStaticServer } from './static-server.ts'

const ROOT = resolve(import.meta.dirname, '../..')
const PROFILE_DIR = process.env.RA2C_PROFILE ?? join(ROOT, '.runtime/profile')
const GAME_DIR = process.env.RA2C_GAME_DIR ?? join(homedir(), 'my/code/ra2web.github.io')
const PACK_PATH = process.env.RA2C_PACK ?? join(homedir(), 'Downloads/full-pack.7z')
const PORT = Number(process.env.RA2C_PORT ?? 8787)
/** 命令通道端口：一行一条命令，返回多行结果；供自动化脚本与外部进程使用。 */
const CMD_PORT = Number(process.env.RA2C_CMD_PORT ?? 8790)

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
    '  shot                   截图到 .runtime/shots/',
    '  quit                   退出（关闭浏览器）',
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
  bridge: WerhdBridge
  page: Page
}

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
        `  #${u.id} ${u.name} (${u.type === 2 ? '建筑' : u.type === 3 ? '步兵' : u.type === 7 ? '车辆' : u.type === 1 ? '空军' : `type${u.type}`}) (${u.rx},${u.ry}) hp=${u.hitPoints ?? '?'}/${u.maxHitPoints ?? '?'} ${u.isIdle ? 'idle' : 'busy'}`,
      )
      lines.push(`  共 ${snap.self.length} 个单位；地图 ${snap.mapWidth}x${snap.mapHeight}`)
      return lines.join('\n')
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
      return '__QUIT__'
    default:
      return `未知命令: ${cmd}\n${usage()}`
  }
}

async function main(): Promise<void> {
  const server = await startStaticServer({
    root: GAME_DIR,
    extraFiles: { '/pack.7z': PACK_PATH },
    port: PORT,
    tlsDir: join(ROOT, '.runtime/certs'),
  })
  console.log(`[companion] 游戏站点: ${server.url}  (目录 ${GAME_DIR})`)

  mkdirSync(PROFILE_DIR, { recursive: true })
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    ignoreHTTPSErrors: true,
    viewport: { width: 1152, height: 864 },
  })
  // 游戏 CDN 对本地 origin 无 CORS 头，经 Node 侧转发并补头；资源随后缓存进 profile。
  await setupCdnProxy(context)
  const bridge = new WerhdBridge(context)
  await bridge.install()

  let lastSession = 0
  bridge.onSnapshot((snap) => {
    if (snap.session !== lastSession) {
      lastSession = snap.session
      console.log(`\n[companion] 检测到对局会话 #${snap.session}，快照 tick=${snap.tick}，己方单位 ${snap.self.length}`)
    }
  })

  const page = context.pages()[0] ?? (await context.newPage())
  await page.goto(server.url)
  await dismissStartupDialogs(page)

  const ctx: CommandContext = { bridge, page }
  let running = true
  const runLine = async (line: string): Promise<string> => {
    const out = await handleCommand(line, ctx)
    if (out === '__QUIT__') {
      running = false
      return 'bye'
    }
    return out
  }

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

  await context.close()
  server.close()
  cmdServer.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
