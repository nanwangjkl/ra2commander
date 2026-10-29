import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SnapshotUnit } from '../packages/contracts/src/index.ts'
import { loadPrompts } from '../packages/command/src/index.ts'
import { FormationRegistry, persistState, restoreState } from '../packages/runtime/src/index.ts'
import { MapRegionIndex } from '../packages/maps/src/index.ts'
import { loadIceMap } from '../apps/companion/src/map-binding.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { runTranscript } from '../apps/companion/src/transcript.ts'
import { normalizeOperations } from '../apps/companion/src/transcript-plan.ts'
import { loadGameCatalog } from '../apps/companion/src/game-catalog.ts'
import { executeCapabilities } from '../apps/companion/src/capabilities/index.ts'
import { retainBindingScope } from '../apps/companion/src/capabilities/binding-recovery.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { harness, snapshot } from './helpers.ts'

const game = loadPrompts().game
const flak = (id: number): SnapshotUnit => ({ id, name: 'HTK', type: 7, rx: 5, ry: 5, isIdle: true, primaryWeapon: { minRange: 0, maxRange: 8, aa: true, ag: true } })
const flyer = (id: number, x = 6, y = 5): SnapshotUnit => ({ id, name: 'JUMPJET', type: 3, zone: 1, rx: x, ry: y, isIdle: true })
const executor = { run: async () => { throw new Error('持续守卫不应调用脚本执行器') } }
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-guard-targets-'))
  const { runtime, formations, submitted } = await harness(executor, { formations: new FormationRegistry() })
  const own = [flak(1)]
  await runtime.onSnapshot(snapshot({ seq: 2, self: own, enemies: [], mapWidth: 200, mapHeight: 200 }))
  formations.create('2队', [1])
  let requests = 0
  const provider = { generate: async ({ messages }: { messages: Array<{ content: string }> }) => {
    assert.ok('text' in JSON.parse(messages[1]!.content), '只理解命令，不生成守卫脚本')
    requests++
    // 重放最新胜局的错误 assault 模式，并模拟把飞行兵误选成飞机。
    return { text: JSON.stringify({ summary: '监视飞行兵', operations: [{ capability: 'combat.hold', params: { formationId: '2队', mode: 'assault', targetSelectors: ['aircraft'], label: '监视并击落飞行兵' } }] }), model: 'fixture', durationMs: 0 }
  } }
  const ctx = { runtime, formations, currentProvider: () => provider, controller: new ProgramController({ runtime, executor, provider: () => provider as never }), bridge: { rules: async (name: string) => game.entry(name) } } as unknown as CommandContext
  return { root, runtime, formations, submitted, own, ctx, requests: () => requests,
    tick: (enemies: SnapshotUnit[] = []) => runtime.onSnapshot({ ...runtime.snapshot!, self: own, enemies, seq: runtime.snapshot!.seq + 1, tick: runtime.snapshot!.tick + 30 }),
    dispose: () => rmSync(root, { recursive: true, force: true }) }
}

test('监视飞行兵只理解一次：本机识别空中步兵，原地待命、停止离区追击并接入本队补员', async () => {
  const f = await fixture()
  try {
    await runTranscript('2 队监视任何出现的飞行兵，只要出现就干掉', f.ctx, f.root)
    await f.tick()
    const goal = [...f.runtime.goals.values()][0]!
    assert.equal(goal.spec.kind, 'combat')
    if (goal.spec.kind !== 'combat') throw new Error('missing guard')
    assert.equal(goal.spec.executionMode, 'native')
    assert.equal(goal.spec.mode, 'hold')
    assert.ok(goal.spec.objective!.target.unitNames!.includes('JUMPJET'))
    assert.equal(f.requests(), 1)
    assert.deepEqual(f.submitted, [], '无敌人时不移动或集结')
    const plane = { ...flyer(101, 5, 5), name: 'ORCA', type: 1 }
    const ground = { ...flyer(102, 5, 5), name: 'E1', zone: 0 }
    await f.tick([plane, ground, flyer(103), flyer(104, 40, 40)])
    assert.deepEqual(f.submitted, [{ kind: 'attack', unitIds: [1], targetId: 103 }], '不能漏掉 type=3 的飞行兵，也不扩大成所有飞机或地面步兵')
    f.own[0]!.isIdle = false; f.submitted.length = 0
    await f.tick([plane, ground, flyer(103, 40, 40)])
    assert.deepEqual(f.submitted, [{ kind: 'stop', unitIds: [1] }])
    f.own[0]!.isIdle = true; f.submitted.length = 0
    await f.tick()
    assert.deepEqual(f.submitted, [])
    assert.equal(goal.status, 'active')
    f.own.push(flak(2)); f.formations.transfer([2], '2队')
    await f.tick([flyer(105)])
    assert.deepEqual(f.submitted, [{ kind: 'attack', unitIds: [1, 2], targetId: 105 }])
  } finally { f.dispose() }
})

test('最新幻影转写回放：欢迎只纠正攻击目标，模型漏掉兵种时本机补回，复合指令不串队', async () => {
  const f = await fixture()
  try {
    f.formations.create('3队', []); f.formations.transfer([1], '3队')
    f.own.push(flak(2)); f.formations.create('1队', [2]); await f.tick()
    let requests = 0
    const text = '3 队攻击敌人欢迎，1 队攻击敌人基地'
    const provider = { generate: async ({ messages }: { messages: Array<{ content: string }> }) => {
      requests++
      const facts = JSON.parse(messages[1]!.content)
      assert.equal(facts.text, text, '保留原始转写')
      assert.ok(facts.catalog.some((item: { name: string; attackAliases?: string[] }) => item.name === 'MGTK' && item.attackAliases?.includes('欢迎')), '苏军也向模型提供敌方幻影及目标纠错候选')
      return { text: JSON.stringify({ summary: '按全部敌人处理', operations: [
        { capability: 'combat.attack', params: { formationId: '3队', target: 'enemies' } },
        { capability: 'combat.attack', params: { formationId: '1队', target: 'base' } },
      ] }), model: 'fixture', durationMs: 0 }
    } }
    f.ctx.currentProvider = () => provider as never
    f.ctx.controller = new ProgramController({ runtime: f.runtime, executor, provider: () => provider as never })
    const result = await runTranscript(text, f.ctx, f.root)
    assert.match(result, /幻影坦克/)
    await f.tick([{ id: 901, name: 'MGTK', type: 7, rx: 8, ry: 5, isIdle: true },
      { id: 902, name: 'MTNK', type: 7, rx: 6, ry: 5, isIdle: true },
      { id: 903, name: 'GACNST', type: 2, rx: 10, ry: 5, isIdle: true }])
    assert.equal(requests, 1, '不追加模型决策或临时脚本生成')
    assert.deepEqual(f.submitted.filter(action => action.kind === 'attack').map(action => [action.unitIds, action.targetId]).sort((a, b) => Number(a[1]) - Number(b[1])), [[[1], 901], [[2], 903]])
    const catalog = await loadGameCatalog(f.ctx, () => {})
    assert.equal(catalog.resolve('欢迎'), undefined, '纠错不是生产或己方选择的普通别名')
    assert.ok(catalog.forTranscript('欢迎，造坦克').every(item => !item.attackAliases))
    const greeting = normalizeOperations('欢迎3队，3队攻击敌方载具', [{ capability: 'combat.attack', params: { formationId: '3队', target: 'enemies' } }], undefined, catalog)
    assert.ok(greeting.every(call => !('targetSelectors' in call.params) || !call.params.targetSelectors?.includes('MGTK')))
  } finally { f.dispose() }
})

test('持续守卫同时保留兵种、空地与异形区孔洞，同局恢复、暂停和取消沿用原要求', async () => {
  const f = await fixture()
  try {
    const { regions } = await loadIceMap()
    const area = { id: 'guard', name: '守区', aliases: [], level: 1, labelPosition: [43, 43], polygons: [{ outer: [[40, 40], [60, 40], [60, 60], [40, 60], [40, 40]], holes: [[[48, 48], [52, 48], [52, 52], [48, 52], [48, 48]]] }] }
    f.ctx.mapRegions = new MapRegionIndex({ ...regions.scheme, regions: [area] }); f.ctx.mapSessionKey = f.runtime.battleKey
    const result = await executeCapabilities([{ capability: 'combat.hold', params: { formationId: '2队', regionName: '守区', targetSelectors: ['infantry', 'vehicle'], targetDomain: 'air' } }], f.ctx, { text: '2队监视守区内的空中步兵和车辆' })
    assert.deepEqual(result.skipped, [])
    const goal = result.goals[0]!
    await f.tick([flyer(101, 50, 50), { ...flyer(102, 43, 43), name: 'E1', zone: 0 }, { ...flyer(103, 43, 43), name: 'ORCA', type: 1 }, flyer(104, 70, 70)])
    assert.deepEqual(f.submitted, [])
    await f.tick([flyer(105, 43, 43)])
    assert.deepEqual(f.submitted, [{ kind: 'attack', unitIds: [1], targetId: 105 }])
    f.own[0]!.isIdle = false
    const saved = persistState(f.runtime), other = await harness(executor, { formations: new FormationRegistry() })
    await other.runtime.onSnapshot({ ...f.runtime.snapshot!, self: f.own }); restoreState(other.runtime, saved)
    const tick = (enemies: SnapshotUnit[]) => other.runtime.onSnapshot({ ...other.runtime.snapshot!, self: f.own, enemies, seq: other.runtime.snapshot!.seq + 1, tick: other.runtime.snapshot!.tick + 30 })
    await tick([flyer(105, 50, 50)])
    assert.deepEqual(other.submitted, [{ kind: 'stop', unitIds: [1] }])
    other.runtime.pause('formation:2队'); other.submitted.length = 0
    await tick([flyer(106, 43, 43)])
    assert.deepEqual(other.submitted, [])
    other.runtime.resume('formation:2队'); await tick([flyer(106, 43, 43)])
    assert.deepEqual(other.submitted, [{ kind: 'attack', unitIds: [1], targetId: 106 }])
    await other.runtime.cancelGoal(goal.id); other.submitted.length = 0
    await tick([flyer(107, 43, 43)])
    assert.deepEqual(other.submitted, [])

    const normalized = normalizeOperations('2队警戒空中敌人', [{ capability: 'combat.attack', params: { formationId: '2队', target: 'enemies' } }])
    assert.equal(normalized[0]!.capability, 'combat.hold')
    assert.equal('targetDomain' in normalized[0]!.params && normalized[0]!.params.targetDomain, 'air')
    const original = { capability: 'combat.hold', params: { formationId: '2队', regionName: '守区', targetSelectors: ['JUMPJET'], targetDomain: 'air' } }
    const repaired = retainBindingScope(original, { capability: 'combat.hold', params: { formationId: '别的队', targetDomain: 'all' } }, loadPrompts())
    assert.equal(repaired.capability === 'combat.hold' && repaired.params.regionName, '守区')
    assert.deepEqual(repaired.capability === 'combat.hold' && repaired.params.targetSelectors, ['JUMPJET'])
    assert.equal(repaired.capability === 'combat.hold' && repaired.params.targetDomain, 'air')
    assert.throws(() => retainBindingScope(original, { capability: 'combat.attack', params: { formationId: '2队' } }, loadPrompts()), /持续守卫/)
  } finally { f.dispose() }
})
