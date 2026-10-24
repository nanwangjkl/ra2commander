export interface TargetRegion {
  id: string
  name: string
  polygons: Array<{ outer: [number, number][]; holes: [number, number][][] }>
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
