import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ZipFile } from 'yazl'
import { openPromise } from 'yauzl'
import { compactBattle, hashEntry, logicalEntries } from './battle-export.ts'
import { BattleJournal } from './battle-storage.ts'
import { BattleRecords } from './battle-records.ts'

const validId = (id: string) => /^battle-[a-f0-9]{24}$/.test(id)
export function battleSourceVersion(root: string, id: string): string {
  if (!validId(id)) throw new Error('对局 ID 非法')
  return JSON.stringify(['meta.json', 'events.jsonl'].map(name => {
    const s = statSync(join(root, '.runtime/battles', id, name)); return [s.ino, s.size, s.mtimeMs]
  }))
}
async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
interface Manifest {
  format: 'ra2c-battle-zip'; version: 1; id: string; exportedAt: number
  exporter: { version: string; node: string }
  entries: number; logicalHash: string; files: Record<string, string>
  recorded: { promptVersions: string[]; game: unknown[]; note: string }
}

/** 文件白名单和逻辑校验复用原导出；同步紧凑转换须在导出 worker 内调用。 */
export async function exportBattleZip(root: string, id: string, output: string) {
  if (existsSync(output)) throw new Error('导出文件已存在')
  mkdirSync(dirname(output), { recursive: true })
  const sourceVersion = battleSourceVersion(root, id), scratch = mkdtempSync(join(dirname(output), '.ra2c-zip-')), temporary = `${output}.${randomUUID()}.tmp`
  try {
    const result = compactBattle(root, id, scratch), files: Record<string, string> = {}
    const names = ['meta.json', 'events.jsonl', 'summary.md', ...(existsSync(join(result.folder, 'objects')) ? readdirSync(join(result.folder, 'objects')).sort().map(name => `objects/${name}`) : [])]
    for (const name of names) files[name] = await fileHash(join(result.folder, name))
    const prompts = new Set<string>(), games = new Map<string, unknown>()
    for (const entry of logicalEntries(new BattleJournal(result.folder))) if (entry.kind === 'transcript') {
      const t = entry.value as { promptVersions?: { interpret?: string; compile?: Record<string, string> }; messages?: Array<{ role: string; content: string }> }
      for (const v of [t.promptVersions?.interpret, ...Object.values(t.promptVersions?.compile ?? {})]) if (typeof v === 'string') prompts.add(v)
      for (const message of t.messages ?? []) if (message.role === 'user') {
        try {
          const game = JSON.parse(message.content).game
          if (game && typeof game === 'object') {
            const version = Object.fromEntries(['id', 'version', 'catalogVersion'].filter(k => typeof game[k] === 'string').map(k => [k, game[k]]))
            if (Object.keys(version).length) games.set(JSON.stringify(version), version)
          }
        } catch { /* 历史记录未提供结构化版本时保持未知。 */ }
      }
    }
    const manifest: Manifest = { format: 'ra2c-battle-zip', version: 1, id, exportedAt: Date.now(),
      exporter: { version: JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version, node: process.versions.node },
      entries: result.entries, logicalHash: result.logicalHash, files,
      recorded: { promptVersions: [...prompts], game: [...games.values()], note: '仅包含本局实际已采集的信息；未记录的版本、过程与成果无法补回。exporter 为导出时环境。' } }
    writeFileSync(join(result.folder, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
    mkdirSync(dirname(output), { recursive: true })
    const zip = new ZipFile(), stream = zip.outputStream as Readable
    zip.on('error', error => stream.destroy(error))
    const finished = pipeline(stream, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
    for (const name of [...names, 'manifest.json']) zip.addFile(join(result.folder, name), `${id}/${name}`, { compressionLevel: 9 })
    zip.end(); await finished
    const verified = await openBattleZip(temporary, scratch)
    verified.dispose()
    if (sourceVersion !== battleSourceVersion(root, id)) throw new Error('对局记录在导出期间有变化，请重试')
    if (existsSync(output)) throw new Error('导出文件已存在')
    renameSync(temporary, output)
    return { id, entries: result.entries, logicalHash: result.logicalHash, bundleBytes: statSync(output).size }
  } finally { rmSync(scratch, { recursive: true, force: true }); rmSync(temporary, { force: true }) }
}

/** ZIP 只读到隔离临时目录；白名单、总量、文件和逻辑哈希均通过后才可 inspect。 */
export async function openBattleZip(path: string, temporaryParent = tmpdir()) {
  const root = mkdtempSync(join(temporaryParent, 'ra2c-open-zip-')), dispose = () => rmSync(root, { recursive: true, force: true })
  let zip: Awaited<ReturnType<typeof openPromise>> | undefined, id = '', total = 0
  const extracted = new Set<string>()
  try {
    zip = await openPromise(path, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true })
    for await (const entry of zip.eachEntry()) {
      const match = /^(battle-[a-f0-9]{24})\/(manifest\.json|meta\.json|summary\.md|events\.jsonl|objects\/[a-f0-9]{64}\.(?:txt|json))$/.exec(entry.fileName)
      if (!match || id && match[1] !== id || extracted.has(match[2]!)) throw new Error('ZIP 包文件路径、对局标识或重复文件非法')
      id = match[1]!
      if (extracted.size >= 100_000 || total + entry.uncompressedSize > 1024 ** 3 || match[2] === 'manifest.json' && entry.uncompressedSize > 1024 ** 2) throw new Error('ZIP 展开超过允许大小')
      const target = join(root, '.runtime/battles', id, match[2]!)
      mkdirSync(dirname(target), { recursive: true })
      const stream = await zip.openReadStreamPromise(entry)
      await pipeline(stream, new Transform({ transform(chunk: Buffer, _encoding, cb) {
        total += chunk.length
        cb(total > 1024 ** 3 ? new Error('ZIP 展开超过允许大小') : null, chunk)
      } }), createWriteStream(target, { flags: 'wx', mode: 0o600 }))
      extracted.add(match[2]!)
    }
    if (!validId(id) || !extracted.has('manifest.json')) throw new Error('ZIP 提交包缺少清单')
    const folder = join(root, '.runtime/battles', id), manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as Manifest
    if (manifest.format !== 'ra2c-battle-zip' || manifest.version !== 1 || manifest.id !== id || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)
      || !Number.isSafeInteger(manifest.entries) || manifest.entries < 0 || !/^[a-f0-9]{64}$/.test(manifest.logicalHash)) throw new Error('ZIP 清单格式非法')
    const names = Object.keys(manifest.files)
    if (names.length !== extracted.size - 1 || !['meta.json', 'summary.md', 'events.jsonl'].every(name => names.includes(name))) throw new Error('ZIP 文件清单不完整')
    for (const name of names) if (!extracted.has(name) || manifest.files[name] !== await fileHash(join(folder, name))) throw new Error('ZIP 文件校验失败')
    const meta = JSON.parse(readFileSync(join(folder, 'meta.json'), 'utf8'))
    if (meta.id !== id) throw new Error('ZIP 索引与对局不符')
    const logical = createHash('sha256'); let entries = 0
    for (const entry of logicalEntries(new BattleJournal(folder))) { hashEntry(logical, entry); entries++ }
    if (entries !== manifest.entries || logical.digest('hex') !== manifest.logicalHash) throw new Error('ZIP 逻辑内容校验失败')
    return { records: new BattleRecords(root), id, root, dispose }
  } catch (error) { dispose(); throw error }
  finally { zip?.close() }
}
