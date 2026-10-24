import { loadRegionScheme, type MapRegionIndex } from '../../../packages/maps/src/index.ts'
import type { CommandContext } from './commands.ts'

let ice: Promise<MapRegionIndex> | undefined
export async function bindDefaultMap(ctx: Pick<CommandContext, 'runtime' | 'mapRegions' | 'mapSessionKey'>): Promise<void> {
  const key = ctx.runtime.battleKey
  if (!ctx.runtime.snapshot || (ctx.mapRegions && ctx.mapSessionKey === key)) return
  // 当前产品配置只使用冰天雪地；这是默认配置，不根据地图尺寸猜测名称。
  ice ??= loadRegionScheme(new URL('../../../maps/ice/schemes/nanwang-0.1.0.json', import.meta.url)).catch(error => { ice = undefined; throw error })
  const regions = await ice
  if (ctx.runtime.battleKey !== key) throw new Error('对局已变化，分区绑定取消')
  ctx.mapRegions = regions
  ctx.mapSessionKey = key
}
