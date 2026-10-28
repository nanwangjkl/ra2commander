import { loadRegionScheme, loadPlayableArea, loadStaticObstacles, type MapRegionIndex, type PlayableAreaIndex, type StaticObstacleIndex } from '../../../packages/maps/src/index.ts'
import type { CommandContext } from './commands.ts'

let ice: Promise<MapRegionIndex> | undefined
let iceArea: Promise<PlayableAreaIndex> | undefined
let iceObstacles: Promise<StaticObstacleIndex> | undefined
export async function loadIceMap(): Promise<{ regions: MapRegionIndex; area: PlayableAreaIndex; obstacles: StaticObstacleIndex }> {
  ice ??= loadRegionScheme(new URL('../../../maps/ice/schemes/nanwang-0.1.0.json', import.meta.url)).catch(error => { ice = undefined; throw error })
  const regions = await ice
  iceArea ??= loadPlayableArea(new URL('../../../maps/ice/playable-area.json', import.meta.url), regions.scheme.map).catch(error => { iceArea = undefined; throw error })
  iceObstacles ??= loadStaticObstacles(new URL('../../../maps/ice/static-obstacles.json', import.meta.url), regions.scheme.map).catch(error => { iceObstacles = undefined; throw error })
  const [area, obstacles] = await Promise.all([iceArea, iceObstacles])
  if (obstacles.width !== area.width || obstacles.height !== area.height) throw new Error('静态障碍与地图范围不一致')
  return { regions, area, obstacles }
}
export async function bindDefaultMap(ctx: Pick<CommandContext, 'runtime' | 'mapRegions' | 'mapSessionKey' | 'mapPlayableArea'>): Promise<void> {
  const key = ctx.runtime.battleKey
  if (!ctx.runtime.snapshot || (ctx.mapRegions && ctx.mapSessionKey === key)) return
  // 当前产品配置只使用冰天雪地；这是默认配置，不根据地图尺寸猜测名称。
  const { regions, area } = await loadIceMap()
  if (ctx.runtime.battleKey !== key) throw new Error('对局已变化，分区绑定取消')
  ctx.mapRegions = regions
  ctx.mapSessionKey = key
  ctx.mapPlayableArea = area
}
