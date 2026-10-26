import { loadPrompts, type GameProfile, type RuleFacts } from '@ra2c/command'
import type { Snapshot, SnapshotUnit } from '@ra2c/contracts'
import type { CommandContext } from './commands.ts'
import { createRuleLookup } from './game-rules.ts'

export interface CatalogItem extends RuleFacts {
  name: string; type: number; power: number; available: boolean
  deploysInto?: string | undefined
  undeploysInto?: string | undefined
  ammo?: number | undefined
  unsellable?: boolean | undefined
  factions: string[]; roles: string[]; aliases: string[]
  limitation?: string | undefined; techLevel?: number | undefined
}
const normalized = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()

export class GameCatalog {
  readonly items: CatalogItem[]
  readonly faction: string | undefined
  constructor(readonly all: CatalogItem[], snap: Snapshot, readonly profile: GameProfile) {
    this.faction = profile.inferFaction(snap.self)
    const owned = new Set(snap.self.map(unit => unit.name))
    const rank = (item: CatalogItem) => Number(item.available) * 8 + Number(!item.limitation) * 4 + Number(item.factions.includes(this.faction ?? '')) * 2 + Number(owned.has(item.name))
    this.items = all.filter(item => !this.faction || !item.factions.length || item.factions.includes(this.faction) || item.available).sort((a, b) => rank(b) - rank(a))
  }
  resolve(target: string, expected: { type?: number; mobile?: boolean } = {}): CatalogItem | undefined {
    const name = normalized(target)
    // 原生 ID 保留明确选择；中文同名按操作类型和人工角色别名消歧。
    const exact = this.items.find(item => normalized(item.name) === name)
    if (exact) return exact
    const matches = this.all.filter(item => normalized(item.name) === name || normalized(item.label ?? '') === name || item.aliases.some(alias => normalized(alias) === name))
    const names = new Set(matches.map(item => item.name))
    const compatible = this.items.filter(item => (expected.type === undefined || item.type === expected.type) && (!expected.mobile || item.type !== 2))
    const preferred = (item: CatalogItem) => Number(this.profile.memberAliases(item.name).some(alias => normalized(alias) === name)) * 2
      - Number(!!this.profile.entry(item.name)?.undeploysInto)
    const sameName = compatible.filter(item => names.has(item.name)).sort((a, b) => preferred(b) - preferred(a))[0]
    if (sameName) return sameName
    const role = this.profile.roleForAlias(target)
    const definitions = this.profile.roles()
    // 类型大类只响应明确的类别名，不能把“犀牛”的跨阵营替代扩大成任意车辆。
    const typeRoles = new Set(definitions.filter(role => !role.members.length && role.match && !role.match.flags && !role.match.excludeFlags && !role.match.positivePower && !role.match.labelIncludes).map(role => role.id))
    const roles = new Set(role ? [role] : matches.flatMap(item => item.roles).filter(role => !typeRoles.has(role)))
    const types = new Set(matches.map(item => item.type))
    const roleType = role ? definitions.find(item => item.id === role)?.match?.type : types.size === 1 ? matches[0]?.type : undefined
    return compatible.find(item => (roleType === undefined || item.type === roleType) && item.roles.some(role => roles.has(role)))
      ?? matches.find(item => (expected.type === undefined || item.type === expected.type) && (!expected.mobile || item.type !== 2))
  }
  isRole(name: string, role: string, type?: number): boolean {
    const actual = this.all.find(item => item.name === name)
    if (actual) return actual.roles.includes(role)
    const hinted = type ?? this.profile.member(name)?.type
    return hinted !== undefined && this.profile.rolesFor(name, hinted).includes(role)
  }
  matchesUnit(unit: SnapshotUnit, selector: string): boolean {
    const role = this.profile.roleForAlias(selector)
    if (role) return this.isRole(unit.name, role, unit.type)
    const actual = this.all.find(item => item.name === unit.name)
    const name = normalized(selector)
    return normalized(unit.name) === name || normalized(actual?.label ?? '') === name || (actual?.aliases ?? this.profile.memberAliases(unit.name)).some(alias => normalized(alias) === name)
  }
  forTranscript(text: string) {
    const input = normalized(text)
    const roles = new Set(this.profile.roles().filter(role => role.aliases.some(alias => input.includes(normalized(alias)))).map(role => role.id))
    const named = this.all.filter(item => [item.name, item.label ?? '', ...item.aliases].some(alias => alias.length >= 2 && input.includes(normalized(alias))))
    // 各类别分别保留候选，避免复合命令中的大类挤掉另一项（如电厂 + 飞机）。
    const groups = [...roles].map(role => this.items.filter(item => item.roles.includes(role)))
    const representatives = Array.from({ length: 8 }, (_, index) => groups.flatMap(items => items[index] ? [items[index]!] : [])).flat()
    const matched = [...new Map([...named, ...representatives].map(item => [item.name, item])).values()]
    const selected = matched.length ? matched.slice(0, 48) : this.items.slice(0, 32)
    return selected.map(({ name, label, type, available, aliases, roles, limitation }) => ({ name, label, type, available, aliases, roles, ...(limitation ? { limitation } : {}) }))
  }
  powerPlant(): CatalogItem | undefined { return this.items.find(item => item.roles.includes('powerPlant') && item.power > 0) }
}

export async function loadGameCatalog(ctx: CommandContext, check: () => void, profile = loadPrompts().game): Promise<GameCatalog> {
  const snap = ctx.runtime.snapshot!
  const names = [...new Set([...profile.entries().filter(entry => entry.defined).map(entry => entry.name), ...profile.members().map(member => member.name), ...snap.self.map(unit => unit.name), ...(snap.production?.available ?? [])])]
  const available = new Set(snap.production?.available ?? [])
  const hints = new Map([...profile.entries().map(item => [item.name, item.type] as const), ...profile.members().map(item => [item.name, item.type] as const), ...snap.self.map(unit => [unit.name, unit.type] as const)])
  const batch = ctx.bridge.rulesMany ? await ctx.bridge.rulesMany(names.flatMap(name => hints.has(name) ? [{ name, type: hints.get(name)! }] : []), snap.sessionKey) : undefined
  check()
  const resolved = new Map(batch?.map(item => [`${item.type}:${item.name}`, item.rule]))
  const lookup = createRuleLookup((name, type) => resolved.has(`${type}:${name}`) ? Promise.resolve(resolved.get(`${type}:${name}`)) : ctx.bridge.rules?.(name, type) ?? Promise.resolve(undefined), check, profile, hints)
  const all = await Promise.all(names.map(async name => {
    const found = await lookup(name)
    if (!found) return undefined
    const { rule, type } = found
    const entry = profile.entry(name)
    const aliases = [...new Set([...profile.memberAliases(name), ...(entry ? [entry.label, entry.englishName] : [])])]
    const limitation = available.has(name) ? undefined : profile.limitation(name, snap.country, undefined, rule.techLevel)
    const label = rule.label ?? entry?.label
    return { name, type, label, techLevel: rule.techLevel, limitation, power: rule.power ?? 0, deploysInto: rule.deploysInto, undeploysInto: rule.undeploysInto, ammo: rule.ammo, available: available.has(name),
      factions: profile.factionsFor(name), roles: profile.rolesFor(name, type, { ...rule, label: `${label ?? ''} ${rule.label ?? ''}` }), aliases,
      harvester: rule.harvester, naval: rule.naval, refinery: rule.refinery, constructionYard: rule.constructionYard, engineer: rule.engineer, unsellable: rule.unsellable }
  }))
  return new GameCatalog(all.filter((item): item is NonNullable<typeof item> => !!item).filter(item => item.techLevel === undefined || item.techLevel >= 0 || available.has(item.name) || snap.self.some(unit => unit.name === item.name) || !!profile.member(item.name)), snap, profile)
}
