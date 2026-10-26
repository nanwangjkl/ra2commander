export const PLACEMENT_DIRECTIONS = ['up', 'down', 'left', 'right', 'up-left', 'up-right', 'down-left', 'down-right'] as const
export type PlacementDirection = typeof PLACEMENT_DIRECTIONS[number]
export interface PlacementPoint { x: number; y: number; elevation?: number; name?: string }
export interface BuildingPlacement { anchor: PlacementPoint; directions: PlacementDirection[] }
export interface PlacementSlot { id: string; anchor: PlacementPoint; direction: PlacementDirection }
export const directionLabels: Record<PlacementDirection, string> = { up: '上方', down: '下方', left: '左侧', right: '右侧', 'up-left': '左上方', 'up-right': '右上方', 'down-left': '左下方', 'down-right': '右下方' }

/** RA2 画面投影：屏幕 x=30(rx-ry)，y=15(rx+ry)-30z。忽略平移和缩放。 */
export function placementDirection(anchor: PlacementPoint, point: PlacementPoint): PlacementDirection | undefined {
  const dx = point.x - anchor.x, dy = point.y - anchor.y
  const x = dx - dy, y = (dx + dy) / 2 - ((point.elevation ?? 0) - (anchor.elevation ?? 0))
  if (!x && !y) return undefined
  const sectors: PlacementDirection[] = ['right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'up', 'up-right']
  return sectors[(Math.round(Math.atan2(y, x) / (Math.PI / 4)) + 8) % 8]
}
export const matchesPlacement = (slot: Pick<PlacementSlot, 'anchor' | 'direction'>, point: PlacementPoint): boolean => placementDirection(slot.anchor, point) === slot.direction
export function validBuildingPlacement(value: BuildingPlacement, width: number, height: number): boolean {
  return !!value && !!value.anchor && Number.isFinite(value.anchor.x) && Number.isFinite(value.anchor.y) && value.anchor.x >= 0 && value.anchor.y >= 0 && value.anchor.x < width && value.anchor.y < height && (value.anchor.elevation === undefined || Number.isFinite(value.anchor.elevation)) && Array.isArray(value.directions) && value.directions.length > 0 && value.directions.every(direction => PLACEMENT_DIRECTIONS.includes(direction))
}
