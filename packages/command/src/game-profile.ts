import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SnapshotUnit } from '@ra2c/contracts'
import { readGameData, type GameData, type GameDataEntry } from './game-data.ts'

interface Member { name: string; type: number; factions?: string[]; aliases?: string[] }
interface Role {
  id: string
  aliases: string[]
  members: Member[]
  prerequisiteCategories?: string[]
  match?: { type: number; flags?: Record<string, boolean>; excludeFlags?: string[]; positivePower?: boolean; labelIncludes?: string[] }
}
interface Definition {
  id: string; name: string; version: string
  catalogFile?: string
  factions: Array<{ id: string; label: string; anchors: string[] }>
  roles: Role[]
}
export interface RuleFacts {
  label?: string | undefined; power?: number | undefined; category?: string | undefined
  harvester?: boolean | undefined; naval?: boolean | undefined; refinery?: boolean | undefined
  constructionYard?: boolean | undefined; engineer?: boolean | undefined
  isBaseDefense?: boolean | undefined
}
const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string' && !!item.trim())
const FLAGS = ['harvester', 'naval', 'refinery', 'constructionYard', 'engineer', 'isBaseDefense']

/** 只保存当前游戏的目录和角色提示；实时规则由引擎查询提供。 */
export class GameProfile {
  private readonly definition: Definition
  private readonly data?: GameData
  private readonly entriesByName: Map<string, GameDataEntry>
  constructor(definition: Definition, readonly instructions: string, data?: GameData) { this.definition = structuredClone(definition); if (data) this.data = structuredClone(data); this.entriesByName = new Map(this.data?.entries.map(item => [item.name, item]) ?? []) }
  get id() { return this.definition.id }
  get version() { return this.definition.version }
  get name() { return this.definition.name }
  get catalogVersion() { return this.data?.version }
  entries(): GameDataEntry[] { return structuredClone(this.data?.entries ?? []) }
  entry(name: string): GameDataEntry | undefined { const item = this.entriesByName.get(name); return item && structuredClone(item) }
  productionFactories(units: readonly SnapshotUnit[]): Record<string, string[]> {
    const faction = this.inferFaction(units), groups: Record<string, string[]> = {}
    for (const [type, factory] of [[2, 'BuildingType'], [3, 'InfantryType'], [7, 'UnitType'], [1, 'AircraftType']] as const) {
      for (const naval of type === 7 ? [false, true] : [false]) {
        const entries = [...this.entriesByName.values()].filter(item => item.defined && item.type === 2 && item.factory === factory && (type !== 7 || item.naval === naval))
        groups[`PRODUCTION_FACTORY_${type}${naval ? '_NAVAL' : ''}`] = entries.sort((a, b) => Number(this.factionsFor(b.name).includes(faction ?? '')) - Number(this.factionsFor(a.name).includes(faction ?? ''))).map(item => item.name)
      }
    }
    return groups
  }
  country(value?: string): string | undefined { return this.data?.countries.find(country => normalize(country.id) === normalize(value ?? '') || normalize(country.label) === normalize(value ?? ''))?.id }
  private readonly factionCache = new Map<string, string[]>()
  factionsFor(name: string): string[] {
    const visit = (name: string, path: Set<string>): string[] => {
      const cached = this.factionCache.get(name)
      if (cached) return cached
      const member = this.member(name)
      if (member?.factions?.length) return member.factions
      if (path.has(name)) return []
      const next = new Set([...path, name]), item = this.entriesByName.get(name)
      const anchor = this.definition.factions.filter(faction => faction.anchors.includes(name)).map(faction => faction.id)
      if (anchor.length) return anchor
      const constraints = (item?.prerequisite ?? []).map(dep => [...new Set((this.data?.categories[dep.toUpperCase()] ?? [dep]).flatMap(concrete => visit(concrete, next)))]).filter(set => set.length)
      let result = constraints.length ? constraints.reduce((left, right) => left.filter(faction => right.includes(faction))) : []
      if (!constraints.length && item?.owner.length) result = this.definition.factions.filter(faction => faction.anchors.some(anchor => this.entriesByName.get(anchor)?.owner.some(country => item.owner.includes(country)))).map(faction => faction.id)
      this.factionCache.set(name, result)
      return result
    }
    return [...visit(name, new Set())]
  }
  limitation(name: string, country?: string, techLevel?: number, liveTechLevel?: number): string | undefined {
    const item = this.entriesByName.get(name)
    if (!item) return undefined
    if (!item.defined || (liveTechLevel ?? item.techLevel) < 0) return `${item.label}不能直接生产，需已有、展开或取得该设施`
    if (techLevel !== undefined && item.techLevel > techLevel) return `${item.label}需要科技等级${item.techLevel}，本局为${techLevel}`
    const house = this.country(country)
    if (!house) return undefined
    if (item.requiredHouses.length && !item.requiredHouses.includes(house)) return `${item.label}限定国家：${item.requiredHouses.map(id => this.data?.countries.find(country => country.id === id)?.label ?? id).join('、')}`
    if (item.forbiddenHouses.includes(house)) return `${item.label}不适用于当前国家${country}`
    if (item.owner.length && !item.owner.includes(house)) return `${item.label}不属于当前国家的生产项目`
    return undefined
  }
  factions() { return structuredClone(this.definition.factions) }
  roles() { return structuredClone(this.definition.roles) }
  members(): Member[] { return [...new Map(this.definition.roles.flatMap(role => role.members).map(member => [member.name, structuredClone(member)])).values()] }
  member(name: string): Member | undefined {
    const member = this.definition.roles.flatMap(role => role.members).find(member => member.name.toLowerCase() === name.toLowerCase())
    return member ? structuredClone(member) : undefined
  }
  inferFaction(units: readonly SnapshotUnit[]): string | undefined {
    return this.definition.factions.map(faction => ({ id: faction.id, score: units.reduce((score, unit) => score + (faction.anchors.includes(unit.name) ? unit.type === 2 ? 2 : 1 : 0), 0) }))
      .filter(item => item.score > 0).sort((a, b) => b.score - a.score)[0]?.id
  }
  roleForAlias(alias: string): string | undefined {
    const value = normalize(alias)
    const find = (name: string) => this.definition.roles.find(role => role.id.toLowerCase() === name || [...role.aliases, ...(role.prerequisiteCategories ?? [])].some(alias => normalize(alias) === name))?.id
    return find(value) ?? find(value.replace(/^(?:所有|全部|全体)(?:的)?/, ''))
  }
  rolesFor(name: string, type: number, facts: RuleFacts = {}): string[] {
    return this.definition.roles.filter(role => {
      const member = role.members.find(member => member.name === name && member.type === type)
      const match = role.match
      if (match?.excludeFlags?.some(flag => facts[flag as keyof RuleFacts] === true)) return false
      if (match?.flags && Object.entries(match.flags).some(([flag, expected]) => facts[flag as keyof RuleFacts] !== undefined && facts[flag as keyof RuleFacts] !== expected)) return false
      if (match?.positivePower && facts.power !== undefined && facts.power <= 0) return false
      if (member) return true
      if (!match || type !== match.type) return false
      const predicates = [
        ...(match.flags ? [Object.entries(match.flags).every(([flag, value]) => facts[flag as keyof RuleFacts] === value)] : []),
        ...(match.positivePower ? [(facts.power ?? 0) > 0] : []),
        ...(match.labelIncludes ? [match.labelIncludes.some(part => normalize(facts.label ?? '').includes(normalize(part)))] : []),
      ]
      return predicates.every(Boolean)
    }).map(role => role.id)
  }
  memberAliases(name: string): string[] { return this.definition.roles.flatMap(role => role.members.filter(member => member.name === name).flatMap(member => member.aliases ?? [])) }
  categories(units: readonly SnapshotUnit[]): Record<string, string[]> {
    const faction = this.inferFaction(units)
    const declared = Object.fromEntries(this.definition.roles.flatMap(role => (role.prerequisiteCategories ?? []).map(category => [category.toUpperCase(), role.members.map(member => member.name)])))
    const categories = { ...this.data?.categories, ...declared }
    return Object.fromEntries(Object.entries(categories).map(([category, names]) => [category, [...new Set([...names, ...(this.data?.categories[category] ?? [])])].sort((a, b) => Number(this.factionsFor(b).includes(faction ?? '')) - Number(this.factionsFor(a).includes(faction ?? '')))]))
  }
}

export function readGameProfile(file = new URL('../../../prompts/games/current-mod.md', import.meta.url)): { profile: GameProfile; source: string; catalogSource: string } {
  const location = fileURLToPath(file)
  try {
    const source = readFileSync(file, 'utf8').trim()
    const blocks = [...source.matchAll(/^```game\s*\n([\s\S]*?)^```\s*$/gm)]
    if (blocks.length !== 1) throw new Error('需要一个 game JSON 块')
    const value = JSON.parse(blocks[0]![1]!) as Definition
    if (!value || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !value.name || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version) || !Array.isArray(value.factions) || !value.factions.length || !Array.isArray(value.roles) || !value.roles.length) throw new Error('游戏元信息不完整')
    const factions = new Set<string>(), roles = new Set<string>(), categories = new Set<string>()
    for (const faction of value.factions) {
      if (typeof faction?.id !== 'string' || !faction.id || factions.has(faction.id) || typeof faction.label !== 'string' || !strings(faction.anchors) || !faction.anchors.length) throw new Error('阵营声明非法或重复')
      factions.add(faction.id)
    }
    for (const role of value.roles) {
      if (typeof role?.id !== 'string' || !role.id || roles.has(role.id) || !strings(role.aliases) || !Array.isArray(role.members) || !role.members.length && !role.match) throw new Error('角色声明非法或重复')
      roles.add(role.id)
      const names = new Set<string>()
      for (const member of role.members) {
        if (typeof member?.name !== 'string' || !/^[A-Za-z0-9_]+$/.test(member.name) || names.has(member.name) || ![1, 2, 3, 7].includes(member.type) || (member.factions !== undefined && (!strings(member.factions) || member.factions.some(id => !factions.has(id)))) || (member.aliases !== undefined && !strings(member.aliases))) throw new Error(`角色 ${role.id} 的候选声明非法`)
        names.add(member.name)
      }
      if (role.prerequisiteCategories !== undefined && !strings(role.prerequisiteCategories)) throw new Error(`角色 ${role.id} 的前置类别非法`)
      for (const category of role.prerequisiteCategories ?? []) {
        if (categories.has(category.toUpperCase())) throw new Error(`前置类别重复：${category}`)
        categories.add(category.toUpperCase())
      }
      const match = role.match
      if (match && (![1, 2, 3, 7].includes(match.type) || (match.flags && Object.entries(match.flags).some(([flag, value]) => !FLAGS.includes(flag) || typeof value !== 'boolean')) || (match.excludeFlags && (!strings(match.excludeFlags) || match.excludeFlags.some(flag => !FLAGS.includes(flag)))) || (match.positivePower !== undefined && typeof match.positivePower !== 'boolean') || (match.labelIncludes && !strings(match.labelIncludes)))) throw new Error(`角色 ${role.id} 的规则匹配非法`)
    }
    for (const required of ['constructionYard', 'powerPlant', 'tank']) if (!roles.has(required)) throw new Error(`缺少核心角色：${required}`)
    const instructions = source.replace(blocks[0]![0], '').trim()
    if (!instructions) throw new Error('缺少游戏适用及规则说明')
    if (value.catalogFile !== undefined && (typeof value.catalogFile !== 'string' || !/^catalogs\/[a-z0-9-]+\.json$/.test(value.catalogFile))) throw new Error('完整目录文件路径非法')
    const catalog = value.catalogFile ? readGameData(new URL(value.catalogFile, file)) : undefined
    if (catalog && catalog.data.gameId !== value.id) throw new Error('完整目录与游戏 ID 不符')
    return { profile: new GameProfile(value, instructions, catalog?.data), source, catalogSource: catalog?.source ?? '' }
  } catch (error) { throw new Error(`游戏目录错误 ${location}：${error instanceof Error ? error.message : String(error)}`) }
}
