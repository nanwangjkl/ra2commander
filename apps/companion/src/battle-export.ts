import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { BattleRecords } from './battle-records.ts'
import { applyFields, decodeObservation, encodeObservation, fieldDelta } from './battle-codec.ts'
import { BattleJournal, type ArchiveEntry } from './battle-storage.ts'

const validId = (id: string) => /^battle-[a-f0-9]{24}$/.test(id)
const canonicalId = (id: string) => id.replace(/^restored-/, '')
const folderFor = (root: string, id: string) => {
  if (!validId(id)) throw new Error('对局 ID 非法')
  return join(root, '.runtime/battles', id)
}
const bytes = (folder: string): number => readdirSync(folder, { withFileTypes: true }).reduce((total, item) => {
  const path = join(folder, item.name)
  return total + (item.isDirectory() ? bytes(path) : item.isFile() ? statSync(path).size : 0)
}, 0)
const fingerprint = (folder: string) => ['meta.json', 'events.jsonl'].map(name => { const stat = statSync(join(folder, name)); return [stat.ino, stat.size, stat.mtimeMs] })
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value
const hashEntry = (hash: ReturnType<typeof createHash>, entry: ArchiveEntry) => hash.update(JSON.stringify(canonical({ kind: entry.kind, at: entry.at, value: entry.value })) + '\n')

/** 顺序展开 v1/v2/v3；只保留最新观察和每条命令，不把整局展开到内存。 */
export function* logicalEntries(journal: BattleJournal): Generator<ArchiveEntry> {
  let observation: Record<string, unknown> = {}, count = 0
  const transcripts = new Map<string, Record<string, unknown>>()
  for (const entry of journal.entries()) {
    const version = entry.schemaVersion ?? 1
    let value = (version >= 2 && !['event', 'feedback'].includes(entry.kind) ? journal.objects.unpack(entry.value) : entry.value) as Record<string, unknown>
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('归档事件正文非法')
    if (entry.kind === 'transcript') {
      if (typeof value.requestId !== 'string') throw new Error('转写记录缺少命令 ID')
      const id = canonicalId(value.requestId)
      value = version >= 2 ? applyFields(transcripts.get(id) ?? {}, value.patch as Record<string, unknown>, value.removed as string[]) : value
      transcripts.set(id, value)
    }
    if (entry.kind === 'observation') { value = version >= 2 ? decodeObservation(observation, value, count, version) : value; observation = value; count++ }
    yield { ...entry, value }
  }
  if (journal.incompleteTail) throw new Error('归档存在不完整末行，保留原档并停止导出')
}

/** 生成经过逐事件内容校验的紧凑副本；原档始终不改写。 */
export function compactBattle(root: string, id: string, targetRoot: string) {
  const sourceFolder = folderFor(root, id), targetFolder = folderFor(targetRoot, id), original = JSON.stringify(fingerprint(sourceFolder))
  if (existsSync(targetFolder)) throw new Error('紧凑副本目录已存在')
  const meta = JSON.parse(readFileSync(join(sourceFolder, 'meta.json'), 'utf8')) as Record<string, unknown>
  if (meta.id !== id) throw new Error('归档索引与目录不符')
  mkdirSync(targetFolder, { recursive: true })
  const source = new BattleJournal(sourceFolder), target = new BattleJournal(targetFolder), before = createHash('sha256'), after = createHash('sha256')
  const transcripts = new Map<string, Record<string, unknown>>()
  let observation: Record<string, unknown> = {}, count = 0, entries = 0
  const counts: Record<string, number> = {}
  for (const entry of logicalEntries(source)) {
    hashEntry(before, entry); entries++; counts[entry.kind] = (counts[entry.kind] ?? 0) + 1
    const plain = entry.value as Record<string, unknown>
    let value: unknown = plain
    if (!['event', 'feedback'].includes(entry.kind)) {
      const packed = Object.fromEntries(Object.entries(plain).map(([key, value]) => [key, target.objects.pack(value, key)]))
      value = packed
      if (entry.kind === 'transcript') {
        const id = canonicalId(String(plain.requestId))
        value = { requestId: plain.requestId, ...fieldDelta(transcripts.get(id) ?? {}, packed) }; transcripts.set(id, packed)
      }
      if (entry.kind === 'observation') {
        value = encodeObservation(observation, packed, count % 256 === 0, count); observation = packed; count++
      }
    }
    target.append({ schemaVersion: 3, kind: entry.kind, at: entry.at, value })
    if (target.full) target.flush()
  }
  target.flush(true)
  let verified = 0
  for (const entry of logicalEntries(target)) { hashEntry(after, entry); verified++ }
  const logicalHash = before.digest('hex')
  if (verified !== entries || after.digest('hex') !== logicalHash) throw new Error('紧凑归档校验失败，原档未修改')
  if (JSON.stringify(fingerprint(sourceFolder)) !== original) throw new Error('对局记录仍在写入，请结束本局后重试')
  writeFileSync(join(targetFolder, 'meta.json'), JSON.stringify({ ...meta, schemaVersion: 3 }), { mode: 0o600 })
  const records = new BattleRecords(targetRoot)
  try { writeFileSync(join(targetFolder, 'summary.md'), records.summary(id)!, { mode: 0o600 }) } finally { records.close() }
  return { sourceBytes: bytes(sourceFolder), compactBytes: bytes(targetFolder), entries, counts, logicalHash, folder: targetFolder }
}

/** 自包含 JSONL + gzip；只带本局事件、引用正文和索引，不附带运行环境。 */
export async function exportBattle(root: string, id: string, output: string) {
  if (existsSync(output)) throw new Error('导出文件已存在，请指定新路径')
  const scratch = mkdtempSync(join(tmpdir(), 'ra2c-export-')), temporary = `${output}.${randomUUID()}.tmp`
  try {
    const result = compactBattle(root, id, scratch), journal = new BattleJournal(result.folder)
    const hash = createHash('sha256')
    let entries = 0, objects = 0
    function* lines() {
      const line = (value: unknown) => { const text = JSON.stringify(value) + '\n'; hash.update(text); return text }
      yield line({ type: 'header', format: 'ra2c-battle', version: 1, meta: JSON.parse(readFileSync(join(result.folder, 'meta.json'), 'utf8')) })
      for (const entry of journal.entries()) { entries++; yield line({ type: 'entry', entry }) }
      const objectsFolder = join(result.folder, 'objects')
      for (const name of existsSync(objectsFolder) ? readdirSync(objectsFolder).sort() : []) {
        objects++; yield line({ type: 'object', name, content: readFileSync(join(objectsFolder, name), 'utf8') })
      }
      yield JSON.stringify({ type: 'end', entries, objects, sha256: hash.digest('hex'), logicalHash: result.logicalHash }) + '\n'
    }
    mkdirSync(dirname(output), { recursive: true })
    await pipeline(Readable.from(lines()), createGzip({ level: 9 }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
    // 导出包再完整读取一次，确认解压、引用及逐事件内容均可恢复。
    const opened = await openBattleBundle(temporary)
    opened.dispose()
    if (existsSync(output)) throw new Error('导出文件已存在')
    renameSync(temporary, output)
    return { ...result, folder: undefined, output, bundleBytes: statSync(output).size }
  } finally { rmSync(scratch, { recursive: true, force: true }); rmSync(temporary, { force: true }) }
}

/** 只读展开提交包到临时目录，验证结束标记、校验和与所有正文；不恢复游戏任务。 */
export async function openBattleBundle(path: string) {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-bundle-')), dispose = () => rmSync(root, { recursive: true, force: true })
  const hash = createHash('sha256')
  let id = '', journal: BattleJournal | undefined, rest = '', total = 0, entries = 0, objects = 0, ended = false, logicalHash = ''
  const accept = (text: string) => {
    if (ended) throw new Error('提交包结束标记后存在多余内容')
    const row = JSON.parse(text)
    if (row.type === 'end') {
      if (!journal || row.entries !== entries || row.objects !== objects || row.sha256 !== hash.digest('hex') || !/^[a-f0-9]{64}$/.test(row.logicalHash)) throw new Error('提交包校验失败')
      ended = true; logicalHash = row.logicalHash; return
    }
    hash.update(text + '\n')
    if (!journal) {
      if (row.type !== 'header' || row.format !== 'ra2c-battle' || row.version !== 1 || !validId(row.meta?.id)) throw new Error('提交包头格式非法')
      id = row.meta.id
      const folder = folderFor(root, id); mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'meta.json'), JSON.stringify(row.meta), { mode: 0o600 }); journal = new BattleJournal(folder)
    } else if (row.type === 'entry') {
      journal.append(row.entry); entries++; if (journal.full) journal.flush()
    } else if (row.type === 'object') {
      if (typeof row.name !== 'string' || !/^[a-f0-9]{64}\.(txt|json)$/.test(row.name) || typeof row.content !== 'string') throw new Error('提交包正文名称非法')
      const kind = row.name.endsWith('.txt') ? 'text' : 'json'
      if (createHash('sha256').update(`${kind}\0${row.content}`).digest('hex') !== row.name.slice(0, 64)) throw new Error('提交包正文校验失败')
      const folder = join(folderFor(root, id), 'objects'); mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, row.name), row.content, { flag: 'wx', mode: 0o600 }); objects++
    } else throw new Error('提交包记录类型非法')
  }
  try {
    const sink = new Writable({ decodeStrings: false, write(chunk: string, _encoding, callback) {
      try {
        total += Buffer.byteLength(chunk); if (total > 1024 * 1024 * 1024) throw new Error('提交包展开超过 1 GiB')
        rest += chunk
        let end: number
        while ((end = rest.indexOf('\n')) >= 0) { accept(rest.slice(0, end)); rest = rest.slice(end + 1) }
        if (rest.length > 64 * 1024 * 1024) throw new Error('提交包单行过大')
        callback()
      } catch (error) { callback(error as Error) }
    } })
    const gunzip = createGunzip(); gunzip.setEncoding('utf8')
    await pipeline(createReadStream(path), gunzip, sink)
    if (!ended || rest.length || !journal) throw new Error('提交包不完整')
    const saved = journal as BattleJournal; saved.flush()
    const logical = createHash('sha256')
    for (const entry of logicalEntries(saved)) hashEntry(logical, entry)
    if (logical.digest('hex') !== logicalHash) throw new Error('提交包逻辑内容校验失败')
    return { records: new BattleRecords(root), id, root, dispose }
  } catch (error) { dispose(); throw error }
}
