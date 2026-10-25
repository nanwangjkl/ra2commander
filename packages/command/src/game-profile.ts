import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SnapshotUnit } from '@ra2c/contracts'

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
  factions: Array<{ id: string; label: string; anchors: string[] }>
  roles: Role[]
}
export interface RuleFacts {
  label?: string | undefined; power?: number | undefined; category?: string | undefined
  harvester?: boolean | undefined; naval?: boolean | undefined; refinery?: boolean | undefined
  constructionYard?: boolean | undefined; engineer?: boolean | undefined
}
const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string' && !!item.trim())
const FLAGS = ['harvester', 'naval', 'refinery', 'constructionYard', 'engineer']

/** 只保存当前游戏的目录和角色提示；实时规则由引擎查询提供。 */
export class GameProfile {
  private readonly definition: Definition
  constructor(definition: Definition, readonly instructions: string) { this.definition = structuredClone(definition) }
  get id() { return this.definition.id }
  get version() { return this.definition.version }
  get name() { return this.definition.name }
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
    return this.definition.roles.find(role => role.id.toLowerCase() === normalize(alias) || [...role.aliases, ...(role.prerequisiteCategories ?? [])].some(name => normalize(name) === normalize(alias)))?.id
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
      return predicates.length > 0 && predicates.every(Boolean)
    }).map(role => role.id)
  }
  memberAliases(name: string): string[] { return this.definition.roles.flatMap(role => role.members.filter(member => member.name === name).flatMap(member => member.aliases ?? [])) }
  categories(units: readonly SnapshotUnit[]): Record<string, string[]> {
    const faction = this.inferFaction(units)
    return Object.fromEntries(this.definition.roles.flatMap(role => (role.prerequisiteCategories ?? []).map(category => [category.toUpperCase(), role.members.slice().sort((a, b) => Number(!!b.factions?.includes(faction ?? '')) - Number(!!a.factions?.includes(faction ?? ''))).map(member => member.name)])))
  }
}

export function readGameProfile(file = new URL('../../../prompts/games/current-mod.md', import.meta.url)): { profile: GameProfile; source: string } {
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
      if (typeof role?.id !== 'string' || !role.id || roles.has(role.id) || !strings(role.aliases) || !Array.isArray(role.members) || !role.members.length) throw new Error('角色声明非法或重复')
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
    return { profile: new GameProfile(value, instructions), source }
  } catch (error) { throw new Error(`游戏目录错误 ${location}：${error instanceof Error ? error.message : String(error)}`) }
}
