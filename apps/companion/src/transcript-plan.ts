import type { CapabilityCall } from '@ra2c/command'
import type { MapRegionIndex } from '../../../packages/maps/src/index.ts'
import { chineseNumber, formationAlias, normalizeName } from './capabilities/selectors.ts'
import type { GameCatalog } from './game-catalog.ts'

/** 纠正已确认的编队/地域误解；原位替换，保留同句话各操作的先后关系。 */
export function normalizeOperations(text: string, operations: CapabilityCall[], map?: MapRegionIndex, catalog?: GameCatalog): CapabilityCall[] {
  const raw = normalizeName(text)
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
      const count = clause.match(/([\d一二三四五六七八九十两]+)(?:个|辆|台)?(?:灰熊|犀牛|天启)?坦克/)
      const quantity = /所有|全部|全体/.test(clause) || !count ? 'all' : chineseNumber(count[1]!)
      const otherProduction = clauses.some(other => other !== clause && /制造|生产|建造|新造|再造|补足|补齐|(?:造|出).{0,8}坦克/.test(other))
      replace(call => call.capability === 'formation.assign' ? formationAlias(call.params.formationId) === targetId && /tanks|坦克|灰熊|犀牛|天启|^all$/i.test(call.params.selector ?? 'all')
        : call.capability === 'production.produce' && (call.params.formationId ? formationAlias(call.params.formationId) === targetId : !otherProduction)
          && (!!catalog?.resolve(call.params.target)?.roles.includes('tank') || /坦克|tank|MTNK|HTNK|APOC/i.test(call.params.target)),
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
    if (region) replace(call => call.capability === 'combat.attack-all' ? !call.params.formationId || formationAlias(call.params.formationId) === targetId
      : (call.capability === 'combat.move' || call.capability === 'combat.clear-region') && formationAlias(call.params.formationId) === targetId,
    { capability: 'combat.clear-region', params: { formationId: targetId, regionName: region.name } })
    else operations = operations.map(call => call.capability === 'combat.attack-all' && !call.params.formationId ? { ...call, params: { ...call.params, formationId: targetId } } : call)
  }
  return operations
}
