import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import type { BrowserContext, Frame, Page } from 'playwright'
import { isGameDocument } from '@ra2c/game-werhd'

export const WORKBENCH_PATH = '/commander/'
let uiVersion = ''

/** 启动时做最小静态构建；产物放在已忽略的运行目录，不需要开发服务器或整页热更新。 */
export function buildWorkbench(root: string): Record<string, string> {
  const ui = join(root, 'apps/companion/ui')
  const out = join(root, '.runtime/ui')
  mkdirSync(out, { recursive: true })
  const sources = ['workbench', 'workbench-lifecycle', 'workbench-shell', 'sidebar-tabs', 'command-panel', 'command-card', 'command-feedback']
  uiVersion = createHash('sha256').update(['index.html', 'workbench.css', ...sources.map(name => `${name}.ts`)].map(name => readFileSync(join(ui, name), 'utf8')).join('\n')).digest('hex').slice(0, 12)
  const files: Record<string, string> = { [WORKBENCH_PATH]: join(ui, 'index.html'), [`${WORKBENCH_PATH}index.html`]: join(ui, 'index.html'), [`${WORKBENCH_PATH}workbench.css`]: join(ui, 'workbench.css') }
  for (const name of sources) {
    const compiled = transpileModule(readFileSync(join(ui, `${name}.ts`), 'utf8'), {
      compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ES2022 },
    }).outputText.replace(/(['"])(\.\/[^'"]+\.js)\1/g, (_match, quote: string, path: string) => `${quote}${path}?v=${uiVersion}${quote}`)
    writeFileSync(join(out, `${name}.js`), compiled)
    files[`${WORKBENCH_PATH}${name}.js`] = join(out, `${name}.js`)
  }
  return files
}

/** 仅升级工作台模块；并发刷新只允许最新请求挂载，资源失败时旧界面继续工作。 */
export async function refreshCommandPanel(page: Page): Promise<void> {
  await page.evaluate(async version => {
    const previous = window.__ra2cWorkbenchRefresh
    const controller = new AbortController()
    window.__ra2cWorkbenchRefresh = controller
    previous?.abort()
    try {
      const module = await import(`/commander/workbench-lifecycle.js?v=${version}`) as { refreshWorkbench: (version: string, signal: AbortSignal) => Promise<void> }
      if (!controller.signal.aborted) await module.refreshWorkbench(version, controller.signal)
    } catch (error) { if (!controller.signal.aborted) throw error }
    finally { if (window.__ra2cWorkbenchRefresh === controller) delete window.__ra2cWorkbenchRefresh }
  }, uiVersion)
}

const isBlankPage = (page: Page): boolean => !page.isClosed() && page.url() === 'about:blank' && page.frames().length === 1

async function isEmptyBlank(page: Page): Promise<boolean> {
  if (!isBlankPage(page)) return false
  return page.evaluate(() => location.href === 'about:blank'
    && !document.head?.childNodes.length && !document.body?.childNodes.length).catch(() => false)
}

/** 只清理启动时已有的空文档；保留后来打开、已经导航或承载其他内容的标签。 */
async function closeStartupBlanks(candidates: Page[], keep: Page): Promise<void> {
  for (const page of candidates) {
    if (page === keep || !await isEmptyBlank(page) || !isBlankPage(page)) continue
    await page.close().catch(() => {})
  }
}

export async function openWorkbench(context: BrowserContext, gameUrl: string): Promise<{ page: Page; frame: Frame; reused: boolean; legacy: boolean }> {
  const target = new URL(WORKBENCH_PATH, gameUrl)
  const pages = context.pages()
  const startupBlanks = pages.filter(page => page.url() === 'about:blank')
  const workbench = pages.find(p => {
    try { const u = new URL(p.url()); return u.origin === target.origin && u.pathname === target.pathname } catch { return false }
  })
  const oldGame = pages.find(p => isGameDocument(p.url(), gameUrl))
  if (!workbench && oldGame && await oldGame.evaluate(() => Boolean((window as unknown as { werhd?: unknown }).werhd)).catch(() => false)) {
    // 活动旧对局不迁移、不刷新；玩家下次从菜单进入工作台。
    await closeStartupBlanks(startupBlanks, oldGame)
    return { page: oldGame, frame: oldGame.mainFrame(), reused: true, legacy: true }
  }
  let page = workbench ?? oldGame
  if (!page) {
    for (const candidate of startupBlanks) if (await isEmptyBlank(candidate) && isBlankPage(candidate)) { page = candidate; break }
    page ??= await context.newPage()
  }
  if (!workbench) await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  // 清除旧启动器遗留的固定 viewport，让游戏随真实窗口与侧栏尺寸变化。
  const session = await context.newCDPSession(page)
  try { await session.send('Emulation.clearDeviceMetricsOverride') } finally { await session.detach() }
  const element = await page.locator('#ra2c-game').elementHandle({ timeout: 30_000 })
  const frame = await element?.contentFrame()
  if (!frame) throw new Error('工作台游戏 frame 尚未建立')
  await frame.waitForURL(url => isGameDocument(url.href, gameUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await closeStartupBlanks(startupBlanks, page)
  return { page, frame, reused: Boolean(workbench), legacy: false }
}
