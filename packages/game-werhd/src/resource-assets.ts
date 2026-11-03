import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface GameResourceCatalog {
  schemaVersion: 1
  id: string
  sources: string[]
  manifest: { version: 2; format: 'mix'; checksums: Record<string, number> }
  pinnedFiles?: Record<string, { bytes: number; sha256: string }>
}
export const GAME_RESOURCES = createRequire(import.meta.url)('../game-resources.json') as GameResourceCatalog
const table = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1
  return value >>> 0
})
const updateCrc = (value: number, bytes: Uint8Array) => {
  for (const byte of bytes) value = table[(value ^ byte) & 255]! ^ value >>> 8
  return value >>> 0
}
function entries(catalog: GameResourceCatalog) {
  if (catalog.schemaVersion !== 1 || !/^[a-z0-9][a-z0-9.-]*$/.test(catalog.id) || catalog.manifest?.version !== 2 || catalog.manifest.format !== 'mix') throw new Error('游戏资源清单格式错误')
  const files = Object.entries(catalog.manifest.checksums)
  if (!files.length || files.some(([name, crc]) => !/^[a-z0-9][a-z0-9_-]*\.(mix|png|mp4|webm)$/.test(name) || !Number.isInteger(crc) || crc < 0 || crc > 0xffffffff)) throw new Error('游戏资源路径或校验值无效')
  if (Object.entries(catalog.pinnedFiles ?? {}).some(([name, file]) => !Object.hasOwn(catalog.manifest.checksums, name) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new Error('游戏资源正文固定值无效')
  return files
}
async function fileCrc(path: string, pinned = false) {
  let crc = 0xffffffff, bytes = 0
  const hash = pinned ? createHash('sha256') : undefined
  for await (const chunk of createReadStream(path)) { bytes += chunk.length; crc = updateCrc(crc, chunk); hash?.update(chunk) }
  return { crc: (crc ^ 0xffffffff) >>> 0, bytes, sha256: hash?.digest('hex') }
}
export function defaultGameResourcesDir(root: string, catalog = GAME_RESOURCES): string { entries(catalog); return join(root, 'resources/game', catalog.id) }

/** 对照固定发行清单检查资源正文；不读取浏览器 profile 或联网。 */
export async function verifyGameResources(folder: string, catalog = GAME_RESOURCES) {
  const files = entries(catalog)
  let manifest: GameResourceCatalog['manifest']
  try { manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) }
  catch { throw new Error(`游戏资源清单缺失或不可读：${folder}；开发环境请运行 pnpm game:resources:install`) }
  if (manifest.version !== 2 || manifest.format !== 'mix' || !manifest.checksums || Object.keys(manifest.checksums).length !== files.length
    || files.some(([name, crc]) => manifest.checksums[name] !== crc)) throw new Error('游戏资源版本与固定清单不一致')
  let bytes = 0
  for (const [name, crc] of files) {
    const pinned = catalog.pinnedFiles?.[name]
    let actual
    try { actual = await fileCrc(join(folder, name), !!pinned) } catch { throw new Error(`游戏资源缺失或不可读：${name}`) }
    if (!actual.bytes || actual.crc !== crc || pinned && (actual.bytes !== pinned.bytes || actual.sha256 !== pinned.sha256)) throw new Error(`游戏资源校验失败：${name}`)
    bytes += actual.bytes
  }
  return { id: catalog.id, folder, files: files.length, bytes }
}

/** 开发/构建时准备已转换资源；全部通过校验后才发布，不在玩家首启时下载。 */
export async function prepareGameResources(root: string, options: { target?: string; catalog?: GameResourceCatalog; download?: typeof fetch; progress?: (message: string) => void } = {}) {
  const catalog = options.catalog ?? GAME_RESOURCES, files = entries(catalog)
  const target = resolve(options.target ?? defaultGameResourcesDir(root, catalog)), report = options.progress ?? (() => {})
  if (existsSync(target)) { const result = await verifyGameResources(target, catalog); report('已有游戏资源校验通过，直接复用'); return result }
  if (!catalog.sources.length || catalog.sources.some(source => new URL(source).protocol !== 'https:')) throw new Error('游戏资源下载地址必须为 HTTPS')
  mkdirSync(dirname(target), { recursive: true })
  const scratch = mkdtempSync(join(dirname(target), '.prepare-'))
  let next = 0, completed = 0, failed: unknown
  try {
    const worker = async () => {
      while (!failed && next < files.length) {
        const [name, expected] = files[next++]!
        const pinned = catalog.pinnedFiles?.[name]
        let problem: unknown
        for (const source of catalog.sources) {
          const path = join(scratch, name)
          try {
            const url = new URL(name, source); url.searchParams.set('v', String(expected))
            const response = await (options.download ?? fetch)(url, { signal: AbortSignal.timeout(120_000) })
            if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
            let crc = 0xffffffff, bytes = 0
            const hash = pinned ? createHash('sha256') : undefined
            await pipeline(Readable.fromWeb(response.body as never), new Transform({ transform(chunk: Buffer, _encoding, callback) {
              bytes += chunk.length
              if (bytes > 1024 * 1024 * 1024) { callback(new Error('单个资源超过 1 GiB 上限')); return }
              crc = updateCrc(crc, chunk); hash?.update(chunk); callback(null, chunk)
            } }), createWriteStream(path, { flags: 'wx' }))
            if (!bytes || ((crc ^ 0xffffffff) >>> 0) !== expected || pinned && (bytes !== pinned.bytes || hash?.digest('hex') !== pinned.sha256)) throw new Error('资源正文与固定清单不一致')
            problem = undefined; report(`游戏资源 ${++completed}/${files.length}：${name}`); break
          } catch (error) { problem = error; rmSync(path, { force: true }); report(`资源源不可用，尝试其他镜像：${name}（${new URL(source).hostname}）`) }
        }
        if (problem) { failed = new Error(`游戏资源准备失败：${name}（${String(problem)}）`); return }
      }
    }
    await Promise.all([worker(), worker(), worker()])
    if (failed) throw failed
    writeFileSync(join(scratch, 'manifest.json'), JSON.stringify(catalog.manifest))
    const checked = await verifyGameResources(scratch, catalog)
    if (existsSync(target)) return await verifyGameResources(target, catalog)
    renameSync(scratch, target)
    return { ...checked, folder: target }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}
