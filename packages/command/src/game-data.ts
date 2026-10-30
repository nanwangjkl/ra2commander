import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export interface GameDataEntry {
  name: string; type: number; defined: boolean; label: string; englishName: string; uiName: string
  prerequisite: string[]; prerequisiteOverride: string[]; owner: string[]; requiredHouses: string[]; forbiddenHouses: string[]
  techLevel: number; power: number; factory: string; buildCat: string
  deploysInto?: string; undeploysInto?: string
  deployer?: boolean; undeployDelay?: number
  harvester: boolean; naval: boolean; refinery: boolean; constructionYard: boolean; engineer: boolean
  foundation?: { width: number; height: number }
  crusher?: boolean; crushable?: boolean
}
export interface GameData {
  schemaVersion: 1; gameId: string; version: string
  sources: Array<{ file: string; sha256: string }>
  categories: Record<string, string[]>
  countries: Array<{ id: string; label: string; side: string }>
  entries: GameDataEntry[]
}

/** INI 重复节及键按后出现值覆盖，与资源覆盖方式一致。 */
export function parseRulesIni(source: string): Map<string, Record<string, string>> {
  const sections = new Map<string, Record<string, string>>()
  let section: Record<string, string> | undefined
  for (const raw of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.split(';')[0]!.trim()
    const header = line.match(/^\[([^\]]+)\]$/)
    if (header) { const name = header[1]!.toUpperCase(); section = sections.get(name) ?? {}; sections.set(name, section); continue }
    const equal = line.indexOf('=')
    if (section && equal > 0) section[line.slice(0, equal).trim().toUpperCase()] = line.slice(equal + 1).trim()
  }
  return sections
}

/** CSF 标签是 ASCII，文本为逐字节取反的 UTF-16LE；支持带附加字符串的 WRTS。 */
export function parseCsf(data: Buffer): Map<string, string> {
  if (data.length < 24 || data.toString('ascii', 0, 4) !== ' FSC') throw new Error('CSF 文件头非法')
  const labels = data.readUInt32LE(8), result = new Map<string, string>()
  let offset = 24
  const u32 = () => { if (offset + 4 > data.length) throw new Error('CSF 长度不足'); const n = data.readUInt32LE(offset); offset += 4; return n }
  const bytes = (n: number) => { if (n < 0 || offset + n > data.length) throw new Error('CSF 字符串越界'); const value = data.subarray(offset, offset + n); offset += n; return value }
  for (let i = 0; i < labels; i++) {
    if (bytes(4).toString('ascii') !== ' LBL') throw new Error('CSF 标签标记非法')
    const count = u32(), key = bytes(u32()).toString('ascii').toUpperCase()
    for (let j = 0; j < count; j++) {
      const tag = bytes(4).toString('ascii')
      if (![' RTS', 'WRTS'].includes(tag)) throw new Error('CSF 文本标记非法')
      const encoded = bytes(u32() * 2), text = Buffer.from(encoded.map(value => value ^ 255)).toString('utf16le')
      if (j === 0) result.set(key, text)
      if (tag === 'WRTS') bytes(u32())
    }
  }
  return result
}

export function importGameData(rules: Buffer, strings: Buffer, gameId: string, art?: Buffer): GameData {
  const ini = parseRulesIni(rules.toString('utf8')), csf = parseCsf(strings)
  const artIni = art && parseRulesIni(art.toString('utf8'))
  const list = (value = '') => value.split(',').map(item => item.trim()).filter(Boolean)
  const entries: GameDataEntry[] = []
  const seen = new Set<string>()
  for (const [section, type] of [['BuildingTypes', 2], ['InfantryTypes', 3], ['VehicleTypes', 7], ['AircraftTypes', 1]] as const) {
    for (const name of Object.values(ini.get(section.toUpperCase()) ?? {})) {
      if (!/^[A-Za-z0-9_]+$/.test(name) || seen.has(name)) continue
      const definition = ini.get(name.toUpperCase()), rule = definition ?? {}
      seen.add(name)
      const flag = (key: string) => /^(yes|true|1)$/i.test(rule[key] ?? '')
      const numeric = (key: string, fallback: number) => rule[key] === undefined ? fallback : Number(rule[key])
      const size = type === 2 && artIni?.get((rule.IMAGE || name).toUpperCase())?.FOUNDATION?.match(/^(\d+)x(\d+)$/i)
      const foundation = size && Number(size[1]) > 0 && Number(size[2]) > 0 ? { width: Number(size[1]), height: Number(size[2]) } : undefined
      entries.push({ name, type, defined: !!definition, label: csf.get(rule.UINAME?.toUpperCase() ?? '') || rule.NAME || name, englishName: rule.NAME || name, uiName: rule.UINAME ?? '',
        prerequisite: list(rule.PREREQUISITE), prerequisiteOverride: list(rule.PREREQUISITEOVERRIDE), owner: list(rule.OWNER), requiredHouses: list(rule.REQUIREDHOUSES), forbiddenHouses: list(rule.FORBIDDENHOUSES),
        techLevel: numeric('TECHLEVEL', -1), power: numeric('POWER', 0), factory: rule.FACTORY ?? '', buildCat: rule.BUILDCAT ?? '',
        ...(rule.DEPLOYSINTO ? { deploysInto: rule.DEPLOYSINTO } : {}), ...(rule.UNDEPLOYSINTO ? { undeploysInto: rule.UNDEPLOYSINTO } : {}),
        ...(flag('DEPLOYER') ? { deployer: true, undeployDelay: numeric('UNDEPLOYDELAY', 0) } : {}),
        crusher: flag('CRUSHER'), crushable: rule.CRUSHABLE === undefined ? type === 3 : flag('CRUSHABLE'),
        harvester: flag('HARVESTER'), naval: flag('NAVAL'), refinery: flag('REFINERY'), constructionYard: flag('CONSTRUCTIONYARD'), engineer: flag('ENGINEER'), ...(foundation ? { foundation } : {}) })
    }
  }
  const general = ini.get('GENERAL') ?? {}, categories: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(general)) if (/^PREREQUISITE(POWER|FACTORY|BARRACKS|RADAR|TECH|PROC)$/.test(key)) categories[key.slice('PREREQUISITE'.length)] = list(value)
  const countries = Object.values(ini.get('COUNTRIES') ?? {}).map(id => { const country = ini.get(id.toUpperCase()) ?? {}; return { id, label: csf.get(country.UINAME?.toUpperCase() ?? '') || country.NAME || id, side: country.SIDE ?? '' } })
  const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')
  return { schemaVersion: 1, gameId, version: `sha256:${hash(Buffer.concat([rules, strings, ...(art ? [art] : [])])).slice(0, 16)}`, sources: [{ file: 'rules.ini', sha256: hash(rules) }, { file: 'ra2.csf', sha256: hash(strings) }, ...(art ? [{ file: 'art.ini', sha256: hash(art) }] : [])], categories, countries, entries }
}

export function validateGameData(data: GameData): void {
  if (data?.schemaVersion !== 1 || !data.gameId || !data.version || !Array.isArray(data.entries) || !data.entries.length || !data.categories || !Array.isArray(data.countries)) throw new Error('游戏目录数据结构非法')
  const names = new Set<string>()
  for (const item of data.entries) {
    if (!item || !/^[A-Za-z0-9_]+$/.test(item.name) || names.has(item.name) || ![1, 2, 3, 7].includes(item.type) || !item.label || !Number.isFinite(item.techLevel) || !Number.isFinite(item.power) || [item.prerequisite, item.prerequisiteOverride, item.owner, item.requiredHouses, item.forbiddenHouses].some(list => !Array.isArray(list) || list.some(value => typeof value !== 'string'))) throw new Error(`游戏目录条目非法：${item?.name}`)
    names.add(item.name)
    if (item.crusher !== undefined && typeof item.crusher !== 'boolean' || item.crushable !== undefined && typeof item.crushable !== 'boolean') throw new Error(`碾压规则非法：${item.name}`)
    if (item.deployer !== undefined && typeof item.deployer !== 'boolean' || item.undeployDelay !== undefined && (!Number.isFinite(item.undeployDelay) || item.undeployDelay < 0)) throw new Error(`单位部署规则非法：${item.name}`)
    if (item.foundation && (item.type !== 2 || ![item.foundation.width, item.foundation.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 32))) throw new Error(`建筑占地非法：${item.name}`)
  }
  for (const [category, entries] of Object.entries(data.categories)) if (!entries.length || entries.some(name => !names.has(name))) throw new Error(`前置类别引用不存在：${category}`)
  for (const item of data.entries) for (const name of item.prerequisite) if (!names.has(name) && !data.categories[name.toUpperCase()]) throw new Error(`前置引用不存在：${item.name} → ${name}`)
}

export function readGameData(file: URL): { data: GameData; source: string } {
  const source = readFileSync(file, 'utf8'), data = JSON.parse(source) as GameData
  validateGameData(data)
  return { data, source }
}
