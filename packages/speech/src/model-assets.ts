import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { defaultSpeechModelDir, legacySpeechModelDir, resolveSpeechModelDir, SPEECH_MODEL_MANIFEST, type SpeechModelManifest } from './model.ts'

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function matches(path: string, expected: { bytes: number; sha256: string }): Promise<boolean> {
  return existsSync(path) && statSync(path).isFile() && statSync(path).size === expected.bytes && await hashFile(path) === expected.sha256
}

/** 离线核对资源；许可说明为必需文件，示例音频在有安装时一并检查。 */
export async function verifySpeechModel(folder: string, manifest = SPEECH_MODEL_MANIFEST) {
  let bytes = 0, files = 0
  for (const file of manifest.files) {
    const path = join(folder, file.path)
    if (!file.required && !existsSync(path)) continue
    if (!await matches(path, file)) throw new Error(`语音模型资源缺失或校验失败：${file.path}（${folder}）`)
    bytes += file.bytes; files++
  }
  return { id: manifest.id, folder, files, bytes }
}

interface PrepareOptions {
  target?: string
  progress?: (message: string) => void
  /** 可控下载源用于离线验证，不改变默认官方清单。 */
  download?: typeof fetch
  manifest?: SpeechModelManifest
}

/** 准备固定资源：有效本机目录直接复用，旧默认目录迁移，下载包按内容哈希缓存。 */
export async function prepareSpeechModel(root: string, options: PrepareOptions = {}) {
  root = resolve(root)
  const manifest = options.manifest ?? SPEECH_MODEL_MANIFEST, report = options.progress ?? (() => {})
  const target = options.target ? resolveSpeechModelDir(root, options.target) : defaultSpeechModelDir(root), legacy = legacySpeechModelDir(root)
  if (existsSync(target)) { const result = await verifySpeechModel(target, manifest); report('已有模型校验通过，直接复用'); return { ...result, source: 'existing' as const } }
  mkdirSync(dirname(target), { recursive: true })
  if (target === defaultSpeechModelDir(root) && existsSync(legacy)) {
    await verifySpeechModel(legacy, manifest)
    renameSync(legacy, target)
    report('旧模型校验通过，已移至项目资源目录，无需下载')
    return { id: manifest.id, folder: target, source: 'migrated' as const }
  }
  const cacheDir = join(root, '.runtime/speech/downloads'), archive = join(cacheDir, `${manifest.archive.sha256}.tar.bz2`)
  mkdirSync(cacheDir, { recursive: true })
  if (!await matches(archive, manifest.archive)) {
    const temporary = `${archive}.${randomUUID()}.tmp`
    try {
      report(`下载 ${manifest.name} 模型（约 ${(manifest.archive.bytes / 1_000_000).toFixed(0)} MB）…`)
      const response = await (options.download ?? fetch)(manifest.archive.url, { signal: AbortSignal.timeout(10 * 60_000) })
      if (!response.ok || !response.body) throw new Error(`模型下载失败：HTTP ${response.status}`)
      const hash = createHash('sha256'); let bytes = 0, reported = 0
      await pipeline(Readable.fromWeb(response.body as never), new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        if (bytes > manifest.archive.bytes) { callback(new Error('模型下载大小与清单不符')); return }
        hash.update(chunk)
        if (bytes - reported >= 16 * 1024 * 1024) { reported = bytes; report(`已下载 ${(bytes / 1024 / 1024).toFixed(0)} MB`) }
        callback(null, chunk)
      } }), createWriteStream(temporary, { flags: 'wx' }))
      if (bytes !== manifest.archive.bytes || hash.digest('hex') !== manifest.archive.sha256) throw new Error('模型下载校验失败，请重试')
      renameSync(temporary, archive)
    } finally { rmSync(temporary, { force: true }) }
  } else report('下载缓存校验通过，离线复用')
  const scratch = mkdtempSync(join(dirname(target), '.prepare-'))
  try {
    await promisify(execFile)('tar', ['-xjf', archive, '-C', scratch, ...manifest.files.map(file => `${manifest.archive.directory}/${file.path}`)])
    const extracted = join(scratch, manifest.archive.directory)
    await verifySpeechModel(extracted, manifest)
    if (existsSync(target)) await verifySpeechModel(target, manifest)
    else renameSync(extracted, target)
    return { id: manifest.id, folder: target, source: 'archive' as const }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}
