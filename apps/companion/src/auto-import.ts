import type { Page } from 'playwright'

/** 启动阶段已知对话框：出现即点击对应按钮（音频授权、资源恢复、显卡提示等一次性确认）。 */
const STARTUP_DIALOG_BUTTONS: Array<{ match: RegExp; button: string }> = [
  // 游戏资源下载失败恢复框：选 CDN（经 setupCdnProxy 的 Node 转发，无 CORS 问题）。
  { match: /游戏资源需要修复|游戏资源下载失败/, button: '使用 CDN 资源' },
  // 浏览器自动播放策略的音频授权提示。
  { match: /播放音频/, button: '确定' },
  // 无专用 GPU / headless 环境的画质提示。
  { match: /不受支持的图形卡/, button: '忽略' },
]

/**
 * 启动陪跑：在玩家手动操作前自动处理一次性启动对话框。
 * 每轮先读正文，命中已知对话框就点按钮；主菜单（canvas 出现且无对话框文字）即结束。
 * 返回处理过的对话框列表。
 */
export async function dismissStartupDialogs(
  page: Page,
  { timeoutMs = 300_000, log = console.log }: { timeoutMs?: number; log?: (msg: string) => void } = {},
): Promise<string[]> {
  const handled: string[] = []
  const deadline = Date.now() + timeoutMs
  const canvas = page.locator('canvas').first()

  while (Date.now() < deadline) {
    const text = (await page
      .evaluate(`(document.body.innerText || '')`)
      .catch(() => '')) as string
    const rule = STARTUP_DIALOG_BUTTONS.find((r) => r.match.test(text))
    if (rule) {
      const btn = page.locator('button', { hasText: rule.button })
      if (await btn.isVisible().catch(() => false)) {
        await btn.click()
        handled.push(`${rule.button}（${rule.match.source}）`)
        log(`[companion] 已处理启动对话框: ${rule.button}`)
        await page.waitForTimeout(3000)
        continue
      }
    }
    // 主菜单判定：canvas 已渲染且不再有已知对话框文案。
    if ((await canvas.isVisible().catch(() => false)) && !rule) {
      if (/主选单|单机模式|联机大厅/.test(text)) break
    }
    await page.waitForTimeout(2000)
  }
  return handled
}
