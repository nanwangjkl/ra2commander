import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import type { ExploreGoal } from '@ra2c/contracts'
import type { ExplorationMap } from '@ra2c/runtime'
import type { CommandContext } from './commands.ts'
import { bindDefaultMap } from './map-binding.ts'

const scopes = new Map<string, Promise<ExplorationMap>>()
/** 分区几何只展开一次，按行让出事件循环；不读取图片或游戏素材。 */
export async function prepareExploration(ctx: CommandContext, goalId: string, regionName: string | undefined, check: () => void): Promise<void> {
  await bindDefaultMap(ctx); check()
  const index = ctx.mapRegions!, snap = ctx.runtime.snapshot!
  const area = ctx.mapPlayableArea
  if (area && (area.width !== snap.mapWidth || area.height !== snap.mapHeight)) throw new Error('地图有效范围与当前对局尺寸不符')
  const selected = regionName ? index.resolve(regionName) : undefined
  if (regionName && !selected) throw new Error(`未找到探索区域：${regionName}`)
  const key = createHash('sha256').update(JSON.stringify(index.scheme)).update(`${snap.mapWidth},${snap.mapHeight}`).update(area?.hash ?? '').digest('hex')
  let scope = scopes.get(key)
  if (!scope) {
    scope = (async () => {
      const regions = index.scheme.regions.map(region => ({ id: region.id, name: region.name, cells: [] as number[] }))
      const byId = new Map(regions.map(region => [region.id, region]))
      for (let y = 0; y < snap.mapHeight; y++) {
        for (let x = 0; x < snap.mapWidth; x++) {
          if (area && !area.contains(x, y)) continue
          for (const region of index.regionsAt(x, y)) byId.get(region.id)!.cells.push(y * snap.mapWidth + x)
        }
        if (y % 8 === 0) await setImmediate()
      }
      return { id: key, mapId: index.scheme.map.id, schemeId: index.scheme.scheme.id, schemeVersion: index.scheme.scheme.version, width: snap.mapWidth, height: snap.mapHeight, regions, seen: [], impassable: [], cursor: 0 }
    })()
    scopes.set(key, scope)
    scope.catch(() => scopes.delete(key))
  }
  const map = await scope; check()
  ctx.runtime.exploration.add(map, goalId, selected ? [selected.id] : map.regions.map(region => region.id))
}

/** 一次仅一个有界页面读取；取消和换局后丢弃迟到结果。不会发单位动作。 */
export class ExplorationObserver {
  private busy = false
  private nextMap = 0
  async poll(ctx: Pick<CommandContext, 'runtime' | 'bridge'>): Promise<void> {
    if (this.busy) return
    const { runtime } = ctx, snapshot = runtime.snapshot
    if (!snapshot) return
    const active = [...runtime.goals.values()].filter(goal => goal.status === 'active' && goal.activeSpec?.kind === 'explore' && runtime.programs.get(goal.ownerId)?.status === 'active')
    const maps = [...new Set(active.map(goal => runtime.exploration.progress.get((goal.activeSpec as ExploreGoal).explorationId)?.mapId).filter((id): id is string => !!id))]
    if (!maps.length) return
    const mapId = maps[this.nextMap++ % maps.length]!, map = runtime.exploration.maps.get(mapId)!
    const cells = runtime.exploration.batch(mapId, 256, snapshot.self.filter(unit => active.some(goal => runtime.formations.ownerOf(unit.id) === (goal.activeSpec as ExploreGoal).formationId)), active.map(goal => goal.spec.id))
    this.busy = true
    try {
      const observation = await ctx.bridge.readMapBatch(cells, map.width, snapshot.sessionKey)
      if (runtime.battleKey === snapshot.sessionKey && active.some(goal => runtime.goals.get(goal.spec.id) === goal && goal.status === 'active')) runtime.exploration.observe(mapId, observation)
    } finally { this.busy = false }
  }
}
