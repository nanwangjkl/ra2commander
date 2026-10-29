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
  // 持续监视走守卫入口，避免模型另写“飞机 type=1”之类的临时判定。
  for (const clause of clauses.filter(clause => /监视|警戒|盯住/.test(clause))) {
    const named = clause.match(/([\d一二三四五六七八九十两]+)队/)
    const formations = [...new Set(calls.flatMap(call => 'formationId' in call.params && call.params.formationId && call.capability.startsWith('combat.') ? [formationAlias(call.params.formationId)] : []))]
    const formationId = named ? formationAlias(`${named[1]}队`) : formations.length === 1 ? formations[0] : undefined
    if (!formationId) continue
    calls = calls.map(call => {
      if (!['combat.attack', 'combat.attack-all', 'combat.clear-region', 'combat.hold'].includes(call.capability) || !('formationId' in call.params) || !call.params.formationId || formationAlias(call.params.formationId) !== formationId) return call
      if (call.capability === 'combat.hold') return { ...call, params: { ...call.params, mode: 'hold' } }
      if ('unitIds' in call.params && call.params.unitIds || 'selector' in call.params && call.params.selector && call.params.selector !== 'combat') return call
      return { capability: 'combat.hold', params: { formationId, mode: 'hold',
        ...('regionName' in call.params && call.params.regionName ? { regionName: call.params.regionName } : {}),
        ...('targetSelectors' in call.params && call.params.targetSelectors ? { targetSelectors: call.params.targetSelectors } : {}),
        ...('targetDomain' in call.params && call.params.targetDomain ? { targetDomain: call.params.targetDomain } : {}) } }
    })
  }
  const attacks = calls.filter((call): call is Extract<CapabilityCall, { capability: 'combat.attack' | 'combat.clear-region' | 'combat.attack-all' | 'combat.hold' }> => call.capability === 'combat.attack' || call.capability === 'combat.clear-region' || call.capability === 'combat.attack-all' || call.capability === 'combat.hold' && !call.params.defendBase && call.params.mode !== 'move')
  const names = catalog ? [...catalog.profile.attackAliases().filter(item => catalog.all.some(unit => unit.name === item.name)).map(item => ({ alias: item.alias, selector: item.name })), ...catalog.profile.roles().flatMap(role => role.aliases.map(alias => ({ alias, selector: role.id }))), ...catalog.all.flatMap(item => [item.name, item.label ?? '', ...item.aliases].map(alias => ({ alias, selector: item.name })))].filter(item => item.alias.length >= 2).sort((a, b) => b.alias.length - a.alias.length) : []
  for (const clause of clauses) {
    const verb = clause.match(/攻击|进攻|摧毁|消灭|清理|清除|扫清|轰炸|监视|警戒|盯住/)
    if (!verb) continue
    const named = clause.match(/([\d一二三四五六七八九十两]+)队/)
    const relevant = attacks.filter(call => !named || !call.params.formationId || formationAlias(call.params.formationId) === formationAlias(`${named[1]}队`))
    if (!named && new Set(relevant.map(call => call.params.formationId ?? '')).size > 1) continue
    let enemyText = clause.slice(verb.index! + verb[0].length).toLowerCase()
    const selectors: string[] = []
    // “部队”与“防御建筑”先作为完整概念解析，不能只捡出末尾的“建筑”。
    enemyText = enemyText.replace(/部队|军队/g, () => { selectors.push('infantry', 'vehicle'); return ' ' })
    for (const item of names) if (enemyText.includes(normalizeName(item.alias).toLowerCase())) {
      selectors.push(item.selector); enemyText = enemyText.split(normalizeName(item.alias).toLowerCase()).join(' ')
    }
    const domain = /空中/.test(clause.slice(verb.index!)) ? 'air' as const : /地面/.test(clause.slice(verb.index!)) ? 'ground' as const : undefined
    const region = map?.scheme.regions.find(region => [region.name, ...region.aliases].some(name => clause.includes(normalizeName(name))))
    for (const name of region ? [region.name, ...region.aliases] : []) enemyText = enemyText.split(normalizeName(name).toLowerCase()).join(' ')
    const fullyParsed = !enemyText.replace(/只要|一旦|出现|发现|看到|看见|立即|马上|持续|一直|击落|干掉|攻击|消灭|摧毁|就|以及|并且|视野内|可见|当前|最近|所有|全部|全体|任何|任意|空中|地面|敌方|敌军|敌人|对方|区域内|分区内|区域|分区|单位|目标|的|和|与|及|或|内|里|中|物|[\s、]/g, '')
    for (const call of relevant) {
      if (/分头|分散|各自/.test(clause) && call.capability !== 'combat.hold') call.params.splitTargets = true
      if (selectors.length) {
        // 只在整段目标都已识别时替换。局部词命中只能补充，不能删掉模型识别出的其他目标。
        call.params.targetSelectors = [...new Set([...(fullyParsed ? [] : call.params.targetSelectors ?? []), ...selectors])]
        if (call.capability === 'combat.attack' && fullyParsed) call.params.target = 'enemies'
      }
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
