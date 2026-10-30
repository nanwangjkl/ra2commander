import type { CapabilityCall } from '@ra2c/command'
import type { CommandIntent } from './command-intent.ts'
import { formationAlias } from './command-text.ts'

/** 己方泛称按原话保留角色；生产与现有成员选择共用这一处校正。 */
export function normalizeCombatMembers(intent: CommandIntent, calls: CapabilityCall[]): CapabilityCall[] {
  const catalog = intent.catalog
  calls = calls.map(call => {
    const selector = 'selector' in call.params ? call.params.selector : undefined
    const matchingClause = intent.antiAirClause('formationId' in call.params ? call.params.formationId : undefined)
    if (!matchingClause) return call
    if ((call.capability === 'formation.cover' || call.capability === 'skill.run' && call.params.skillId === 'cover' || call.capability === 'formation.assign' || call.capability === 'combat.attack')
      && selector && (catalog?.selectorHasRole(selector, 'infantryFightingVehicle') || catalog?.selectorHasRole(selector, 'antiAirVehicle') || /^(?:ifv|infantryFightingVehicle|防空车)$/i.test(selector))) return { ...call, params: { ...call.params, selector: 'antiAirVehicle' } } as CapabilityCall
    if (call.capability === 'production.produce' && /造|生产|制造/.test(matchingClause.text) && !/掩护/.test(matchingClause.text) && (catalog?.selectorHasRole(call.params.target, 'antiAirVehicle') || catalog?.selectorHasRole(call.params.target, 'infantryFightingVehicle'))) return { ...call, params: { ...call.params, target: 'antiAirVehicle' } }
    return call
  })
  return calls
}

/** 作战目标、地域与移动/攻击合并只在这里校正。 */
export function normalizeCombatIntent(intent: CommandIntent, calls: CapabilityCall[]): CapabilityCall[] {
  // 持续监视走守卫入口，避免模型另写“飞机 type=1”之类的临时判定。
  for (const fact of intent.clauses.filter(clause => /监视|警戒|盯住/.test(clause.text))) {
    const formations = [...new Set(calls.flatMap(call => 'formationId' in call.params && call.params.formationId && call.capability.startsWith('combat.') ? [formationAlias(call.params.formationId)] : []))]
    const formationId = fact.formationId ?? (formations.length === 1 ? formations[0] : undefined)
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
  for (const fact of intent.clauses) {
    if (!fact.attack) continue
    const { selectors, fullyParsed, domain, split } = fact.attack, region = fact.region
    const relevant = attacks.filter(call => !fact.formationId || !call.params.formationId || formationAlias(call.params.formationId) === fact.formationId)
    if (!fact.formationId && new Set(relevant.map(call => call.params.formationId ?? '')).size > 1) continue
    for (const call of relevant) {
      if (split && call.capability !== 'combat.hold') call.params.splitTargets = true
      if (selectors.length) {
        // 只在整段目标都已识别时替换。局部词命中只能补充，不能删掉模型识别出的其他目标。
        call.params.targetSelectors = [...new Set([...(fullyParsed ? [] : call.params.targetSelectors ?? []), ...selectors])]
        if (call.capability === 'combat.attack' && fullyParsed) call.params.target = 'enemies'
      }
      if (domain) call.params.targetDomain = domain
      if (region && call.capability !== 'combat.attack-all') call.params.regionName = region.name
    }
  }
  const patrolFormations = intent.patrolFormations
  const replace = (matches: (call: CapabilityCall) => boolean, replacement: CapabilityCall) => {
    let inserted = false
    calls = calls.flatMap(call => {
      if (!matches(call)) return [call]
      if (inserted) return []
      inserted = true
      return [replacement]
    })
    if (!inserted) calls = [replacement, ...calls]
  }
  for (const fact of intent.clauses) {
    const clause = fact.text
    if (!/摧毁|消灭|清理|清除|扫清|攻击/.test(clause)) continue
    const targetId = fact.formationId ?? intent.formationId
    if (!targetId) continue
    if (patrolFormations.has(targetId)) continue
    const region = fact.region
    if (region && calls.some(call => call.capability === 'combat.attack' && call.params.formationId && formationAlias(call.params.formationId) === targetId)) {
      calls = calls.flatMap(call => {
        if (call.capability === 'combat.attack' && call.params.formationId && formationAlias(call.params.formationId) === targetId) return [{ ...call, params: { ...call.params, regionName: region.name } }]
        if (['combat.move', 'combat.attack-all', 'combat.clear-region'].includes(call.capability) && 'formationId' in call.params && call.params.formationId && formationAlias(call.params.formationId) === targetId) return []
        return [call]
      })
      continue
    }
    const previousAttack = calls.find(call => ['combat.attack-all', 'combat.clear-region'].includes(call.capability) && 'formationId' in call.params && (!call.params.formationId || formationAlias(call.params.formationId) === targetId))
    if (region) replace(call => call.capability === 'combat.attack-all' ? !call.params.formationId || formationAlias(call.params.formationId) === targetId
      : (call.capability === 'combat.move' || call.capability === 'combat.clear-region') && formationAlias(call.params.formationId) === targetId,
    { capability: 'combat.clear-region', params: { formationId: targetId, regionName: region.name, ...(previousAttack && 'splitTargets' in previousAttack.params ? {splitTargets:previousAttack.params.splitTargets} : {}), ...(previousAttack && 'targetSelectors' in previousAttack.params && previousAttack.params.targetSelectors ? { targetSelectors: previousAttack.params.targetSelectors } : {}), ...(previousAttack && 'targetDomain' in previousAttack.params && previousAttack.params.targetDomain ? { targetDomain: previousAttack.params.targetDomain } : {}) } })
    else calls = calls.map(call => call.capability === 'combat.attack-all' && !call.params.formationId ? { ...call, params: { ...call.params, formationId: targetId } } : call)
  }
  // 普通“向某区移动，攻击……”是一个区域攻击，不产生会相互替换的两个同队目标。
  for (const call of calls.filter(call => call.capability === 'combat.attack')) {
    if (call.capability !== 'combat.attack' || !call.params.formationId || /先.*(?:集结|到齐).*再/.test(intent.raw)) continue
    const moves = calls.filter(move => move.capability === 'combat.move' && formationAlias(move.params.formationId) === formationAlias(call.params.formationId!))
    const move = moves.length === 1 ? moves[0] : undefined
    if (move?.capability === 'combat.move' && move.params.regionName && (!call.params.regionName || call.params.regionName === move.params.regionName)) {
      call.params.regionName = move.params.regionName
      calls = calls.filter(item => item !== move)
    }
  }
  return calls
}
