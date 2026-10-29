import type { CapabilityCall } from '@ra2c/command'
import type { MapRegionIndex } from '../../../packages/maps/src/index.ts'
import type { GameCatalog } from './game-catalog.ts'
import { formationAlias, normalizeName } from './capabilities/selectors.ts'

/** 只从原话补回明确的己方角色、敌方选择和地域，不把模型误选当成玩家要求。 */
export function normalizeCombatIntent(text: string, calls: CapabilityCall[], map?: MapRegionIndex, catalog?: GameCatalog): CapabilityCall[] {
  const clauses = normalizeName(text).split(/[，,。；;\n]/)
  const genericAA = clauses.filter(clause => /防空车|防空战车/.test(clause) && !/IFV|FV|多功能/i.test(clause))
  calls = calls.map(call => {
    const selector = 'selector' in call.params ? call.params.selector : undefined
    const matchingClause = genericAA.find(clause => {
      const named = clause.match(/([\d一二三四五六七八九十两]+)队/)
      return !named || !('formationId' in call.params) || !call.params.formationId || formationAlias(`${named[1]}队`) === formationAlias(call.params.formationId)
    })
    if (!matchingClause) return call
    if ((call.capability === 'formation.cover' || call.capability === 'skill.run' && call.params.skillId === 'cover' || call.capability === 'formation.assign' || call.capability === 'combat.attack')
      && selector && (catalog?.selectorHasRole(selector, 'infantryFightingVehicle') || catalog?.selectorHasRole(selector, 'antiAirVehicle') || /^(?:ifv|infantryFightingVehicle|防空车)$/i.test(selector))) return { ...call, params: { ...call.params, selector: 'antiAirVehicle' } } as CapabilityCall
    if (call.capability === 'production.produce' && /造|生产|制造/.test(matchingClause) && !/掩护/.test(matchingClause) && (catalog?.selectorHasRole(call.params.target, 'antiAirVehicle') || catalog?.selectorHasRole(call.params.target, 'infantryFightingVehicle'))) return { ...call, params: { ...call.params, target: 'antiAirVehicle' } }
    return call
  })
  const attacks = calls.filter(call => call.capability === 'combat.attack' || call.capability === 'combat.clear-region' || call.capability === 'combat.attack-all')
  const names = catalog ? [...catalog.profile.roles().flatMap(role => role.aliases.map(alias => ({ alias, selector: role.id }))), ...catalog.all.flatMap(item => [item.name, item.label ?? '', ...item.aliases].map(alias => ({ alias, selector: item.name })))].filter(item => item.alias.length >= 2).sort((a, b) => b.alias.length - a.alias.length) : []
  for (const clause of clauses) {
    const verb = clause.match(/攻击|进攻|摧毁|消灭|清理|清除|扫清|轰炸/)
    if (!verb) continue
    const named = clause.match(/([\d一二三四五六七八九十两]+)队/)
    const relevant = attacks.filter(call => !named || !call.params.formationId || formationAlias(call.params.formationId) === formationAlias(`${named[1]}队`))
    if (!named && new Set(relevant.map(call => call.params.formationId ?? '')).size > 1) continue
    let enemyText = clause.slice(verb.index! + verb[0].length)
    const selectors: string[] = []
    for (const item of names) if (enemyText.includes(normalizeName(item.alias))) {
      selectors.push(item.selector); enemyText = enemyText.split(normalizeName(item.alias)).join(' ')
    }
    const domain = /空中/.test(clause.slice(verb.index!)) ? 'air' as const : /地面/.test(clause.slice(verb.index!)) ? 'ground' as const : undefined
    const region = map?.scheme.regions.find(region => [region.name, ...region.aliases].some(name => clause.includes(normalizeName(name))))
    for (const call of relevant) {
      if (selectors.length) call.params.targetSelectors = [...new Set(selectors)]
      if (domain) call.params.targetDomain = domain
      if (region && call.capability !== 'combat.attack-all') call.params.regionName = region.name
    }
  }
  // 普通“向某区移动，攻击……”是一个区域攻击，不产生会相互替换的两个同队目标。
  for (const call of attacks) {
    if (call.capability !== 'combat.attack' || !call.params.formationId || /先.*(?:集结|到齐).*再/.test(text)) continue
    const moves = calls.filter(move => move.capability === 'combat.move' && formationAlias(move.params.formationId) === formationAlias(call.params.formationId!))
    const move = moves.length === 1 ? moves[0] : undefined
    if (move?.capability === 'combat.move' && move.params.regionName && (!call.params.regionName || call.params.regionName === move.params.regionName)) {
      call.params.regionName = move.params.regionName
      calls = calls.filter(item => item !== move)
    }
  }
  return calls
}
