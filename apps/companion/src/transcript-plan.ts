import type { CapabilityCall } from '@ra2c/command'
import type { MapRegionIndex } from '../../../packages/maps/src/index.ts'
import { chineseNumber, normalizeName } from './capabilities/selectors.ts'

/** 保留两类已修复故障的纠正，不增加按中文句子的特殊规则。参数类型来自 Markdown。 */
export function normalizeOperations(text: string, operations: CapabilityCall[], map?: MapRegionIndex): CapabilityCall[] {
  const raw = normalizeName(text)
  const match = raw.match(/(?:编入|编到|归入|加入)([\d一二三四五六七八九十两]+)队/) ?? raw.match(/([\d一二三四五六七八九十两]+)队/)
  const formationId = match ? `${chineseNumber(match[1]!)}队` : undefined
  if (!formationId) return operations
  const productionText = raw.replace(/(?:不要|别|无需|不用|禁止)(?:再)?(?:生产|制造|造|出兵)/g, '')
  if (/编入|编到|归入|加入/.test(raw) && /坦克/.test(raw) && !/制造|生产|建造|新造|再造|补足|补齐|(?:造|出).{0,8}坦克/.test(productionText)) {
    const count = raw.match(/([\d一二三四五六七八九十两]+)(?:个|辆|台)?(?:灰熊|犀牛|天启)?坦克/)
    const quantity = /所有|全部|全体/.test(raw) || !count ? 'all' : chineseNumber(count[1]!)
    const rest = operations.filter(operation => !(operation.capability === 'formation.assign' && operation.params.formationId === formationId)
      && !(operation.capability === 'production.produce' && (operation.params.formationId === formationId || /MTNK|HTNK|LTNK|APOC|MGTK|坦克|tank/i.test(operation.params.target))))
    return [...rest, { capability: 'formation.assign', params: { selector: 'tanks', quantity, formationId } }]
  }
  if (/摧毁|消灭|清理|清除|扫清|攻击/.test(raw)) {
    const region = map?.scheme.regions.slice().sort((a, b) => b.name.length - a.name.length).find(region => [region.name, ...region.aliases].some(name => raw.includes(normalizeName(name))))
    if (region) return [...operations.filter(operation => !(operation.capability === 'combat.attack-all' || ((operation.capability === 'combat.move' || operation.capability === 'combat.clear-region') && operation.params.formationId === formationId))), { capability: 'combat.clear-region', params: { formationId, regionName: region.name } }]
    return operations.map(operation => operation.capability === 'combat.attack-all' ? { ...operation, params: { ...operation.params, formationId } } : operation)
  }
  return operations
}
