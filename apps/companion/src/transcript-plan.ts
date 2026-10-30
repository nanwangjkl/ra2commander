import type { CapabilityCall } from '@ra2c/command'
import type { MapRegionIndex } from '../../../packages/maps/src/index.ts'
import { chineseNumber, formationAlias } from './command-text.ts'
import type { GameCatalog } from './game-catalog.ts'
import { normalizeDeployment } from './deployment-plan.ts'
import { normalizeCombatIntent, normalizeCombatMembers } from './combat-plan.ts'
import { CommandIntent } from './command-intent.ts'
import { normalizeBaseDefense } from './base-defense.ts'

/** 纠正已确认的编队/地域误解；原位替换，保留同句话各操作的先后关系。 */
export function normalizeOperations(text: string, operations: CapabilityCall[], map?: MapRegionIndex, catalog?: GameCatalog): CapabilityCall[] {
  const intent = new CommandIntent(text, map, catalog)
  operations = normalizeBaseDefense(intent, operations)
  operations = normalizeCombatMembers(intent, operations)
  operations = normalizeDeployment(intent, operations)
  operations = normalizeOrganization(intent, operations)
  return normalizeCombatIntent(intent, operations)
}

function normalizeOrganization(intent: CommandIntent, operations: CapabilityCall[]): CapabilityCall[] {
  const { raw, catalog } = intent
  const clauses = intent.clauses.map(clause => clause.text)
  const role = (value: string, name: 'aircraft' | 'tank') => catalog?.selectorHasRole(value, name) ?? (name === 'aircraft' ? /^(?:aircraft|飞机|空军)$/i : /^(?:tanks?|坦克|所有坦克)$/i).test(value)

  // 已复现：模型为“所有飞机攻击”擅自建队，建队等待后又将攻击扩大到侦察队。
  if (/(?:所有|全部|全体).*(?:飞机|战机|轰炸机)/.test(raw) && /攻击|轰炸|摧毁|消灭/.test(raw) && !/编入|编到|加入|建队|[一二三四五六七八九十\d]+队/.test(raw)) {
    const airClause = clauses.find(clause => /(?:所有|全部|全体).*(?:飞机|战机|轰炸机)/.test(clause) && /攻击|轰炸|摧毁|消灭/.test(clause)) ?? raw
    const target = /基地/.test(airClause) ? 'base' as const : /建筑/.test(airClause) ? 'buildings' as const : /敌方单位|敌军单位/.test(airClause) ? 'units' as const : 'enemies' as const
    const region = intent.clauses.find(clause => clause.text === airClause)?.region
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
  const formationId = intent.formationId
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
  const patrolFormations = intent.patrolFormations
  if (patrolFormations.size) operations = operations.map(call => call.capability === 'combat.move' && patrolFormations.has(formationAlias(call.params.formationId)) ? { ...call, params: { ...call.params, patrol: true } } : call)
  return operations
}
