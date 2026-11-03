import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const GAME_SITE = createRequire(import.meta.url)('../site-manifest.json') as {
  version: string; downloadBase: string; files: Array<{ path: string; bytes: number; sha256: string }>
  iceMap: { path: string; bytes: number; sha256: string; url: string }
}
export function verifyAsset(file: string, expected: { bytes: number; sha256: string }): void {
  const bytes = readFileSync(file)
  if (bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw new Error(`发行资源校验失败：${file}`)
}
export function verifyGameSite(root: string): void {
  for (const file of GAME_SITE.files) verifyAsset(join(root, 'resources/game-site', file.path), file)
  verifyAsset(join(root, 'resources/game/maps', GAME_SITE.iceMap.path), GAME_SITE.iceMap)
}

/** 显式开发/构建准备；只复制清单中的文件，全部校验后发布。 */
export async function prepareGameSite(root: string, source?: string): Promise<void> {
  const target = join(root, 'resources/game-site')
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true })
    const scratch = mkdtempSync(join(dirname(target), '.site-'))
    try {
      for (const file of GAME_SITE.files) {
        const destination = join(scratch, file.path)
        mkdirSync(dirname(destination), { recursive: true })
        if (source && existsSync(join(source, file.path))) cpSync(join(source, file.path), destination)
        else {
          const response = await fetch(new URL(file.path, GAME_SITE.downloadBase), { signal: AbortSignal.timeout(60_000) })
          if (!response.ok) throw new Error(`站点资源下载失败：${file.path} HTTP ${response.status}`)
          writeFileSync(destination, Buffer.from(await response.arrayBuffer()))
        }
        verifyAsset(destination, file)
      }
      renameSync(scratch, target)
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  }
  const map = join(root, 'resources/game/maps', GAME_SITE.iceMap.path)
  if (!existsSync(map)) {
    const response = await fetch(GAME_SITE.iceMap.url, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`冰天雪地下载失败：HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length !== GAME_SITE.iceMap.bytes || createHash('sha256').update(bytes).digest('hex') !== GAME_SITE.iceMap.sha256) throw new Error('冰天雪地地图正文与清单不一致')
    mkdirSync(dirname(map), { recursive: true }); writeFileSync(map, bytes, { flag: 'wx' })
  }
  verifyGameSite(root)
}
