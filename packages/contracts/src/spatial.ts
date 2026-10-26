export interface TargetRegion {
  id: string
  name: string
  polygons: Array<{ outer: [number, number][]; holes: [number, number][][] }>
}
export function validTargetRegion(region: TargetRegion): boolean {
  const ring = (value: unknown): boolean => Array.isArray(value) && value.length >= 4 && value.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)) && value[0][0] === value.at(-1)[0] && value[0][1] === value.at(-1)[1]
  return !!region && typeof region.id === 'string' && !!region.id && typeof region.name === 'string' && Array.isArray(region.polygons) && region.polygons.length > 0 && region.polygons.every(polygon => !!polygon && ring(polygon.outer) && Array.isArray(polygon.holes) && polygon.holes.every(ring))
}

/** 边界计入区域，孔洞内部排除；与地图分区的几何规则相同。 */
export function inTargetRegion(x: number, y: number, region: TargetRegion): boolean {
  const ring = (points: [number, number][]): number => {
    let inside = false
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1]!, [bx, by] = points[i]!
      const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax)
      if (Math.abs(cross) <= 1e-7 * Math.max(1, Math.hypot(bx - ax, by - ay)) && x >= Math.min(ax, bx) - 1e-7 && x <= Math.max(ax, bx) + 1e-7 && y >= Math.min(ay, by) - 1e-7 && y <= Math.max(ay, by) + 1e-7) return 0
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside
    }
    return inside ? 1 : -1
  }
  return region.polygons.some(polygon => ring(polygon.outer) !== -1 && !polygon.holes.some(hole => ring(hole) === 1))
}
