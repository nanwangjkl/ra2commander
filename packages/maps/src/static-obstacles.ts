import { readFile } from 'node:fs/promises'

interface StaticObstacles {
  schemaVersion: 1
  coordinateSystem: 'ra2-rxry'
  generator: 'ra2web-static-obstacles-v1'
  map: { id: string; sha256: string }
  sources: { rules: string; art: string }
  width: number; height: number
  counts: { terrain: number; rockOrWallOverlay: number }
  cells: Array<[number, number]>
}

/** 初始地图的静态补丁；不追踪树石摧毁，也不作为完整寻路数据。 */
export class StaticObstacleIndex {
  private readonly cells = new Set<string>()
  readonly size: number
  readonly width: number
  readonly height: number
  constructor(value: unknown, map: { id: string; sha256: string }) {
    const data = value as StaticObstacles
    const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
    if (!data || data.schemaVersion !== 1 || data.coordinateSystem !== 'ra2-rxry' || data.generator !== 'ra2web-static-obstacles-v1' || data.map?.id !== map.id || data.map.sha256 !== map.sha256 || !hash(data.map.sha256) || !hash(data.sources?.rules) || !hash(data.sources?.art) || !Number.isSafeInteger(data.width) || !Number.isSafeInteger(data.height) || data.width < 1 || data.height < 1 || !Array.isArray(data.cells) || !data.counts || ![data.counts.terrain, data.counts.rockOrWallOverlay].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('静态障碍来源或结构不匹配')
    this.width = data.width; this.height = data.height
    for (const cell of data.cells) {
      if (!Array.isArray(cell) || cell.length !== 2 || !cell.every(Number.isSafeInteger) || cell[0] < 0 || cell[1] < 0 || cell[0] >= data.width || cell[1] >= data.height) throw new Error('静态障碍坐标非法')
      const key = cell.join(',')
      if (this.cells.has(key)) throw new Error('静态障碍坐标重复')
      this.cells.add(key)
    }
    this.size = this.cells.size
    if (this.size > data.counts.terrain + data.counts.rockOrWallOverlay) throw new Error('静态障碍数量非法')
  }
  /** 中心及周围八格均需在地图内且无树石。 */
  clear3x3(x: number, y: number): boolean {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 1 || y < 1 || x >= this.width - 1 || y >= this.height - 1) return false
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (this.cells.has(`${x + dx},${y + dy}`)) return false
    return true
  }
}

export async function loadStaticObstacles(path: URL, map: { id: string; sha256: string }): Promise<StaticObstacleIndex> {
  return new StaticObstacleIndex(JSON.parse(await readFile(path, 'utf8')), map)
}
