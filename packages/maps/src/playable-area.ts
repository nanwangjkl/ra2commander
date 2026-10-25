import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

interface PlayableArea {
  schemaVersion: 1
  coordinateSystem: 'ra2-rxry'
  map: { id: string; sha256: string }
  generator: 'ra2web-map-bounds-v1'
  width: number
  height: number
  displayBounds: { x: number; y: number; width: number; height: number }
  /** 每段为 y、起始 x、结束 x，含两端。只表示引擎有效范围，不保证地块可通行。 */
  runs: Array<[number, number, number]>
}

export class PlayableAreaIndex {
  readonly hash: string
  readonly width: number
  readonly height: number
  private readonly rows = new Map<number, Array<[number, number]>>()
  constructor(value: unknown, map: { id: string; sha256: string }) {
    const area = value as PlayableArea
    if (!area || area.schemaVersion !== 1 || area.coordinateSystem !== 'ra2-rxry' || area.generator !== 'ra2web-map-bounds-v1' || area.map?.id !== map.id || area.map.sha256 !== map.sha256 || !Number.isSafeInteger(area.width) || !Number.isSafeInteger(area.height) || area.width < 1 || area.height < 1 || !Array.isArray(area.runs) || !area.runs.length) throw new Error('地图有效范围来源或结构不匹配')
    this.width = area.width; this.height = area.height
    for (const run of area.runs) {
      if (!Array.isArray(run) || run.length !== 3 || run.some(value => !Number.isSafeInteger(value))) throw new Error('地图有效范围行段非法')
      const [y, x1, x2] = run
      if (y < 0 || y >= area.height || x1 < 0 || x1 > x2 || x2 >= area.width) throw new Error('地图有效范围越界')
      const row = this.rows.get(y) ?? []
      if (row.some(([a, b]) => x1 <= b && x2 >= a)) throw new Error('地图有效范围重复')
      row.push([x1, x2]); this.rows.set(y, row)
    }
    this.hash = createHash('sha256').update(JSON.stringify(area)).digest('hex')
  }
  contains(x: number, y: number): boolean {
    return Number.isSafeInteger(x) && Number.isSafeInteger(y) && !!this.rows.get(y)?.some(([x1, x2]) => x >= x1 && x <= x2)
  }
}

export async function loadPlayableArea(path: URL, map: { id: string; sha256: string }): Promise<PlayableAreaIndex> {
  return new PlayableAreaIndex(JSON.parse(await readFile(path, 'utf8')), map)
}
