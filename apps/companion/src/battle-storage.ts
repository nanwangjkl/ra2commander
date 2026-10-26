import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, fstatSync, ftruncateSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ArchiveEntry { schemaVersion?: 1 | 2; kind: 'event' | 'transcript' | 'compilation' | 'observation' | 'feedback'; at: number; value: unknown }
type Reference = { $ra2cArchive: { hash: string; format: 'text' | 'json' | 'json-string'; prefix?: string; suffix?: string } }
const digest = (kind: string, text: string) => createHash('sha256').update(`${kind}\0${text}`).digest('hex')
export const jsonValue = (value: unknown): unknown => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
export function syncDirectory(path: string): void { if (process.platform === 'win32') return; const fd = openSync(path, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
export function atomicWrite(path: string, text: string, durable = false): void {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const fd = openSync(temp, 'w', 0o600)
    try { writeFileSync(fd, text); if (durable) fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, path)
    if (durable) syncDirectory(dirname(path))
  } finally { if (existsSync(temp)) unlinkSync(temp) }
}

/** 内容对象不可变；读缓存按字节限制，不把提示词和战场快照常驻在记录索引里。 */
export class BattleObjects {
  private readonly folder: string
  private readonly cache = new Map<string, string>()
  private bytes = 0
  private readonly stored = new Set<string>()
  private created = false
  private readonly dirty = new Set<string>()
  constructor(folder: string) { this.folder = join(folder, 'objects') }
  private remember(key: string, text: string): void {
    const bytes = Buffer.byteLength(text)
    if (bytes > 2 * 1024 * 1024) return
    if (this.cache.has(key)) { this.bytes -= Buffer.byteLength(this.cache.get(key)!); this.cache.delete(key) }
    this.cache.set(key, text); this.bytes += bytes
    while (this.bytes > 2 * 1024 * 1024) { const first = this.cache.keys().next().value!; this.bytes -= Buffer.byteLength(this.cache.get(first)!); this.cache.delete(first) }
  }
  private file(hash: string, kind: 'text' | 'json'): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('归档内容引用非法')
    return join(this.folder, `${hash}.${kind === 'text' ? 'txt' : 'json'}`)
  }
  private get(hash: string, kind: 'text' | 'json'): string {
    const key = `${kind}:${hash}`, cached = this.cache.get(key)
    if (cached !== undefined) { this.remember(key, cached); return cached }
    const path = this.file(hash, kind)
    const text = readFileSync(path, 'utf8')
    if (digest(kind, text) !== hash) throw new Error(`归档内容校验失败：${hash}`)
    this.remember(key, text)
    return text
  }
  private put(text: string, format: 'text' | 'json' | 'json-string', decorations: { prefix?: string; suffix?: string } = {}): Reference {
    const kind = format === 'text' ? 'text' : 'json', hash = digest(kind, text), path = this.file(hash, kind)
    const key = `${kind}:${hash}`
    if (!this.stored.has(key)) {
      if (existsSync(path)) this.get(hash, kind)
      else {
        if (!this.created) { mkdirSync(this.folder, { recursive: true }); this.created = true }
        atomicWrite(path, text); this.remember(key, text)
      }
      this.stored.add(key)
      if (this.stored.size > 4096) this.stored.delete(this.stored.values().next().value!)
      this.dirty.add(path)
    }
    return { $ra2cArchive: { hash, format, ...decorations } }
  }
  pack(value: unknown, key = '', depth = 0): unknown {
    if (depth > 128) throw new Error('归档内容嵌套过深')
    if (typeof value === 'string') {
      // 紧凑 JSON 消息可拆出内部的 Skill/代码引用；只有能逐字重建时才采用。
      if ((key === 'content' || key === 'rawResponse' || key === 'text') && /^[\[{]/.test(value)) {
        let parsed: unknown
        try { parsed = JSON.parse(value) } catch { /* 普通文本按原文保存 */ }
        if (parsed !== undefined && JSON.stringify(parsed) === value) return this.put(JSON.stringify(this.pack(parsed, '', depth + 1)), 'json-string')
      }
      const fenced = /^(```(?:js|javascript)\s*\n)([\s\S]*?)(\n```\s*)$/.exec(value)
      if (fenced) {
        const core = fenced[2]!.trim(), leading = fenced[2]!.slice(0, fenced[2]!.indexOf(core)), trailing = fenced[2]!.slice(leading.length + core.length)
        if (core) return this.put(core, 'text', { prefix: fenced[1]! + leading, suffix: trailing + fenced[3]! })
      }
      if (['code', 'instructions', 'content', 'rawResponse'].includes(key) || Buffer.byteLength(value) >= 512) return this.put(value, 'text')
      return value
    }
    if (!value || typeof value !== 'object') return value
    const result = Array.isArray(value) ? value.map(item => this.pack(item, '', depth + 1)) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.pack(item, key, depth + 1)]))
    // 原始 JSON 恰好含保留标记时加一层字面值封装，防止被误读成引用。
    if (!Array.isArray(result) && Object.keys(result).length === 1 && '$ra2cArchive' in result) return { $ra2cArchive: { literal: result } }
    // 静态规格可共用；动态单位、队列与进度留在变化事件里，避免每次观察产生碎文件。
    if (['spec', 'activeSpec', 'skill', 'objective', 'targetRegion', 'placementRegion', 'placement'].includes(key)) {
      const text = JSON.stringify(result)
      if (Buffer.byteLength(text) >= 1024) return this.put(text, 'json')
    }
    return result
  }
  unpack(value: unknown, trail = new Set<string>(), depth = 0): unknown {
    if (depth > 256) throw new Error('归档引用嵌套过深')
    if (!value || typeof value !== 'object') return value
    if (!Array.isArray(value) && Object.keys(value).length === 1 && '$ra2cArchive' in value) {
      const ref = (value as Reference).$ra2cArchive
      if (ref && 'raw' in ref) return structuredClone(ref.raw)
      if (ref && 'literal' in ref) return Object.fromEntries(Object.entries(ref.literal as object).map(([key, item]) => [key, this.unpack(item, trail, depth + 1)]))
      if (!ref || !['text', 'json', 'json-string'].includes(ref.format)) throw new Error('归档引用格式非法')
      const id = `${ref.format}:${ref.hash}`
      if (trail.has(id)) throw new Error('归档内容循环引用')
      const next = new Set([...trail, id]), text = this.get(ref.hash, ref.format === 'text' ? 'text' : 'json')
      if (ref.format === 'text') return `${ref.prefix ?? ''}${text}${ref.suffix ?? ''}`
      const decoded = this.unpack(JSON.parse(text), next, depth + 1)
      return ref.format === 'json-string' ? JSON.stringify(decoded) : decoded
    }
    return Array.isArray(value) ? value.map(item => this.unpack(item, trail, depth + 1)) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.unpack(item, trail, depth + 1)]))
  }
  textPath(text: string): string | undefined {
    const hash = digest('text', text)
    return existsSync(this.file(hash, 'text')) ? `objects/${hash}.txt` : undefined
  }
  sync(): void {
    for (const path of this.dirty) { const fd = openSync(path, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
    if (this.dirty.size) syncDirectory(this.folder)
    this.dirty.clear()
  }
}

/** 流式读旧/新 JSONL，保留损坏末行；中间坏行和缺失引用明确报错。 */
export class BattleJournal {
  readonly objects: BattleObjects
  private pending: string[] = []
  private pendingBytes = 0
  private poisoned: Error | undefined
  private tail: { offset: number; text: string; valid: boolean } | undefined
  private readonly path: string
  constructor(readonly folder: string) { this.path = join(folder, 'events.jsonl'); this.objects = new BattleObjects(folder) }
  *entries(onlyKind?: ArchiveEntry['kind']): Generator<ArchiveEntry> {
    if (!existsSync(this.path)) return
    const fd = openSync(this.path, 'r'), buffer = Buffer.alloc(64 * 1024)
    let rest = Buffer.alloc(0), offset = 0, line = 0
    const parse = (text: string) => {
      // 旧转写导入只需命令索引，不反序列化整局的大量观察。完整读取仍严格检查每行。
      const kind = onlyKind && /\"kind\"\s*:\s*\"([^\"]+)\"/.exec(text.slice(0, 256))?.[1]
      if (kind && kind !== onlyKind) return undefined
      const entry = JSON.parse(text) as ArchiveEntry
      if (![undefined, 1, 2].includes(entry.schemaVersion) || !['event', 'transcript', 'compilation', 'observation', 'feedback'].includes(entry.kind) || !Number.isFinite(entry.at) || !Object.hasOwn(entry, 'value')) throw new Error('记录结构或版本非法')
      return entry
    }
    try {
      for (;;) {
        const size = readSync(fd, buffer)
        if (!size) break
        rest = Buffer.concat([rest, buffer.subarray(0, size)])
        let end: number
        while ((end = rest.indexOf(10)) >= 0) {
          const text = rest.subarray(0, end).toString('utf8'); offset += end + 1; line++
          rest = rest.subarray(end + 1)
          if (!text) continue
          try { const entry = parse(text); if (entry) yield entry } catch (error) { throw new Error(`对局记录损坏：${this.folder} 第 ${line} 行；${String(error)}`) }
        }
      }
      if (rest.length) {
        const text = rest.toString('utf8')
        try { const entry = parse(text); this.tail = { offset: offset + rest.length, text: '', valid: true }; if (entry) yield entry }
        catch { this.tail = { offset, text, valid: false } }
      }
    } finally { closeSync(fd) }
  }
  append(entry: ArchiveEntry): void {
    const text = `${JSON.stringify(entry)}\n`
    this.pending.push(text); this.pendingBytes += Buffer.byteLength(text)
  }
  get full(): boolean { return this.pendingBytes >= 64 * 1024 }
  discard(entry: ArchiveEntry): void {
    const text = `${JSON.stringify(entry)}\n`
    if (this.pending.at(-1) === text) { this.pending.pop(); this.pendingBytes -= Buffer.byteLength(text) }
  }
  flush(durable = false): void {
    if (this.poisoned) throw this.poisoned
    if (!this.pending.length && !existsSync(this.path)) { if (durable) this.objects.sync(); return }
    if (!this.pending.length && !durable) return
    mkdirSync(this.folder, { recursive: true })
    if (this.tail) {
      if (this.tail.valid) appendFileSync(this.path, '\n')
      else { writeFileSync(`${this.path}.incomplete`, this.tail.text, { mode: 0o600 }); truncateSync(this.path, this.tail.offset) }
      this.tail = undefined
    }
    if (durable) {
      this.objects.sync()
      const meta = join(this.folder, 'meta.json')
      if (existsSync(meta)) { const fd = openSync(meta, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
    }
    const fd = openSync(this.path, 'a', 0o600)
    try {
      if (this.pending.length) {
        const offset = fstatSync(fd).size
        try { appendFileSync(fd, this.pending.join('')) }
        catch (error) {
          try { ftruncateSync(fd, offset) }
          catch (repair) { this.poisoned = new Error(`日志写入边界未恢复，需重启后检查：${String(repair)}`) }
          throw this.poisoned ?? error
        }
      }
      this.pending = []; this.pendingBytes = 0
      if (durable) fsyncSync(fd)
    } finally { closeSync(fd) }
    if (durable) { syncDirectory(this.folder); syncDirectory(join(this.folder, '..')) }
  }
}
