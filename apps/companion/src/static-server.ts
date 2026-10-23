import { execSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { extname, join, normalize, resolve, sep } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mix': 'application/octet-stream',
  '.7z': 'application/x-7z-compressed',
}

export interface StaticServerOptions {
  /** 游戏站点根目录。 */
  root: string
  /** 额外的 URL 路径 → 本机文件映射（如 /pack.7z → 资源包）。 */
  extraFiles?: Record<string, string>
  /** 返回 true 表示请求已处理；用于工作台的小型只读接口。 */
  handleRequest?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean | Promise<boolean>
  port?: number
  host?: string
  /**
   * 证书目录；提供时启用 https（自签，Playwright 侧配 ignoreHTTPSErrors）。
   * 游戏的 CDN/资源地址大量使用协议相对 URL，http 源会因 CORS 失败，必须 https。
   */
  tlsDir?: string
}

/**
 * 生成本机自签证书（若不存在）。游戏站点的资源 CDN 使用协议相对 URL，
 * 只有 https 源才能正常访问（参考实现与 CORS 行为见 doc/architecture/game-api.md）。
 */
function ensureSelfSignedCert(tlsDir: string): { key: string; cert: string } {
  mkdirSync(tlsDir, { recursive: true })
  const key = join(tlsDir, 'key.pem')
  const cert = join(tlsDir, 'cert.pem')
  if (!existsSync(key) || !existsSync(cert)) {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout ${key} -out ${cert} -days 3650 -nodes ` +
        `-subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"`,
      { stdio: 'pipe' },
    )
  }
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') }
}

/** 本地静态伺服游戏站点；不负责游戏逻辑，只保证文件可被浏览器加载。 */
export function startStaticServer(opts: StaticServerOptions): Promise<Server & { url: string }> {
  const root = resolve(opts.root)
  const port = opts.port ?? 8787
  const host = opts.host ?? '127.0.0.1'

  const handler = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    try {
      if (await opts.handleRequest?.(req, res)) return
      const urlPath = decodeURIComponent(new URL(req.url ?? '/', `http://${host}`).pathname)
      const extra = opts.extraFiles?.[urlPath]
      const relPath = normalize(urlPath).replace(/^([/\\.])+/, '')
      let filePath = extra
        ? resolve(extra)
        : join(root, relPath === '' ? 'index.html' : relPath)
      if (!extra && existsSync(filePath) && statSync(filePath).isDirectory()) {
        filePath = join(filePath, 'index.html')
      }
      const insideRoot = extra !== undefined || filePath === root || filePath.startsWith(root + sep)
      if (!insideRoot || !existsSync(filePath) || !statSync(filePath).isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      res.writeHead(200, {
        'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      })
      createReadStream(filePath).pipe(res)
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`server error: ${String(err)}`)
    }
  }

  const server = opts.tlsDir
    ? createHttpsServer(ensureSelfSignedCert(opts.tlsDir), handler)
    : createHttpServer(handler)
  const scheme = opts.tlsDir ? 'https' : 'http'

  return new Promise((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      resolveServer(Object.assign(server, { url: `${scheme}://${host}:${port}/` }))
    })
  })
}
