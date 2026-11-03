import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defaultGameResourcesDir, GAME_RESOURCES, GAME_SITE, verifyAsset, verifyGameResources, type GameResourceCatalog } from '@ra2c/game-werhd'
import type { BrowserContext } from 'playwright'

/** 只接管游戏资源源地址，原站点、语言、地图、规则与模组设置保持原值。 */
export async function localGameResources(root: string, gameDir: string, options: { required?: boolean; directory?: string; catalog?: GameResourceCatalog } = {}) {
  const configFile = join(gameDir, 'config.json')
  if (!existsSync(configFile)) return undefined // 模拟工作台或无资源配置的静态页面。
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>
  if (!config.gameresBaseUrl && !Array.isArray(config.gameresBaseUrls)) return undefined
  const catalog = options.catalog ?? GAME_RESOURCES
  const directory = resolve(options.directory ?? defaultGameResourcesDir(root, catalog))
  if (!options.required && !options.directory && !existsSync(directory)) return undefined
  const checked = await verifyGameResources(directory, catalog)
  // 来源地址保持稳定，升级资源版本不使浏览器记住的来源失效。
  const prefix = '/ra2c-game-resources/'
  const filePaths = Object.fromEntries(['manifest.json', ...Object.keys(catalog.manifest.checksums)].map(name => [`${prefix}${name}`, join(directory, name)]))
  const iceMap = join(root, 'resources/game/maps', GAME_SITE.iceMap.path)
  const hasMap = existsSync(iceMap)
  if (hasMap || process.env.RA2C_PACKAGED === '1') verifyAsset(iceMap, GAME_SITE.iceMap)
  const clientConfig = (origin: string) => ({ ...config,
    autoLoadGameRes: true, gameresBaseUrl: new URL(prefix, origin).href, gameresBaseUrls: [], p2pCdnEnabled: false,
  })
  return { ...checked, filePaths, config: clientConfig,
    async installMaps(context: BrowserContext): Promise<void> {
      if (!hasMap) return
      // 由游戏原地图加载器请求；命中固定地图时本机提供，其他地图沿用原来源。
      await context.route(/^https?:\/\/[^/]+\/map\/mp32s8\.map(?:\?.*)?$/i, route => route.fulfill({
        path: iceMap, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' },
      }))
    },
    handleRequest(req: IncomingMessage, res: ServerResponse, origin: string): boolean {
      if (new URL(req.url ?? '/', 'https://127.0.0.1').pathname !== '/config.json') return false
      if (!['GET', 'HEAD'].includes(req.method ?? '')) { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return true }
      const content = JSON.stringify(clientConfig(origin))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(content) })
      res.end(req.method === 'HEAD' ? undefined : content)
      return true
    },
  }
}
