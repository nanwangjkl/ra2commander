import type { CapabilityCall } from '@ra2c/command'
import type { CommandIntent } from './command-intent.ts'
import { formationAlias, normalizeName } from './capabilities/selectors.ts'

/** 保留明确的部署意图：不能把“到地方部署”降成单纯移动或虚构兵种编队。 */
export function normalizeDeployment(intent: CommandIntent, calls: CapabilityCall[]): CapabilityCall[] {
  const catalog = intent.catalog
  for (const fact of intent.clauses) {
    const clause = fact.text
    if (!/部署|坐下|蹲下|架起|站起来|解除部署/.test(clause) || /基地车|建造厂|基地.*展开/.test(clause)) continue
    const deployed = !/解除部署|取消部署|收起|站起来/.test(clause)
    const { formationId, region, namedUnits } = fact
    const moving = !!region || /去|前往|移到|到.+(?:部署|坐下|架起)/.test(clause)
    const productions = calls.filter((call): call is Extract<CapabilityCall, { capability: 'production.produce' }> => call.capability === 'production.produce' && !!catalog?.resolve(call.params.target)?.deployer && (!formationId || !!call.params.formationId && formationAlias(call.params.formationId) === formationId))
    // 有多个兵种时只承接本分句点名的生产；唯一匹配可承接“造好后去部署”。
    const source = productions.find(call => namedUnits.some(unit => unit.name === catalog!.resolve(call.params.target)!.name)) ?? (productions.length === 1 && !namedUnits.length ? productions[0] : undefined)
    const sourceFormation = source?.params.formationId
    const sourceMove = (name: string) => !!source && (sourceFormation ? formationAlias(name) === formationAlias(sourceFormation) : catalog!.matchesUnit(catalog!.resolve(source.params.target)!, name))
    const current = calls.find(call => call.capability === 'unit.deploy' && (formationId ? call.params.formationId && formationAlias(call.params.formationId) === formationId : source ? (!call.params.formationId || sourceMove(call.params.formationId)) && (['all', ''].includes(call.params.selector ?? '') || catalog?.resolve(call.params.selector ?? '')?.name === catalog?.resolve(source.params.target)?.name || call.params.source === 'production') : true))
    if (current?.capability === 'unit.deploy') {
      const { formationId: previousFormation, ...params } = current.params
      const selectedFormation = formationId ?? sourceFormation ?? (!source ? previousFormation : undefined)
      current.params = { ...params, deployed, ...(selectedFormation ? { formationId: selectedFormation } : {}), ...(source && current.params.source !== 'existing' ? { selector: source.params.target, source: 'production' } : {}), ...(region ? { regionName: region.name } : {}) }
      calls = calls.filter(call => call.capability !== 'combat.move' || !(formationId ? formationAlias(call.params.formationId) === formationId : sourceMove(call.params.formationId)) || region && normalizeName(call.params.regionName ?? '') !== normalizeName(region.name))
      continue
    }
    if (!formationId && !source) continue
    let inserted = false
    calls = calls.flatMap(call => {
      if (call.capability !== 'combat.move' || !(formationId ? formationAlias(call.params.formationId) === formationId : sourceMove(call.params.formationId))) return [call]
      if (inserted) return []
      inserted = true
      return [{ capability: 'unit.deploy' as const, params: { deployed, ...(formationId ? { formationId } : {}), ...(source ? { selector: source.params.target, source: 'production' as const } : {}), ...(region ? { regionName: region.name } : moving && call.params.regionName ? { regionName: call.params.regionName } : {}), ...(moving && call.params.x !== undefined ? { x: call.params.x } : {}), ...(moving && call.params.y !== undefined ? { y: call.params.y } : {}) } }]
    })
    if (!inserted) calls.push({ capability: 'unit.deploy', params: { deployed, ...(formationId ? { formationId } : {}), ...(source ? { selector: source.params.target, source: 'production' } : {}), ...(region ? { regionName: region.name } : {}) } })
  }
  return calls
}
