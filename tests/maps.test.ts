import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { MapRegionIndex, loadRegionScheme, type MapPoint, type RegionScheme } from '../packages/maps/src/index.ts'

const url = new URL('../maps/ice/schemes/nanwang-0.1.0.json', import.meta.url)
const scheme: RegionScheme = JSON.parse(await readFile(url, 'utf8'))
const index = await loadRegionScheme(url)

test('冰天雪地方案读取 17 个稳定命名区域，并记录实际地图和图片版本', () => {
  assert.equal(index.scheme.map.id, 'ra2:mp32s8')
  assert.equal(index.scheme.map.sha256, 'df5419036db3cdfb39de5a6fb9a09c7737a60aad79dbda9431193d92ca460bc1')
  assert.equal(index.scheme.regions.length, 17)
  assert.equal(index.scheme.projection.validation.nativeCliffEdges, 660)
  assert.equal(index.scheme.projection.validation.edgesOnAnnotation, 660)
  assert.equal(index.scheme.projection.validation.realGameVerified, false)
  for (const r of index.scheme.regions) assert.equal(index.regionAt(...r.labelPosition)?.id, r.id)
})

test('像素与 rx/ry 双向映射，图像纵向使用经纹理核对的偏移', () => {
  assert.deepEqual(index.toImage(100, 100), [2520, 1590])
  assert.deepEqual(index.fromImage(2520, 1590), [100, 100])
  for (const p of [[39, 82], [151, 119], [0, 0], [199, 199], [100.25, 88.75]] as MapPoint[]) {
    const actual = index.fromImage(...index.toImage(...p))
    assert.ok(Math.abs(actual[0] - p[0]) < 1e-9 && Math.abs(actual[1] - p[1]) < 1e-9)
  }
})

test('原地图出生点落入对应区域，图外查询为空', () => {
  assert.equal(index.regionAt(39, 82)?.name, '三楼左上')
  assert.equal(index.regionAt(88, 34)?.name, '三楼右上')
  assert.equal(index.regionAt(120, 83)?.name, '小岛')
  assert.deepEqual(index.regionsAt(-1, -1), [])
  assert.deepEqual(index.regionsAt(NaN, 10), [])
})

function area(ring: MapPoint[]) {
  let sum = 0
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1]!, b = ring[i]!
    sum += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(sum / 2)
}

test('真实分区的总面积与画布一致，采样点完整覆盖且内区不重叠', () => {
  const total = scheme.regions.flatMap(r => r.polygons).reduce((sum, p) => sum + area(p.outer) - p.holes.reduce((s, h) => s + area(h), 0), 0)
  assert.ok(Math.abs(total - scheme.source.width * scheme.source.height / 900) < 1e-3)
  let samples = 0
  // Pixel-centred samples lie off the integer raster contour, so each has one owner.
  for (let y = 10.5; y < scheme.source.height; y += 75) {
    for (let x = 10.5; x < scheme.source.width; x += 75) {
      assert.equal(index.regionsAt(...index.fromImage(x, y)).length, 1, `像素 (${x}, ${y})`)
      samples++
    }
  }
  assert.ok(samples > 2000)
})

function fixture() {
  const data = structuredClone(scheme)
  data.regions = [{ id: 'concave', name: '凹区', aliases: ['L区'], level: 1, labelPosition: [11, 11],
    polygons: [{ outer: [[10, 10], [20, 10], [20, 15], [15, 15], [15, 20], [10, 20], [10, 10]], holes: [] }] }]
  return data
}

test('异形、孔洞、多个多边形和别名查询保留原始几何', () => {
  const data = fixture()
  data.regions[0]!.polygons.push({ outer: [[30, 30], [40, 30], [40, 40], [30, 40], [30, 30]],
    holes: [[[32, 32], [38, 32], [38, 38], [32, 38], [32, 32]]] })
  const map = new MapRegionIndex(data)
  assert.equal(map.resolve(' L区 ')?.id, 'concave')
  assert.equal(map.regionAt(12, 18)?.id, 'concave')
  assert.equal(map.regionAt(18, 18), undefined)
  assert.equal(map.regionAt(31, 31)?.id, 'concave')
  assert.equal(map.regionAt(35, 35), undefined)
})

test('共享边界返回全部区域，单区域接口不任意挑选', () => {
  const data = fixture()
  data.regions.push({ id: 'other', name: '相邻区', aliases: [], level: 1, labelPosition: [21, 11],
    polygons: [{ outer: [[20, 10], [25, 10], [25, 15], [20, 15], [20, 10]], holes: [] }] })
  const map = new MapRegionIndex(data)
  assert.deepEqual(map.regionsAt(20, 12).map(r => r.id), ['concave', 'other'])
  assert.equal(map.regionAt(20, 12), undefined)
})

test('格式版本、名称冲突、坐标与闭合边界错误被读取器识别', () => {
  for (const mutate of [
    (v: RegionScheme) => { v.schemaVersion = 2 as 1 },
    (v: RegionScheme) => { v.projection.gameToPixel = [1, 2, 0, 2, 4, 0] },
    (v: RegionScheme) => { v.regions.push(structuredClone(v.regions[0]!)) },
    (v: RegionScheme) => { v.regions[1]!.aliases.push(v.regions[0]!.name) },
    (v: RegionScheme) => { v.regions[0]!.polygons[0]!.outer[0] = [-1, 1] },
    (v: RegionScheme) => { v.regions[0]!.polygons[0]!.outer.pop() },
    (v: RegionScheme) => { v.regions[0]!.labelPosition = [0, 0] },
  ]) {
    const data = structuredClone(scheme)
    mutate(data)
    assert.throws(() => new MapRegionIndex(data))
  }
})
