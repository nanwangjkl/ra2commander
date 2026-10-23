import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import type { BrowserContext, Frame, Page } from 'playwright'
import { isGameDocument } from '@ra2c/game-werhd'

export const WORKBENCH_PATH = '/commander/'

/** 启动时做最小静态构建；产物放在已忽略的运行目录，不需要开发服务器或整页热更新。 */
export function buildWorkbench(root: string): Record<string, string> {
  const ui = join(root, 'apps/companion/ui')
  const out = join(root, '.runtime/ui')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'workbench.js'), transpileModule(readFileSync(join(ui, 'workbench.ts'), 'utf8'), {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ES2022 },
  }).outputText)
  return { [WORKBENCH_PATH]: join(ui, 'index.html'), [`${WORKBENCH_PATH}index.html`]: join(ui, 'index.html'),
    [`${WORKBENCH_PATH}workbench.css`]: join(ui, 'workbench.css'), [`${WORKBENCH_PATH}workbench.js`]: join(out, 'workbench.js') }
}

export async function openWorkbench(context: BrowserContext, gameUrl: string): Promise<{ page: Page; frame: Frame; reused: boolean; legacy: boolean }> {
  const target = new URL(WORKBENCH_PATH, gameUrl)
  const workbench = context.pages().find(p => {
    try { const u = new URL(p.url()); return u.origin === target.origin && u.pathname === target.pathname } catch { return false }
  })
  const oldGame = context.pages().find(p => isGameDocument(p.url(), gameUrl))
  if (!workbench && oldGame && await oldGame.evaluate(() => Boolean((window as unknown as { werhd?: unknown }).werhd)).catch(() => false)) {
    // 活动旧对局不迁移、不刷新；玩家下次从菜单进入工作台。
    return { page: oldGame, frame: oldGame.mainFrame(), reused: true, legacy: true }
  }
  const page = workbench ?? oldGame ?? context.pages().find(p => p.url() === 'about:blank') ?? await context.newPage()
  if (!workbench) await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  // 清除旧启动器遗留的固定 viewport，让游戏随真实窗口与侧栏尺寸变化。
  const session = await context.newCDPSession(page)
  try { await session.send('Emulation.clearDeviceMetricsOverride') } finally { await session.detach() }
  const element = await page.locator('#ra2c-game').elementHandle({ timeout: 30_000 })
  const frame = await element?.contentFrame()
  if (!frame) throw new Error('工作台游戏 frame 尚未建立')
  await frame.waitForURL(url => isGameDocument(url.href, gameUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 })
  return { page, frame, reused: Boolean(workbench), legacy: false }
}
