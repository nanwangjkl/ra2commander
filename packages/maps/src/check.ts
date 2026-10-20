import { loadRegionScheme } from './index.ts'

const [file, rx, ry] = process.argv.slice(2)
try {
  if ((rx === undefined) !== (ry === undefined) || (rx !== undefined && (!Number.isFinite(Number(rx)) || !Number.isFinite(Number(ry))))) throw new Error('用法：maps:check [分区文件] [rx ry]')
  const index = await loadRegionScheme(file ?? new URL('../../../maps/ice/schemes/nanwang-0.1.0.json', import.meta.url))
  const { map, scheme, regions, projection } = index.scheme
  console.log(`${map.name} / ${scheme.id}@${scheme.version}：${regions.length} 个区域`)
  console.log(regions.map(r => r.name).join('、'))
  console.log(`坐标核对：${projection.validation.status}；实机验证：${projection.validation.realGameVerified ? '已完成' : '待完成'}`)
  if (rx !== undefined) console.log(`(${rx}, ${ry}) → ${index.regionsAt(Number(rx), Number(ry)).map(r => r.name).join(' / ') || '分区图外'}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
