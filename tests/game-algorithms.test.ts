import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { createGameAlgorithms, inTargetRegion, placementDirection, crushCompatible, type TargetRegion } from '../packages/contracts/src/index.ts'
import { snapshot } from './helpers.ts'

test('共享算法脱离 Node 与模块全局也能注入，保留区域孔洞边界、画面高差和碾压条件', () => {
  const browser = runInNewContext(`(${createGameAlgorithms.toString()})()`, {}) as ReturnType<typeof createGameAlgorithms>
  const region: TargetRegion = { id: 'area', name: '区域', polygons: [{ outer: [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], holes: [[[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]] }] }
  for (const algorithms of [{ inTargetRegion, placementDirection, crushCompatible }, browser]) {
    assert.equal(algorithms.inTargetRegion(3, 3, region), false)
    assert.equal(algorithms.inTargetRegion(2, 3, region), true, '孔洞边界仍属区域')
    assert.equal(algorithms.inTargetRegion(0, 5, region), true)
    assert.equal(algorithms.inTargetRegion(-1, 5, region), false)
    assert.equal(algorithms.placementDirection({ x: 50, y: 50 }, { x: 52, y: 52, elevation: 4 }), 'up')
    const unit = snapshot().self[0]!, target = { ...snapshot().enemies[0]!, name: 'E1', type: 3, zone: 0, hitPoints: 10 }
    const rules = { attackers: ['MTNK'], targets: ['E1'] }
    assert.equal(algorithms.crushCompatible(unit, target, rules), true)
    assert.equal(algorithms.crushCompatible(unit, { ...target, onBridge: true }, rules), false)
    assert.equal(algorithms.crushCompatible(unit, { ...target, zone: 1 }, rules), false)
    assert.equal(algorithms.crushCompatible(unit, { ...target, hitPoints: 0 }, rules), false)
  }
})
