import type { SnapshotUnit } from './index.ts'
import type { CrushingRules } from './crushing.ts'
import type { PlacementDirection, PlacementPoint } from './placement.ts'
import type { TargetRegion } from './spatial.ts'

/** 同一实现供宿主调用和页面注入。工厂保持自包含，不引用模块值、Node 或游戏 API。 */
export function createGameAlgorithms() {
  const algorithms = {
    ringLocation(x: number, y: number, points: [number, number][]): number {
      let inside = false
      for (let i = 1; i < points.length; i++) {
        const [ax, ay] = points[i - 1]!, [bx, by] = points[i]!
        const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax)
        if (Math.abs(cross) <= 1e-7 * Math.max(1, Math.hypot(bx - ax, by - ay)) && x >= Math.min(ax, bx) - 1e-7 && x <= Math.max(ax, bx) + 1e-7 && y >= Math.min(ay, by) - 1e-7 && y <= Math.max(ay, by) + 1e-7) return 0
        if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside
      }
      return inside ? 1 : -1
    },
    /** 边界计入，孔洞内部排除。 */
    inTargetRegion(x: number, y: number, region: TargetRegion): boolean {
      return region.polygons.some(polygon => algorithms.ringLocation(x, y, polygon.outer) !== -1 && !polygon.holes.some(hole => algorithms.ringLocation(x, y, hole) === 1))
    },
    /** RA2 画面投影：屏幕 x=30(rx-ry)，y=15(rx+ry)-30z。 */
    placementDirection(anchor: PlacementPoint, point: PlacementPoint): PlacementDirection | undefined {
      const dx = point.x - anchor.x, dy = point.y - anchor.y
      const x = dx - dy, y = (dx + dy) / 2 - ((point.elevation ?? 0) - (anchor.elevation ?? 0))
      if (!x && !y) return undefined
      const sectors: PlacementDirection[] = ['right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'up', 'up-right']
      return sectors[(Math.round(Math.atan2(y, x) / (Math.PI / 4)) + 8) % 8]
    },
    /** 策略兵种、地面层、桥面与目标存活共同决定可否碾压。 */
    crushCompatible(unit: SnapshotUnit, target: SnapshotUnit, rules: CrushingRules | undefined): boolean {
      return !!rules && unit.type === 7 && (unit.zone === undefined || unit.zone === 0) && rules.attackers.includes(unit.name)
        && target.type === 3 && (target.zone === undefined || target.zone === 0) && rules.targets.includes(target.name)
        && !!unit.onBridge === !!target.onBridge && (target.hitPoints === undefined || target.hitPoints > 0)
    },
  }
  return { inTargetRegion: algorithms.inTargetRegion, placementDirection: algorithms.placementDirection, crushCompatible: algorithms.crushCompatible }
}

export const gameAlgorithms = createGameAlgorithms()
