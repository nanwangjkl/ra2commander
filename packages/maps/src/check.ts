import { loadRegionScheme, loadPlayableArea, loadStaticObstacles } from './index.ts'

const [file, rx, ry] = process.argv.slice(2)
try {
  if ((rx === undefined) !== (ry === undefined) || (rx !== undefined && (!Number.isFinite(Number(rx)) || !Number.isFinite(Number(ry))))) throw new Error('用法：maps:check [分区文件] [rx ry]')
  const index = await loadRegionScheme(file ?? new URL('../../../maps/ice/schemes/nanwang-0.1.0.json', import.meta.url))
  const { map, scheme, regions, projection } = index.scheme
  console.log(`${map.name} / ${scheme.id}@${scheme.version}：${regions.length} 个区域`)
  console.log(regions.map(r => r.name).join('、'))
  console.log(`坐标核对：${projection.validation.status}；实机验证：${projection.validation.realGameVerified ? '已完成' : '待完成'}`)
  if (!file) {
    const area = await loadPlayableArea(new URL('../../../maps/ice/playable-area.json', import.meta.url), map)
    console.log(`探索有效范围：${area.width}×${area.height}，来源哈希与原生地图一致`)
    const obstacles = await loadStaticObstacles(new URL('../../../maps/ice/static-obstacles.json', import.meta.url), map)
    if (obstacles.width !== area.width || obstacles.height !== area.height) throw new Error('静态障碍与地图范围不一致')
    console.log(`静态障碍：${obstacles.size} 格，地图、规则与素材来源已记录`)
  }
  if (rx !== undefined) console.log(`(${rx}, ${ry}) → ${index.regionsAt(Number(rx), Number(ry)).map(r => r.name).join(' / ') || '分区图外'}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
