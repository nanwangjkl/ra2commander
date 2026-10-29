import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { FormationRegistry, persistState, restoreState } from '../packages/runtime/src/index.ts'
import { loadPrompts } from '../packages/command/src/index.ts'
import type { CapabilityCall } from '../packages/command/src/index.ts'
import type { SnapshotUnit, CommandEvent } from '../packages/contracts/src/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { runTranscript } from '../apps/companion/src/transcript.ts'
import { executeCapabilities } from '../apps/companion/src/capabilities/index.ts'
import { retainBindingScope } from '../apps/companion/src/capabilities/binding-recovery.ts'
import { normalizeOperations } from '../apps/companion/src/transcript-plan.ts'
import { loadGameCatalog } from '../apps/companion/src/game-catalog.ts'
import { loadIceMap } from '../apps/companion/src/map-binding.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { applyCommandEvent, type CardData } from '../apps/companion/ui/command-card.ts'
import { harness, snapshot } from './helpers.ts'

const source = `function step(s,m){const actions=[];for(const g of s.control.goals){
 if(g.spec.kind==='attack'&&g.attack.targets.length&&g.attack.readyIds.length)actions.push({goalId:g.spec.id,request:{kind:'attack',unitIds:g.attack.readyIds,targetId:g.attack.targets[0].id}});
 if(g.spec.kind==='formation'&&g.unitIds.length)actions.push({goalId:g.spec.id,request:{...g.spec.request,unitIds:g.unitIds}});
}return {actions,memory:m}}`
const reply = (text: string) => ({ text, model: 'fixture', durationMs: 0 })

async function fixture() {
  const executor = new StepExecutor(), root = mkdtempSync(join(tmpdir(), 'ra2c-air-'))
  const { runtime, formations, submitted } = await harness(executor, { formations: new FormationRegistry() })
  let own: SnapshotUnit[] = [[11, 'ORCA', 1, 0], [12, 'ORCA', 1, 1], [13, 'BEAG', 1, 1], [14, 'BEAG', 1, 2], [15, 'MTNK', 7, 0], [16, 'DOG', 3, 0]].map(([id, name, type, ammo]) => ({
    id: id as number, name: name as string, type: type as number, ammo: ammo as number, rx: 5, ry: 5, isIdle: true,
    primaryWeapon: { maxRange: 3, minRange: 0, aa: false, ag: true, cooldownTicks: 0 },
  }))
  formations.create('混编', [13, 14, 15]); formations.create('侦察队', [16])
  const enemies: SnapshotUnit[] = [
    { id: 90, name: 'GACNST', type: 2, rx: 80, ry: 80, isIdle: true, hitPoints: 1000 },
    { id: 91, name: 'HTNK', type: 7, rx: 75, ry: 75, isIdle: true },
    { id: 92, name: 'GAPOWR', type: 2, rx: 70, ry: 70, isIdle: true },
  ]
  await runtime.onSnapshot(snapshot({ seq: 2, self: own, enemies }))
  let operations: CapabilityCall[] = [], repairs = 0, script = source
  const provider = { generate: async ({ messages }: { messages: Array<{ content: string }> }) => {
    const input = JSON.parse(messages[1]!.content)
    if (input.failures) { repairs++; return reply(JSON.stringify({ repairs: [{ index: 0, operations: [{ capability: 'combat.attack-all', params: {} }] }] })) }
    return reply('text' in input ? JSON.stringify({ summary: '飞机攻击', operations }) : script)
  } }
  const controller = new ProgramController({ runtime, executor, provider: () => provider as never })
  const ctx = { runtime, formations, controller, currentProvider: () => provider, bridge: {
    rules: async (name: string, type: number) => ({ ORCA: 1, BEAG: 1, MTNK: 7, DOG: 3, GACNST: 2 }[name] === type
      ? { label: name, prerequisite: [], ...(type === 1 ? { ammo: name === 'ORCA' ? 1 : 2 } : {}), ...(name === 'GACNST' ? { constructionYard: true } : {}) } : undefined),
  } } as unknown as CommandContext
  return { ctx, runtime, executor, submitted,
    goals: () => [...runtime.goals.values()].filter(goal => goal.spec.kind === 'attack'),
    repairs: () => repairs,
    voice: (calls: CapabilityCall[], text = '所有飞机攻击敌方基地') => { operations = calls; return runTranscript(text, ctx, root) },
    script: (value: string) => { script = value },
    ammo: (values: Record<number, number>) => { own = own.map(unit => ({ ...unit, ammo: values[unit.id] ?? unit.ammo! })) },
    tick: async (delta = 30) => runtime.onSnapshot({ ...runtime.snapshot!, self: own, seq: runtime.snapshot!.seq + 1, tick: runtime.snapshot!.tick + delta }),
    dispose: async () => { await executor.dispose(); rmSync(root, { recursive: true, force: true }) },
  }
}

test('复现飞机反馈：不建队、不动狗队；满弹先行，逐机真实投弹即完成且不重复出击', async () => {
  const f = await fixture()
  try {
    await f.voice([{ capability: 'formation.assign', params: { selector: 'aircraft', quantity: 'all', formationId: '1队' } }, { capability: 'combat.attack-all', params: { formationId: '1队' } }])
    assert.equal(f.repairs(), 0)
    assert.deepEqual(f.goals().map(goal => goal.ownerId).sort(), ['formation:混编', 'global'])
    assert.ok([...f.runtime.goals.values()].every(goal => goal.spec.kind === 'attack'))
    assert.equal(f.runtime.programs.has('formation:侦察队'), false)
    assert.equal(f.runtime.formations.ownerOf(11), undefined)
    assert.equal(f.runtime.formations.ownerOf(14), '混编')
    await f.tick()
    const attacks = () => f.submitted.flatMap(action => action.kind === 'attack' ? [action] : [])
    assert.deepEqual(attacks().flatMap(action => action.unitIds).sort(), [12, 14])
    assert.ok(attacks().every(action => action.targetId === 90), '超出武器射程也交由游戏接近；严格选择基地')
    f.ammo({ 12: 0, 14: 1 }); await f.tick()
    assert.ok(f.goals().every(goal => f.runtime.goalExecution(goal.spec.id)?.state === 'pending'))
    assert.ok(f.goals().every(goal => f.runtime.goalExecution(goal.spec.id)?.progress?.completed === 1))
    f.ammo({ 11: 1, 12: 1, 13: 1, 14: 2 }); await f.tick()
    assert.deepEqual(attacks().flatMap(action => action.unitIds).sort(), [11, 12, 14], '部分装弹的13仍等待；已投弹12和14不再次出击')
    f.ammo({ 11: 0, 13: 2 }); await f.tick()
    assert.deepEqual(attacks().flatMap(action => action.unitIds).sort(), [11, 12, 13, 14])
    f.ammo({ 13: 1 }); await f.tick()
    assert.ok(f.goals().every(goal => goal.status === 'completed'))
    assert.ok(f.goals().every(goal => f.runtime.goalExecution(goal.spec.id)?.progress?.completed === 2))
    assert.equal(f.runtime.snapshot!.enemies[0]!.hitPoints, 1000, '不以目标摧毁或掉血判定投弹')
    f.ammo({ 11: 1, 13: 2 }); await f.tick(300)
    assert.equal(attacks().length, 4)
    assert.ok(f.submitted.every(action => action.kind === 'attack'), '无建队、移动、停车或生产副作用')
  } finally { await f.dispose() }
})

test('等待装弹和已投弹事实跨重编及同局恢复保留；取消后不再派出', async () => {
  const f = await fixture()
  try {
    await f.voice([{ capability: 'combat.attack', params: { selector: 'aircraft', unitIds: [11, 12], target: 'base' } }], '11和12号飞机攻击敌方基地')
    await f.tick()
    const airborne = await harness(f.executor, { formations: new FormationRegistry() })
    await airborne.runtime.onSnapshot(f.runtime.snapshot!)
    restoreState(airborne.runtime, JSON.parse(JSON.stringify(persistState(f.runtime))))
    await airborne.runtime.onSnapshot({ ...f.runtime.snapshot!, self: f.runtime.snapshot!.self.map(unit => unit.id === 12 ? { ...unit, ammo: 0 } : unit), seq: f.runtime.snapshot!.seq + 1, tick: f.runtime.snapshot!.tick + 30 })
    assert.deepEqual(airborne.submitted, [], '同局恢复仍能依据之前发令后的弹药下降确认投弹，不重复派出')
    assert.equal(airborne.runtime.goalExecution(f.goals()[0]!.spec.id)?.progress?.completed, 1)
    f.ammo({ 12: 0 }); await f.tick()
    await f.ctx.controller.refresh('global'); await f.tick()
    assert.equal(f.submitted.length, 1)
    const saved = JSON.parse(JSON.stringify(persistState(f.runtime)))
    const restored = await harness(f.executor, { formations: new FormationRegistry() })
    await restored.runtime.onSnapshot(f.runtime.snapshot!)
    restoreState(restored.runtime, saved)
    await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, self: f.runtime.snapshot!.self.map(unit => unit.id === 11 || unit.id === 12 ? { ...unit, ammo: 1 } : unit), seq: f.runtime.snapshot!.seq + 1, tick: f.runtime.snapshot!.tick + 30 })
    assert.deepEqual(restored.submitted, [{ kind: 'attack', unitIds: [11], targetId: 90 }])
    const goal = f.goals()[0]!
    await f.runtime.cancelGoal(goal.spec.id)
    f.ammo({ 11: 1, 12: 1 }); await f.tick(300)
    assert.equal(f.submitted.filter(action => action.kind === 'attack').length, 1)
  } finally { await f.dispose() }
})

test('显式编队并攻击可绑定待交接编队，不因尚未注册而触发全军攻击修正', async () => {
  const f = await fixture()
  try {
    const result = await f.voice([{ capability: 'formation.assign', params: { selector: 'aircraft', unitIds: [11, 12], formationId: '1队', quantity: 'all' } }, { capability: 'combat.attack-all', params: { formationId: '1队' } }], '11和12号飞机编入1队，1队攻击敌人')
    assert.doesNotMatch(result, /未执行部分/)
    assert.equal(f.repairs(), 0)
    assert.equal(f.runtime.goalExecution(f.goals()[0]!.spec.id)?.state, 'pending')
    await f.tick(); await f.tick()
    assert.deepEqual(f.runtime.formations.membersOf('1队').sort(), [11, 12])
    assert.deepEqual(f.submitted.flatMap(action => action.kind === 'attack' ? action.unitIds : []), [12])
    assert.equal(f.runtime.programs.has('formation:侦察队'), false)
  } finally { await f.dispose() }
})

test('绑定修正不能去掉指定队/单位/目标范围；找不到的队保持失败而不牵连其他队', async () => {
  const f = await fixture()
  try {
    const result = await f.voice([{ capability: 'combat.attack-all', params: { formationId: '不存在' } }], '不存在队攻击')
    assert.equal(f.repairs(), 1)
    assert.match(result, /编队不存在/)
    assert.equal(f.runtime.goals.size, 0)
    const original = { capability: 'combat.attack', params: { selector: 'aircraft', unitIds: [11], target: 'base', targetId: 90, regionName: '三楼右下' } }
    assert.deepEqual(retainBindingScope(original, { capability: 'combat.attack', params: {} }, loadPrompts()).params,
      loadPrompts().capabilities.parse(original).params)
    assert.throws(() => retainBindingScope(original, { capability: 'formation.assign', params: { formationId: '1队' } }, loadPrompts()), /不能改成建队/)
  } finally { await f.dispose() }
})

test('飞机队的区域攻击沿用装弹等待；新攻击能力不被旧地域校正重复展开', async () => {
  const f = await fixture()
  try {
    f.runtime.formations.create('1队', [11])
    const { regions } = await loadIceMap()
    f.ctx.mapRegions = regions; f.ctx.mapSessionKey = f.runtime.battleKey
    await f.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: 3, mapWidth: 200, mapHeight: 200 })
    await f.voice([{ capability: 'combat.clear-region', params: { formationId: '1队', regionName: '一楼' } }], '1队攻击一楼敌人')
    const goal = f.goals()[0]!
    assert.equal(goal.spec.kind === 'attack' && goal.spec.targetRegion?.name, '一楼')
    assert.equal(f.runtime.goalExecution(goal.spec.id)?.state, 'pending')
    await f.tick()
    assert.deepEqual(f.submitted, [])
    const direct: CapabilityCall = { capability: 'combat.attack', params: { selector: 'aircraft', formationId: '1队', target: 'base', targetId: 90, regionName: '一楼' } }
    assert.deepEqual(normalizeOperations('1队飞机攻击一楼的敌方基地', [direct], regions), [direct])
    const byId: CapabilityCall = { capability: 'combat.attack', params: { selector: 'aircraft', target: 'enemies', targetId: 90 } }
    assert.deepEqual(normalizeOperations('所有飞机攻击90号敌人', [byId]), [byId], '飞机去编队校正不丢指定目标')
  } finally { await f.dispose() }
})

test('本机攻击不受首次没弹的错误模型脚本影响；装弹状态显示 pending', async () => {
  const f = await fixture()
  try {
    f.script(`function step(s,m){const actions=[];for(const g of s.control.goals){if(g.spec.kind!=='attack')continue;if(!g.attack.readyIds.length)m.done=true;if(!m.done&&g.attack.targets.length)actions.push({goalId:g.spec.id,request:{kind:'attack',unitIds:g.attack.readyIds,targetId:g.attack.targets[0].id}});}return {actions,memory:m}}`)
    const catalog = await loadGameCatalog(f.ctx, () => {})
    const result = await executeCapabilities([{ capability: 'combat.attack', params: { selector: 'aircraft', unitIds: [11], target: 'base' } }], f.ctx, { text: '11号飞机攻击基地', catalog })
    assert.match(result.results.join(' '), /本机执行/)
    assert.equal(f.goals()[0]!.status, 'active')
    assert.equal(f.runtime.programs.get('global')!.script, undefined)
    await f.tick()
    assert.equal(f.runtime.goalExecution(f.goals()[0]!.spec.id)!.state, 'pending')
    f.ammo({11: 1}); await f.tick()
    assert.ok(f.submitted.some(action => action.kind === 'attack' && action.unitIds.includes(11)))
    let card: CardData | undefined
    const events: CommandEvent[] = ['pending', 'running', 'completed'].map((state, seq) => ({ commandId: 'command', source: 'sidebar', at: 0, seq, stage: 'execution', goalId: 'g', execution: { state: state as 'pending' | 'running' | 'completed' } }))
    for (const event of events) { card = applyCommandEvent(event, card); assert.equal(card.stage, event.execution!.state) }
    const calls: CapabilityCall[] = [{ capability: 'combat.attack', params: { selector: 'aircraft', target: 'base' } }, { capability: 'combat.attack', params: { selector: 'tanks', target: 'units' } }]
    assert.deepEqual(normalizeOperations('所有飞机攻击基地，所有坦克攻击敌方单位', calls), calls, '同句独立坦克命令保留')
  } finally { await f.dispose() }
})
