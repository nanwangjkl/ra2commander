import { readFile } from 'node:fs/promises'

/** 地图原生格子坐标；不是屏幕像素或经纬度。 */
export type MapPoint = [number, number]
export interface MapPolygon { outer: MapPoint[]; holes: MapPoint[][] }
export interface MapRegion {
  id: string
  name: string
  aliases: string[]
  /** 玩家使用的楼层分组，不等于引擎地形高度。 */
  level: number
  /** 标注文字的位置，仅用于显示，不保证适合作为移动目标。 */
  labelPosition: MapPoint
  polygons: MapPolygon[]
}
export interface RegionScheme {
  schemaVersion: 1
  map: {
    id: string; name: string; sourceFile: string; sha256: string
    fullSize: [number, number, number, number]
    localSize: [number, number, number, number]
    coordinateRange: MapPoint
  }
  scheme: { id: string; version: string; title: string }
  source: {
    image: string; sha256: string; width: number; height: number
    boundaryColor: string; labelColor: string; analysisScale: number
  }
  coordinateSystem: 'ra2-rxry'
  projection: {
    kind: 'isometric-flat'
    /** 两行三列：px=a*rx+b*ry+c，py=d*rx+e*ry+f。 */
    gameToPixel: [number, number, number, number, number, number]
    validation: {
      status: 'native-terrain-verified' | 'unverified'
      nativeCliffEdges: number
      edgesOnAnnotation: number
      controlPoints: Array<{ game: MapPoint; image: MapPoint }>
      textureAlignment?: {
        samples: number; bestOffsetCorrection: MapPoint; score: number
        quadrants: Array<{ quadrant: number; samples: number; best: Array<[number, number, number]> }>
      }
      realGameVerified: boolean
    }
  }
  boundaryRule: 'stroke-centre-manhattan'
  regions: MapRegion[]
}

type Obj = Record<string, unknown>
function object(value: unknown, path: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} 必须为对象`)
  return value as Obj
}
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message) }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }
function normalize(value: string) { return value.normalize('NFKC').trim() }
function tuple(value: unknown, count: number, path: string): asserts value is number[] {
  check(Array.isArray(value) && value.length === count && value.every(finite), `${path} 必须包含 ${count} 个有限数值`)
}
function same(a: MapPoint, b: MapPoint) { return a[0] === b[0] && a[1] === b[1] }
function ringArea(ring: MapPoint[]) {
  let area = 0
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1]!, b = ring[i]!
    area += a[0] * b[1] - b[0] * a[1]
  }
  return area / 2
}

/** 基础结构与标识校验；完整覆盖/拓扑关系由导入检查和数据回归验证。 */
export function parseRegionScheme(value: unknown): RegionScheme {
  const root = object(value, 'scheme')
  check(root.schemaVersion === 1, '不支持的分区格式版本')
  check(root.coordinateSystem === 'ra2-rxry', '分区必须使用 ra2-rxry 坐标')
  check(root.boundaryRule === 'stroke-centre-manhattan', '不支持的边界规则')
  const map = object(root.map, 'map'), scheme = object(root.scheme, 'scheme'), source = object(root.source, 'source')
  for (const [obj, keys] of [[map, ['id', 'name', 'sourceFile']], [scheme, ['id', 'version', 'title']], [source, ['image']]] as const) {
    for (const key of keys) check(nonempty(obj[key]), `${key} 不得为空`)
  }
  check(typeof scheme.version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(scheme.version), '分区方案版本须为语义版本号')
  for (const obj of [map, source]) check(typeof obj.sha256 === 'string' && /^[a-f0-9]{64}$/.test(obj.sha256), '来源 SHA-256 无效')
  tuple(map.fullSize, 4, 'map.fullSize'); tuple(map.localSize, 4, 'map.localSize'); tuple(map.coordinateRange, 2, 'map.coordinateRange')
  check([...map.fullSize, ...map.localSize, ...map.coordinateRange].every(v => Number.isInteger(v) && v >= 0), '地图尺寸必须为非负整数')
  check(map.fullSize[2]! > 0 && map.fullSize[3]! > 0 && map.localSize[2]! > 0 && map.localSize[3]! > 0 && map.coordinateRange.every(v => v > 0), '地图尺寸不得为零')
  for (const key of ['width', 'height', 'analysisScale']) check(Number.isInteger(source[key]) && (source[key] as number) > 0, `${key} 必须为正整数`)
  for (const key of ['boundaryColor', 'labelColor']) check(typeof source[key] === 'string' && /^#[a-f0-9]{6}$/i.test(source[key]), `${key} 颜色无效`)
  const projection = object(root.projection, 'projection')
  check(projection.kind === 'isometric-flat', '不支持的投影类型')
  tuple(projection.gameToPixel, 6, 'projection.gameToPixel')
  const [a, b, , d, e] = projection.gameToPixel
  check(Math.abs(a! * e! - b! * d!) > 1e-12, '坐标映射不可逆')
  const validation = object(projection.validation, 'projection.validation')
  check(validation.status === 'native-terrain-verified' || validation.status === 'unverified', '校准状态无效')
  check(typeof validation.realGameVerified === 'boolean', '缺少实机验证状态')
  for (const key of ['nativeCliffEdges', 'edgesOnAnnotation']) check(Number.isInteger(validation[key]) && (validation[key] as number) >= 0, `${key} 无效`)
  check((validation.edgesOnAnnotation as number) <= (validation.nativeCliffEdges as number), '轮廓统计无效')
  check(Array.isArray(validation.controlPoints), 'controlPoints 必须为数组')
  for (const point of validation.controlPoints) {
    const cp = object(point, 'controlPoint')
    tuple(cp.game, 2, 'controlPoint.game'); tuple(cp.image, 2, 'controlPoint.image')
  }
  if (validation.textureAlignment !== undefined) {
    const texture = object(validation.textureAlignment, 'textureAlignment')
    check(Number.isInteger(texture.samples) && (texture.samples as number) > 0, '纹理样本数无效')
    tuple(texture.bestOffsetCorrection, 2, 'textureAlignment.bestOffsetCorrection')
    check(finite(texture.score) && texture.score >= 0 && texture.score <= 1, '纹理采样分数无效')
    check(Array.isArray(texture.quadrants), '纹理象限数据无效')
    for (const value of texture.quadrants) {
      const quadrant = object(value, 'quadrant')
      check(Number.isInteger(quadrant.quadrant) && (quadrant.quadrant as number) >= 0 && (quadrant.quadrant as number) <= 3, '象限编号无效')
      check(Number.isInteger(quadrant.samples) && (quadrant.samples as number) > 0 && Array.isArray(quadrant.best) && quadrant.best.length > 0, '象限采样数据无效')
      for (const value of quadrant.best) tuple(value, 3, 'quadrant.best')
    }
  }
  check(Array.isArray(root.regions) && root.regions.length > 0, '分区不得为空')
  const ids = new Set<string>(), names = new Map<string, string>()
  for (const value of root.regions) {
    const region = object(value, 'region')
    check(nonempty(region.id) && nonempty(region.name), '区域必须有 id 和名称')
    check(!ids.has(region.id), `重复区域 id：${region.id}`); ids.add(region.id)
    check(Array.isArray(region.aliases) && region.aliases.every(nonempty), `${region.name} 别名必须为非空字符串数组`)
    for (const name of [region.id, region.name, ...region.aliases]) {
      const key = normalize(name), previous = names.get(key)
      check(!previous || previous === region.id, `区域名称或别名冲突：${name}`)
      names.set(key, region.id)
    }
    check(Number.isInteger(region.level) && (region.level as number) >= 1, `${region.name} 楼层无效`)
    tuple(region.labelPosition, 2, `${region.name}.labelPosition`)
    check(Array.isArray(region.polygons) && region.polygons.length > 0, `${region.name} 缺少多边形`)
    for (const value of region.polygons) {
      const part = object(value, `${region.name}.polygon`)
      check(Array.isArray(part.holes), `${region.name}.holes 必须为数组`)
      for (const value of [part.outer, ...part.holes]) {
        check(Array.isArray(value) && value.length >= 4, `${region.name} 边界顶点不足`)
        for (const point of value) {
          tuple(point, 2, `${region.name}.point`)
          check(point[0]! >= 0 && point[0]! <= map.coordinateRange[0]! && point[1]! >= 0 && point[1]! <= map.coordinateRange[1]!, `${region.name} 顶点超出地图索引范围`)
        }
        const ring = value as MapPoint[]
        check(same(ring[0]!, ring.at(-1)!), `${region.name} 边界未闭合`)
        check(Math.abs(ringArea(ring)) > 1e-9, `${region.name} 边界面积为零`)
        for (let i = 1; i < ring.length; i++) check(!same(ring[i - 1]!, ring[i]!), `${region.name} 存在重复相邻顶点`)
      }
    }
  }
  return value as RegionScheme
}

/** -1=外部，0=边界，1=内部；边界也计入区域，调用者可取得全部相邻区域。 */
function pointInRing(point: MapPoint, ring: MapPoint[]): -1 | 0 | 1 {
  const [x, y] = point
  let inside = false
  for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1]!, [bx, by] = ring[i]!
    const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax)
    const epsilon = 1e-7 * Math.max(1, Math.hypot(bx - ax, by - ay))
    if (Math.abs(cross) <= epsilon && x >= Math.min(ax, bx) - 1e-7 && x <= Math.max(ax, bx) + 1e-7 && y >= Math.min(ay, by) - 1e-7 && y <= Math.max(ay, by) + 1e-7) return 0
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside
  }
  return inside ? 1 : -1
}
function contains(point: MapPoint, polygon: MapPolygon) {
  if (pointInRing(point, polygon.outer) === -1) return false
  return !polygon.holes.some(ring => pointInRing(point, ring) === 1)
}

export class MapRegionIndex {
  readonly scheme: RegionScheme
  private readonly names = new Map<string, MapRegion>()
  private readonly polygons: Array<{ region: MapRegion; polygon: MapPolygon; minX: number; minY: number; maxX: number; maxY: number }> = []

  constructor(value: unknown) {
    this.scheme = parseRegionScheme(value)
    for (const region of this.scheme.regions) {
      for (const name of [region.id, region.name, ...region.aliases]) this.names.set(normalize(name), region)
      for (const polygon of region.polygons) {
        const xs = polygon.outer.map(p => p[0]), ys = polygon.outer.map(p => p[1])
        this.polygons.push({ region, polygon, minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) })
      }
    }
    for (const region of this.scheme.regions) check(this.regionsAt(...region.labelPosition).some(r => r.id === region.id), `${region.name} 标签不在本区域内`)
  }

  resolve(name: string): MapRegion | undefined { return this.names.get(normalize(name)) }

  regionsAt(rx: number, ry: number): MapRegion[] {
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) return []
    const found = new Set<MapRegion>()
    for (const p of this.polygons) {
      if (rx >= p.minX - 1e-7 && rx <= p.maxX + 1e-7 && ry >= p.minY - 1e-7 && ry <= p.maxY + 1e-7 && contains([rx, ry], p.polygon)) found.add(p.region)
    }
    return [...found]
  }

  /** 共用边界可能属于多个区域，此时不任意选择其中一个。 */
  regionAt(rx: number, ry: number): MapRegion | undefined {
    const found = this.regionsAt(rx, ry)
    return found.length === 1 ? found[0] : undefined
  }

  toImage(rx: number, ry: number): MapPoint {
    const [a, b, c, d, e, f] = this.scheme.projection.gameToPixel
    return [a * rx + b * ry + c, d * rx + e * ry + f]
  }

  fromImage(px: number, py: number): MapPoint {
    const [a, b, c, d, e, f] = this.scheme.projection.gameToPixel
    const x = px - c, y = py - f, det = a * e - b * d
    return [(e * x - b * y) / det, (a * y - d * x) / det]
  }
}

export async function loadRegionScheme(path: string | URL): Promise<MapRegionIndex> {
  return new MapRegionIndex(JSON.parse(await readFile(path, 'utf8')))
}
