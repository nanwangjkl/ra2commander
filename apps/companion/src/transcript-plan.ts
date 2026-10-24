import type { MapRegionIndex } from '../../../packages/maps/src/index.ts'

export type Operation = { kind: 'deploy' } | { kind: 'produce'; target: string; quantity: number; formationId?: string }
  | { kind: 'assign'; target: string; quantity: number | 'all'; formationId: string }
  | { kind: 'move' | 'assaultRegion'; formationId: string; regionName: string }
  | { kind: 'power'; reserve: number } | { kind: 'attackAll'; formationId?: string }

const digits = '零一二三四五六七八九'
function number(value: string): number {
  if (/^\d+$/.test(value)) return Number(value)
  if (value === '两') return 2
  if (value.includes('十')) { const [tens, ones] = value.split('十'); return (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0) }
  return digits.indexOf(value)
}
const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').replace(/([1-9])楼/g, (_match, n: string) => `${digits[Number(n)]}楼`)

/** 纠正已知的操作类别错配，不增加模型往返，也不把歧义变成确认步骤。 */
export function normalizeOperations(text: string, operations: Operation[], map?: MapRegionIndex): Operation[] {
  const raw = normalize(text)
  const match = raw.match(/(?:编入|编到|归入|加入)([\d一二三四五六七八九十两]+)队/) ?? raw.match(/([\d一二三四五六七八九十两]+)队/)
  const formationId = match ? `${number(match[1]!)}队` : undefined
  if (!formationId) return operations
  const productionText = raw.replace(/(?:不要|别|无需|不用|禁止)(?:再)?(?:生产|制造|造|出兵)/g, '')
  if (/编入|编到|归入|加入/.test(raw) && /坦克/.test(raw) && !/制造|生产|建造|新造|再造|补足|补齐|(?:造|出).{0,8}坦克/.test(productionText)) {
    const count = raw.match(/([\d一二三四五六七八九十两]+)(?:个|辆|台)?(?:灰熊|犀牛|天启)?坦克/)
    const quantity = /所有|全部|全体/.test(raw) || !count ? 'all' : number(count[1]!)
    const rest = operations.filter(operation => operation && !(operation.kind === 'assign' && operation.formationId === formationId)
      && !(operation.kind === 'produce' && (operation.formationId === formationId || /MTNK|HTNK|LTNK|APOC|MGTK|坦克|tank/i.test(operation.target))))
    return [...rest, { kind: 'assign', target: 'tanks', quantity, formationId }]
  }
  if (/摧毁|消灭|清理|清除|扫清|攻击/.test(raw)) {
    const region = map?.scheme.regions.slice().sort((a, b) => b.name.length - a.name.length).find(region => [region.name, ...region.aliases].some(name => raw.includes(normalize(name))))
    if (region) return [...operations.filter(operation => operation && !(operation.kind === 'attackAll' || ((operation.kind === 'move' || operation.kind === 'assaultRegion') && operation.formationId === formationId))), { kind: 'assaultRegion', formationId, regionName: region.name }]
    return operations.map(operation => operation?.kind === 'attackAll' ? { ...operation, formationId } : operation)
  }
  return operations
}
