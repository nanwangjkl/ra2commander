import type { BrowserContext } from 'playwright'

/**
 * 游戏资源 CDN 对本地 origin 不返回 CORS 头（manifest.json 等 cors 模式请求被浏览器拦截），
 * 官方站点域名在白名单内而本地伺服源不在。此代理把相关域名的请求改由 Node 侧转发
 * （Node fetch 不受浏览器 CORS 约束），并在响应上补 access-control-allow-origin。
 * 资源本体仍来自官方 CDN，并照常进入浏览器持久缓存（persistent profile 下仅下载一次）。
 */
const CDN_HOST_PATTERN =
  /https?:\/\/[^/]*(?:wangerhuoda\.cn|bun\.sh\.cn|k0s\.cn|ra2web\.com|ra2web\.github\.io)(?::\d+)?\//

export async function setupCdnProxy(context: BrowserContext): Promise<void> {
  await context.route(CDN_HOST_PATTERN, async (route) => {
    try {
      const response = await route.fetch({ timeout: 120_000 })
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          'access-control-allow-origin': '*',
        },
      })
    } catch {
      // 网络失败时按原样放行，让页面看到真实错误。
      await route.continue().catch(() => {})
    }
  })
}
