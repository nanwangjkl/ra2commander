import { loadPrompts, type GameProfile, type RuleFacts } from '@ra2c/command'
import type { Snapshot, SnapshotUnit } from '@ra2c/contracts'
import type { CommandContext } from './commands.ts'
import { createRuleLookup } from './game-rules.ts'

interface CatalogItem extends RuleFacts {
  name: string; type: number; power: number; available: boolean
  deploysInto?: string | undefined
  factions: string[]; roles: string[]; aliases: string[]
}
const normalized = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()

export class GameCatalog {
  readonly items: CatalogItem[]
  readonly faction: string | undefined
  constructor(readonly all: CatalogItem[], snap: Snapshot, readonly profile: GameProfile) {
    this.faction = profile.inferFaction(snap.self)
    const owned = new Set(snap.self.map(unit => unit.name))
    const rank = (item: CatalogItem) => Number(item.available) * 4 + Number(item.factions.includes(this.faction ?? '')) * 2 + Number(owned.has(item.name))
    this.items = all.filter(item => !this.faction || !item.factions.length || item.factions.includes(this.faction) || item.available).sort((a, b) => rank(b) - rank(a))
  }
  resolve(target: string): CatalogItem | undefined {
    const name = normalized(target)
    const exact = this.items.find(item => normalized(item.name) === name)
    if (exact) return exact
    const matches = this.all.filter(item => normalized(item.name) === name || normalized(item.label ?? '') === name || item.aliases.some(alias => normalized(alias) === name))
    const names = new Set(matches.map(item => item.name))
    const sameName = this.items.find(item => names.has(item.name))
    if (sameName) return sameName
    const role = this.profile.roleForAlias(target)
    const roles = new Set(role ? [role] : matches.flatMap(item => item.roles))
    return this.items.find(item => item.roles.some(role => roles.has(role)))
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
    return normalized(unit.name) === name || normalized(actual?.label ?? '') === name || this.profile.memberAliases(unit.name).some(alias => normalized(alias) === name)
  }
  powerPlant(): CatalogItem | undefined { return this.items.find(item => item.roles.includes('powerPlant') && item.power > 0) }
}

export async function loadGameCatalog(ctx: CommandContext, check: () => void, profile = loadPrompts().game): Promise<GameCatalog> {
  const snap = ctx.runtime.snapshot!
  const names = [...new Set([...profile.members().map(member => member.name), ...snap.self.map(unit => unit.name), ...(snap.production?.available ?? [])])]
  const available = new Set(snap.production?.available ?? [])
  const lookup = createRuleLookup((name, type) => ctx.bridge.rules?.(name, type) ?? Promise.resolve(undefined), check, profile, new Map(snap.self.map(unit => [unit.name, unit.type])))
  const all = await Promise.all(names.map(async name => {
    const found = await lookup(name)
    if (!found) return undefined
    const { rule, type } = found
    const member = profile.member(name)
    return { name, type, label: rule.label, power: rule.power ?? 0, deploysInto: rule.deploysInto, available: available.has(name),
      factions: member?.factions ?? [], roles: profile.rolesFor(name, type, rule), aliases: profile.memberAliases(name),
      harvester: rule.harvester, naval: rule.naval, refinery: rule.refinery, constructionYard: rule.constructionYard, engineer: rule.engineer }
  }))
  return new GameCatalog(all.filter((item): item is NonNullable<typeof item> => !!item), snap, profile)
}
