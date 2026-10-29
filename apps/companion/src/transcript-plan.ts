import type { CapabilityCall } from '@ra2c/command'
import type { MapRegionIndex } from '../../../packages/maps/src/index.ts'
import { chineseNumber, formationAlias, normalizeName } from './capabilities/selectors.ts'
import type { GameCatalog } from './game-catalog.ts'
import { normalizeDeployment } from './deployment-plan.ts'
import { normalizeCombatIntent } from './combat-plan.ts'
import { normalizeBaseDefense } from './base-defense.ts'

/** 纠正已确认的编队/地域误解；原位替换，保留同句话各操作的先后关系。 */
export function normalizeOperations(text: string, operations: CapabilityCall[], map?: MapRegionIndex, catalog?: GameCatalog): CapabilityCall[] {
  operations = normalizeDeployment(text, normalizeCombatIntent(text, normalizeBaseDefense(text,operations), map, catalog), map, catalog)
  const raw = normalizeName(text)
  const role = (value: string, name: 'aircraft' | 'tank') => catalog?.selectorHasRole(value, name) ?? (name === 'aircraft' ? /^(?:aircraft|飞机|空军)$/i : /^(?:tanks?|坦克|所有坦克)$/i).test(value)

  // 已复现：模型为“所有飞机攻击”擅自建队，建队等待后又将攻击扩大到侦察队。
  if (/(?:所有|全部|全体).*(?:飞机|战机|轰炸机)/.test(raw) && /攻击|轰炸|摧毁|消灭/.test(raw) && !/编入|编到|加入|建队|[一二三四五六七八九十\d]+队/.test(raw)) {
    const airClause = raw.split(/[，,。；;\n]/).find(clause => /(?:所有|全部|全体).*(?:飞机|战机|轰炸机)/.test(clause) && /攻击|轰炸|摧毁|消灭/.test(clause)) ?? raw
    const target = /基地/.test(airClause) ? 'base' as const : /建筑/.test(airClause) ? 'buildings' as const : /敌方单位|敌军单位/.test(airClause) ? 'units' as const : 'enemies' as const
    const region = map?.scheme.regions.slice().sort((a, b) => b.name.length - a.name.length).find(region => [region.name, ...region.aliases].some(name => airClause.includes(normalizeName(name))))
    const implicit = new Set(operations.flatMap(call => call.capability === 'formation.assign' && role(call.params.selector ?? '', 'aircraft') ? [formationAlias(call.params.formationId)] : []))
    let replaced = false
    operations = operations.flatMap(call => {
      if (call.capability === 'formation.assign' && role(call.params.selector ?? '', 'aircraft')) return []
      if (!['combat.attack', 'combat.attack-all', 'combat.clear-region'].includes(call.capability)) return [call]
      if (call.capability === 'combat.attack' && call.params.selector !== undefined && call.params.selector !== 'combat' && !role(call.params.selector, 'aircraft')) return [call]
      if ('formationId' in call.params && call.params.formationId && !implicit.has(formationAlias(call.params.formationId))) return [call]
      if (call.capability === 'combat.attack' && role(call.params.selector ?? '', 'aircraft')) {
        const { formationId: _implicitFormation, ...params } = call.params
        replaced = true
        return [{ ...call, params }]
      }
      if (replaced) return []
      replaced = true
      return [{ capability: 'combat.attack' as const, params: { selector: 'aircraft', target, ...('splitTargets' in call.params ? {splitTargets:call.params.splitTargets} : {}), ...('targetSelectors' in call.params && call.params.targetSelectors ? { targetSelectors: call.params.targetSelectors } : {}), ...('targetDomain' in call.params && call.params.targetDomain ? { targetDomain: call.params.targetDomain } : {}), ...(region ? { regionName: region.name } : {}) } }]
    })
  }
  const match = raw.match(/(?:编入|编到|归入|加入)([\d一二三四五六七八九十两]+)队/) ?? raw.match(/([\d一二三四五六七八九十两]+)队/)
  const formationId = match ? `${chineseNumber(match[1]!)}队` : undefined
  if (!formationId) return operations
  const replace = (matches: (call: CapabilityCall) => boolean, replacement: CapabilityCall) => {
    let replaced = false
    const result = operations.flatMap(call => {
      if (!matches(call)) return [call]
      if (replaced) return []
      replaced = true; return [replacement]
    })
    operations = replaced ? result : [replacement, ...result]
  }
  const clauses = raw.split(/[，,。；;\n]/)
  // “造5辆坦克，编入1队，2个IFV掩护”承接本句的新造语境；明确使用现有时不补造。
  if (/造|生产|制造/.test(raw) && !/现有|已有|不要.*(?:生产|造)|不用.*(?:生产|造)/.test(raw)) operations = operations.map(call => {
    const cover = call.capability === 'formation.cover' || call.capability === 'skill.run' && call.params.skillId === 'cover'
    if (!cover || call.params.memberSource === 'new' || call.params.unitIds) return call
    const matchingProduction = operations.some(item => item.capability === 'production.produce' && item.params.formationId && formationAlias(item.params.formationId) === formationAlias(call.params.formationId ?? formationId))
    return matchingProduction ? { ...call, params: { ...call.params, memberSource: 'auto' } } as CapabilityCall : call
  })
  for (const clause of clauses) {
    const target = clause.match(/(?:编入|编到|归入|加入)([\d一二三四五六七八九十两]+)队/)
    if (!target) continue
    const targetId = `${chineseNumber(target[1]!)}队`
    if (/(?:所有|全部|全体).*(?:战斗|作战)单位/.test(clause)) {
      replace(call => call.capability === 'formation.assign' && formationAlias(call.params.formationId) === targetId,
        { capability: 'formation.assign', params: { selector: 'combat', quantity: 'all', formationId: targetId } })
    } else {
      const productionText = clause.replace(/(?:不要|别|无需|不用|禁止)(?:再)?(?:生产|制造|造|出兵)/g, '')
      if (!/坦克/.test(clause) || /制造|生产|建造|新造|再造|补足|补齐|(?:造|出).{0,8}坦克/.test(productionText)) continue
      const count = clause.match(/([\d一二三四五六七八九十两]+)(?:个|辆|台)?[^，,。；;\d一二三四五六七八九十两]{0,8}坦克/)
      const quantity = /所有|全部|全体/.test(clause) || !count ? 'all' : chineseNumber(count[1]!)
      const otherProduction = clauses.some(other => other !== clause && /制造|生产|建造|新造|再造|补足|补齐|(?:造|出).{0,8}坦克/.test(other))
      replace(call => call.capability === 'formation.assign' ? formationAlias(call.params.formationId) === targetId && (call.params.selector === undefined || call.params.selector === 'all' || role(call.params.selector, 'tank'))
        : call.capability === 'production.produce' && (call.params.formationId ? formationAlias(call.params.formationId) === targetId : !otherProduction)
          && role(call.params.target, 'tank'),
      { capability: 'formation.assign', params: { selector: 'tanks', quantity, formationId: targetId } })
    }
  }
  const patrolFormations = new Set(clauses.flatMap(clause => {
    const match = clause.match(/([\d一二三四五六七八九十两]+)队[^，,。；;]*巡逻/)
    return match ? [`${chineseNumber(match[1]!)}队`] : []
  }))
  if (patrolFormations.size) operations = operations.map(call => call.capability === 'combat.move' && patrolFormations.has(formationAlias(call.params.formationId)) ? { ...call, params: { ...call.params, patrol: true } } : call)
  for (const clause of clauses) {
    if (!/摧毁|消灭|清理|清除|扫清|攻击/.test(clause)) continue
    const named = clause.match(/([\d一二三四五六七八九十两]+)队/)
    const targetId = named ? `${chineseNumber(named[1]!)}队` : formationId
    if (patrolFormations.has(targetId)) continue
    const region = map?.scheme.regions.slice().sort((a, b) => b.name.length - a.name.length).find(region => [region.name, ...region.aliases].some(name => clause.includes(normalizeName(name))))
    if (region && operations.some(call => call.capability === 'combat.attack' && call.params.formationId && formationAlias(call.params.formationId) === targetId)) {
      operations = operations.flatMap(call => {
        if (call.capability === 'combat.attack' && call.params.formationId && formationAlias(call.params.formationId) === targetId) return [{ ...call, params: { ...call.params, regionName: region.name } }]
        if (['combat.move', 'combat.attack-all', 'combat.clear-region'].includes(call.capability) && 'formationId' in call.params && call.params.formationId && formationAlias(call.params.formationId) === targetId) return []
        return [call]
      })
      continue
    }
    const previousAttack = operations.find(call => ['combat.attack-all', 'combat.clear-region'].includes(call.capability) && 'formationId' in call.params && (!call.params.formationId || formationAlias(call.params.formationId) === targetId))
    if (region) replace(call => call.capability === 'combat.attack-all' ? !call.params.formationId || formationAlias(call.params.formationId) === targetId
      : (call.capability === 'combat.move' || call.capability === 'combat.clear-region') && formationAlias(call.params.formationId) === targetId,
    { capability: 'combat.clear-region', params: { formationId: targetId, regionName: region.name, ...(previousAttack && 'splitTargets' in previousAttack.params ? {splitTargets:previousAttack.params.splitTargets} : {}), ...(previousAttack && 'targetSelectors' in previousAttack.params && previousAttack.params.targetSelectors ? { targetSelectors: previousAttack.params.targetSelectors } : {}), ...(previousAttack && 'targetDomain' in previousAttack.params && previousAttack.params.targetDomain ? { targetDomain: previousAttack.params.targetDomain } : {}) } })
    else operations = operations.map(call => call.capability === 'combat.attack-all' && !call.params.formationId ? { ...call, params: { ...call.params, formationId: targetId } } : call)
  }
  return operations
}
