import { loadPrompts, type GameProfile, type ResolvedCapabilityParameters } from '@ra2c/command'
import type { Snapshot } from '@ra2c/contracts'
import type { WerhdBridge } from '@ra2c/game-werhd'
import type { FactorySite } from '@ra2c/runtime'
import type { BindingContext, BoundCapability } from './capabilities/bindings.ts'
import { destination, normalizeName, selectUnitSet } from './capabilities/selectors.ts'

/** 本局工厂类别优先；art.ini 占地只作几何事实，不猜测缺失型号。 */
export async function readFactorySites(bridge: Pick<WerhdBridge, 'rulesMany'>, snap: Snapshot, game: GameProfile = loadPrompts().game): Promise<FactorySite[]> {
  const buildings = snap.self.filter(unit => unit.type === 2)
  const rules = await bridge.rulesMany([...new Map(buildings.map(unit => [unit.name, { name: unit.name, type: 2 }])).values()], snap.sessionKey)
  return buildings.map(unit => {
    const rule = rules.find(item => item.name === unit.name)?.rule as { factory?: number; naval?: boolean; undeploysInto?: string } | undefined
    const foundation = game.entry(unit.name)?.foundation
    return { id: unit.id, name: unit.name, x: unit.rx, y: unit.ry, ...(unit.elevation !== undefined ? { elevation: unit.elevation } : {}), ...(foundation ? { foundation } : {}), factory: rule?.undeploysInto ? 0 : rule?.factory === 3 && rule.naval ? 4 : rule?.factory ?? 0 }
  })
}

export async function bindFactoryRally(params: ResolvedCapabilityParameters['production.rally'], context: BindingContext): Promise<BoundCapability> {
  const { ctx } = context, catalog = await context.catalog(), snap = ctx.runtime.snapshot!
  const sites = await ctx.runtime.factoryRallies.sites(snap); context.check()
  const supported = new Set(sites.filter(site => [2, 3, 4].includes(site.factory)).map(site => site.id))
  const vehicles = !params.unitIds && (context.game.roleForAlias(params.selector) === 'warFactory' || params.selector === 'warFactory')
  const selector = vehicles || ['all', '所有', '全部'].includes(params.selector) ? 'building' : params.selector
  const { selected } = selectUnitSet(ctx, { ...params, selector }, catalog, context.game, { eligible: unit => supported.has(unit.id) && (!vehicles || sites.find(site => site.id === unit.id)!.factory === 3) })
  if (!selected.length) throw new Error('没有匹配的现有己方生产建筑，未追加建设')
  const point = params.regionName || params.x !== undefined || params.y !== undefined ? await destination(ctx, params, context.check, catalog) : undefined
  if (!point && selected.some(unit => ![2, 3].includes(sites.find(site => site.id === unit.id)!.factory))) throw new Error('船厂请指定集结分区或地图格坐标')
  context.check()
  const region = params.regionName ? ctx.mapRegions?.resolve(normalizeName(params.regionName)) : undefined
  const results = await ctx.runtime.factoryRallies.configure(selected.map(unit => unit.id), point, context.commandId, context.check, region ? { id: region.id, name: region.name, polygons: structuredClone(region.polygons) } : undefined)
  const succeeded = results.filter(result => result.status === 'submitted')
  const skipped = results.filter(result => result.status !== 'submitted').map(result => `${result.name} #${result.factoryId}：${result.reason ?? '设置回执未知，未自动重发'}`)
  if (!succeeded.length) throw new Error(skipped.join('；'))
  return { choices: succeeded.map(result => `${result.name} #${result.factoryId} 集结点设置指令已提交至${params.regionName ?? `(${result.point!.x},${result.point!.y})`}，用于后续出厂单位`), ...(skipped.length ? { skipped } : {}) }
}
