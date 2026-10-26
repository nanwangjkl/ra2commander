import type { GameProfile } from '@ra2c/command'
import type { SnapshotUnit } from '@ra2c/contracts'
import type { GameCatalog, CatalogItem } from './game-catalog.ts'
import type { CommandContext } from './commands.ts'

export const normalizeSelector = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
const mobile = (type: number) => [1, 3, 7].includes(type)
const special = (value: string) => {
  const selector = normalizeSelector(value)
  if (['all', '全部', '所有', '所有单位', '全部单位'].includes(selector)) return 'all'
  if (['combat', '战斗单位', '作战单位', '所有战斗单位', '所有作战单位'].includes(selector)) return 'combat'
  if (['repairvehicles', '维修车', '修理车', '维修车辆'].includes(selector)) return 'repairVehicles'
}
export function isCombatUnit(unit: SnapshotUnit, catalog?: GameCatalog, profile?: GameProfile): boolean {
  if (!mobile(unit.type) || (!unit.primaryWeapon && !unit.secondaryWeapon)) return false
  return !['harvester', 'constructionVehicle', 'engineer'].some(role => catalog ? catalog.isRole(unit.name, role, unit.type) : profile?.rolesFor(unit.name, unit.type).includes(role))
}
export function isRepairVehicle(unit: SnapshotUnit, ctx: Pick<CommandContext, 'runtime'>, catalog?: GameCatalog, profile?: GameProfile): boolean {
  if (!(catalog ? catalog.isRole(unit.name, 'infantryFightingVehicle', unit.type) : profile?.rolesFor(unit.name, unit.type).includes('infantryFightingVehicle'))) return false
  if (unit.transport?.passengers?.some(passenger => catalog ? catalog.isRole(passenger.name, 'engineer', passenger.type) : profile?.rolesFor(passenger.name, passenger.type).includes('engineer'))) return true
  const engineers = new Set([...ctx.runtime.goals.values()].flatMap(goal => goal.facts.repair?.engineerIds ?? []))
  return !!unit.transport?.unitIds.some(id => engineers.has(id))
}
/** 普通类别、原生名称和别名都由目录匹配；动态作战/载员条件只用于真实单位。 */
export function matchesSelector(unit: SnapshotUnit, selector: string, ctx: Pick<CommandContext, 'runtime'>, catalog?: GameCatalog, profile?: GameProfile): boolean {
  const kind = special(selector)
  if (kind === 'all') return mobile(unit.type)
  if (kind === 'combat') return isCombatUnit(unit, catalog, profile)
  if (kind === 'repairVehicles') return isRepairVehicle(unit, ctx, catalog, profile)
  if (catalog) return catalog.matchesUnit(unit, selector)
  const role = profile?.roleForAlias(selector)
  const type = role ? profile?.roles().find(definition => definition.id === role)?.match?.type : undefined
  return role ? (type === undefined || unit.type === type) && !!profile?.rolesFor(unit.name, unit.type).includes(role) : normalizeSelector(unit.name) === normalizeSelector(selector) || !!profile?.memberAliases(unit.name).some(alias => normalizeSelector(alias) === normalizeSelector(selector))
}
/** 用同一类别规则筛选尚未出生的候选，武器/载员仍等真实快照确认。 */
export function matchesFutureMember(item: CatalogItem, selector: string, catalog: GameCatalog): boolean {
  const kind = special(selector)
  if (kind === 'all') return mobile(item.type)
  if (kind === 'combat') return mobile(item.type) && !item.roles.some(role => ['harvester', 'constructionVehicle', 'engineer'].includes(role))
  if (kind === 'repairVehicles') return false
  return catalog.matchesUnit(item, selector)
}
export interface SelectionQuery { selector?: string; unitIds?: number[]; quantity?: number | 'all' }
export interface SelectionPolicy {
  sourceFormationId?: string
  unassigned?: boolean
  excludeFormationId?: string
  formationId?: string
  pendingIds?: readonly number[]
  armed?: boolean
  eligible?: (unit: SnapshotUnit) => boolean
}
/** 先按语义匹配，再按归属/当前可用性过滤，最后截取数量；各能力不再各自排列步骤。 */
export function resolveUnitSelection(ctx: CommandContext, query: SelectionQuery, catalog?: GameCatalog, profile?: GameProfile, policy: SelectionPolicy = {}) {
  const explicit = query.unitIds ? new Set(query.unitIds) : undefined
  const matched = ctx.runtime.snapshot!.self.filter(unit => (!policy.sourceFormationId || ctx.formations.ownerOf(unit.id) === policy.sourceFormationId)
    && (explicit ? explicit.has(unit.id) : matchesSelector(unit, query.selector ?? 'all', ctx, catalog, profile)))
    .sort((a, b) => Number(!!ctx.formations.ownerOf(a.id)) - Number(!!ctx.formations.ownerOf(b.id)) || a.id - b.id)
  const available = matched.filter(unit => (!policy.unassigned || !ctx.formations.ownerOf(unit.id))
    && (!policy.excludeFormationId || ctx.formations.ownerOf(unit.id) !== policy.excludeFormationId)
    && (!policy.formationId || ctx.formations.ownerOf(unit.id) === policy.formationId || policy.pendingIds?.includes(unit.id))
    && (!policy.armed || !!(unit.primaryWeapon || unit.secondaryWeapon)) && (!policy.eligible || policy.eligible(unit)))
  const selected = query.quantity === undefined || query.quantity === 'all' ? available : available.slice(0, query.quantity)
  return { matched, available, selected }
}
