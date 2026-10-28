import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { MapRegionIndex, loadRegionScheme, PlayableAreaIndex, loadPlayableArea, StaticObstacleIndex, loadStaticObstacles, type MapPoint, type RegionScheme } from '../packages/maps/src/index.ts'

const url = new URL('../maps/ice/schemes/nanwang-0.1.0.json', import.meta.url)
const scheme: RegionScheme = JSON.parse(await readFile(url, 'utf8'))
const index = await loadRegionScheme(url)

test('冰天雪地静态补丁排除实际树石周围九格，地图来源不符或数据重复时拒绝加载', async () => {
  const file = new URL('../maps/ice/static-obstacles.json', import.meta.url)
  const obstacles = await loadStaticObstacles(file, scheme.map)
  assert.equal(obstacles.clear3x3(129, 86), false, '最新反馈中的集结点旁有 TREE11')
  assert.equal(obstacles.clear3x3(100, 59), false, 'OverlayPack 中的 TROCK04')
  assert.equal(obstacles.clear3x3(99, 58), false, '周围八格也排除')
  assert.equal(obstacles.clear3x3(0, 50), false)
  const data = JSON.parse(await readFile(file, 'utf8'))
  assert.throws(() => new StaticObstacleIndex(data, { ...scheme.map, sha256: 'other' }), /不匹配/)
  data.cells.push(data.cells[0])
  assert.throws(() => new StaticObstacleIndex(data, scheme.map), /重复/)
})

test('原生地形有效范围排除图外边缘，地图哈希不匹配时拒绝混用', async () => {
  const file = new URL('../maps/ice/playable-area.json', import.meta.url), area = await loadPlayableArea(file, scheme.map)
  assert.equal(area.contains(54, 54), false) // 本局反复下达但引擎范围外的北侧落点。
  assert.equal(area.contains(56, 56), true)
  assert.equal(area.contains(84, 168), false)
  assert.equal(area.contains(85, 168), true)
  assert.equal(area.contains(-1, -1), false)
  const value = JSON.parse(await readFile(file, 'utf8'))
  assert.throws(() => new PlayableAreaIndex(value, { ...scheme.map, sha256: 'other' }), /不匹配/)
})

test('当前分区文件可读取、按名称查询，图片与地图坐标可转换', () => {
  assert.ok(index.scheme.regions.length > 0)
  for (const region of index.scheme.regions) {
    assert.equal(index.resolve(region.name)?.id, region.id)
    assert.equal(index.regionAt(...region.labelPosition)?.id, region.id)
    const actual = index.fromImage(...index.toImage(...region.labelPosition))
    assert.ok(Math.abs(actual[0] - region.labelPosition[0]) < 1e-9)
    assert.ok(Math.abs(actual[1] - region.labelPosition[1]) < 1e-9)
  }
  // 该版本图片的已核对参考点，避免仅靠往返运算掩盖整体偏移。
  assert.deepEqual(index.fromImage(2520, 1590), [100, 100])
  assert.deepEqual(index.regionsAt(-1, -1), [])
})

function area(ring: MapPoint[]) {
  let sum = 0
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1]!, b = ring[i]!
    sum += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(sum / 2)
}

test('当前分区覆盖底图，抽样检查内部没有空洞或重叠', () => {
  const [a, b, , d, e] = scheme.projection.gameToPixel
  const imageArea = scheme.source.width * scheme.source.height / Math.abs(a * e - b * d)
  const total = scheme.regions.flatMap(r => r.polygons).reduce((sum, p) => sum + area(p.outer) - p.holes.reduce((s, h) => s + area(h), 0), 0)
  assert.ok(Math.abs(total - imageArea) < 1e-3)
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 20; col++) {
      const x = scheme.source.width * (col + 0.37) / 20
      const y = scheme.source.height * (row + 0.41) / 12
      assert.equal(index.regionsAt(...index.fromImage(x, y)).length, 1, '像素 (' + x + ', ' + y + ')')
    }
  }
})

function fixture() {
  const data = structuredClone(scheme)
  data.regions = [{ id: 'concave', name: '凹区', aliases: ['L区'], level: 1, labelPosition: [11, 11],
    polygons: [{ outer: [[10, 10], [20, 10], [20, 15], [15, 15], [15, 20], [10, 20], [10, 10]], holes: [] }] }]
  return data
}

test('异形区域保留孔洞，共享边界能查询到相邻区域', () => {
  const data = fixture()
  data.regions[0]!.polygons.push({ outer: [[30, 30], [40, 30], [40, 40], [30, 40], [30, 30]],
    holes: [[[32, 32], [38, 32], [38, 38], [32, 38], [32, 32]]] })
  data.regions.push({ id: 'other', name: '相邻区', aliases: [], level: 1, labelPosition: [21, 11],
    polygons: [{ outer: [[20, 10], [25, 10], [25, 15], [20, 15], [20, 10]], holes: [] }] })
  const map = new MapRegionIndex(data)
  assert.equal(map.resolve(' L区 ')?.id, 'concave')
  assert.equal(map.regionAt(12, 18)?.id, 'concave')
  assert.equal(map.regionAt(18, 18), undefined)
  assert.equal(map.regionAt(31, 31)?.id, 'concave')
  assert.equal(map.regionAt(35, 35), undefined)
  assert.deepEqual(map.regionsAt(20, 12).map(r => r.id), ['concave', 'other'])
  assert.equal(map.regionAt(20, 12), undefined)
})

test('损坏的分区边界和重复区域能在读取时发现', () => {
  for (const mutate of [
    (v: RegionScheme) => { v.regions.push(structuredClone(v.regions[0]!)) },
    (v: RegionScheme) => { v.regions[0]!.polygons[0]!.outer[0] = [NaN, 1] },
    (v: RegionScheme) => { v.regions[0]!.polygons[0]!.outer.pop() },
  ]) {
    const data = fixture()
    mutate(data)
    assert.throws(() => new MapRegionIndex(data))
  }
})
