import type { BuildingPlacement, PlacementDirection, TargetRegion } from '@ra2c/contracts'
import type { BindingContext } from './capabilities/bindings.ts'
import { normalizeName, regionDestination } from './capabilities/selectors.ts'

/** 分区要求独立于方位；兼容旧理解仅传 placementAnchor=一楼 的命令。 */
export async function bindPlacementRegion(params: { placementRegion?: string; placementAnchor?: string; placementDirections?: PlacementDirection[] }, context: BindingContext): Promise<TargetRegion | undefined> {
  const name = params.placementRegion ?? (!params.placementDirections && params.placementAnchor && context.ctx.mapRegions?.resolve(normalizeName(params.placementAnchor)) ? params.placementAnchor : undefined)
  if (!name) return undefined
  const { region } = await regionDestination(context.ctx, name, context.check)
  return { id: region.id, name: region.name, polygons: structuredClone(region.polygons) }
}

/** 只绑定明确的方位；没有该字段时不读取/推测建筑位置。 */
export async function bindBuildingPlacement(params: { placementDirections?: PlacementDirection[]; placementAnchor?: string; quantity: number }, context: BindingContext): Promise<BuildingPlacement | undefined> {
  if (!params.placementDirections) return undefined
  const catalog = await context.catalog(), snap = context.ctx.runtime.snapshot!
  const reference = params.placementAnchor ?? '基地', normalized = normalizeName(reference)
  const baseReference = /^(?:我方)?(?:基地|家|建造厂|主基地)$/.test(normalized)
  const units = [...snap.self].sort((a, b) => a.id - b.id)
  const rule = baseReference ? undefined : catalog.resolve(reference)
  let unit = rule && units.find(unit => unit.name === rule.name && unit.type === 2)
  if (!unit && baseReference) unit = units.find(unit => catalog.isRole(unit.name, 'constructionYard', unit.type)) ?? units.find(unit => catalog.isRole(unit.name, 'constructionVehicle', unit.type))
  let anchor: BuildingPlacement['anchor'] | undefined = unit ? { x: unit.rx, y: unit.ry, elevation: unit.elevation ?? 0, name: baseReference ? '基地' : reference } : undefined
  if (!anchor && !baseReference && context.ctx.mapRegions?.resolve(normalized)) {
    const { destination } = await regionDestination(context.ctx, reference, context.check)
    anchor = { x: destination.x, y: destination.y, name: reference }
  }
  if (!anchor) {
    const base = units.find(unit => catalog.isRole(unit.name, 'constructionYard', unit.type)) ?? units.find(unit => catalog.isRole(unit.name, 'constructionVehicle', unit.type)) ?? units.find(unit => unit.type === 2)
    if (!base) throw new Error('当前没有可作为建筑方位参照的基地或建筑')
    anchor = { x: base.rx, y: base.ry, elevation: base.elevation ?? 0, name: `基地（未找到${reference}，改以${base.name}为参照）` }
  }
  context.check()
  const count = Math.max(params.quantity, params.placementDirections.length)
  return { anchor, directions: Array.from({ length: count }, (_, n) => params.placementDirections![n % params.placementDirections!.length]!) }
}
