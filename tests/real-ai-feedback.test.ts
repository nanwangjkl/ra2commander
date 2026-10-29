import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityCall } from '../packages/command/src/index.ts'
import { loadPrompts } from '../packages/command/src/index.ts'
import { inTargetRegion, type SnapshotUnit } from '../packages/contracts/src/index.ts'
import { FormationRegistry, persistState, restoreState } from '../packages/runtime/src/index.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { runTranscript } from '../apps/companion/src/transcript.ts'
import { executeCapabilities } from '../apps/companion/src/capabilities/index.ts'
import { retainBindingRepairs } from '../apps/companion/src/capabilities/binding-recovery.ts'
import { loadGameCatalog } from '../apps/companion/src/game-catalog.ts'
import { normalizeOperations } from '../apps/companion/src/transcript-plan.ts'
import { loadIceMap } from '../apps/companion/src/map-binding.ts'
import { harness, snapshot } from './helpers.ts'

const prompts = loadPrompts()
const member = (id: number, name: string, aa = false): SnapshotUnit => ({ id, name, type: 7, rx: 129, ry: 85, isIdle: true, speed: aa ? 31.5 : 27.57, zone: 0, primaryWeapon: { minRange: 0, maxRange: 6, aa, ag: true } })
const source = `function step(s,m){const actions=[];for(const g of s.control.goals){if(g.spec.kind!=='production')continue;const c=s.constraints.goals[g.spec.id];for(const name of g.productionPlan.availableToProduce)if(g.produceRemaining[name]>0)actions.push({goalId:g.spec.id,request:{kind:'produce',name,quantity:g.produceRemaining[name]}});if(c.management?.allowedUnitIds.length)actions.push({goalId:g.spec.id,request:{kind:c.management.kind,formationId:c.management.formationId,unitIds:c.management.allowedUnitIds}});}return {actions,memory:m}}`
async function fixture(units: SnapshotUnit[] = []) {
  const executor = new StepExecutor(), root = mkdtempSync(join(tmpdir(), 'ra2c-real-ai-'))
  const h = await harness(executor, { formations: new FormationRegistry() })
  const own = [{ id: 90, name: 'NACNST', type: 2, rx: 120, ry: 83, isIdle: true }, ...units]
  await h.runtime.onSnapshot(snapshot({ seq: 2, self: own, enemies: [], mapWidth: 200, mapHeight: 200, production: { ...snapshot().production!, available: ['HTNK', 'HTK'], queues: [{ type: 3, status: 0, size: 0, maxSize: 99, items: [] }] } }))
  let operations: CapabilityCall[] = [], interpretations = 0, generations = 0
  const provider = { generate: async ({ messages }: { messages: Array<{content: string}> }) => {
    const input = JSON.parse(messages[1]!.content)
    if ('text' in input) { interpretations++; return { text: JSON.stringify({ summary: '测试原始模型结果', operations }), model: 'fixture', durationMs: 0 } }
    generations++; return { text: source, model: 'fixture', durationMs: 0 }
  } }
  const ctx = { ...h, controller: new ProgramController({ runtime: h.runtime, executor, provider: () => provider as never }), currentProvider: () => provider,
    bridge: { rules: async (name: string) => prompts.game.entry(name) },
  } as unknown as CommandContext
  return { ...h, ctx, own, root, executor,
    calls: () => ({ interpretations, generations }),
    voice: (text: string, calls: CapabilityCall[]) => { operations = calls; return runTranscript(text, ctx, root) },
    tick: async (enemies: SnapshotUnit[] = []) => h.runtime.onSnapshot({ ...h.runtime.snapshot!, self: own, enemies, seq: h.runtime.snapshot!.seq + 1, tick: h.runtime.snapshot!.tick + 30 }),
    dispose: async () => { await executor.dispose(); rmSync(root, {recursive: true, force: true}) },
  }
}

test('真实电脑反馈：误选IFV的防空车掩护按苏军HTK绑定，坦克与掩护各生产一份', async () => {
  const f = await fixture()
  try {
    await f.voice('造5个坦克，1个防空车掩护', [
      { capability: 'production.produce', params: { target: 'HTNK', quantity: 5, formationId: '1队' } },
      { capability: 'formation.cover', params: { formationId: '1队', selector: 'infantryFightingVehicle', quantity: 1, memberSource: 'auto', protectedSelector: 'tanks', protectedQuantity: 5 } },
    ])
    const productions = [...f.runtime.goals.values()].flatMap(goal => goal.spec.kind === 'production' ? [[goal.spec.target, goal.spec.quantity]] : [])
    assert.deepEqual(productions, [['HTNK',5],['HTK',1]])
    assert.equal(f.runtime.skillRuns.size, 1)
    await f.tick()
    assert.deepEqual(f.runtime.production.map(record=>[record.name,record.quantity]), [['HTNK',5],['HTK',1]])
    const catalog = await loadGameCatalog(f.ctx,()=>{},prompts.game), {regions} = await loadIceMap()
    const explicit = normalizeOperations('造一个IFV掩护1队', [{capability:'formation.cover',params:{formationId:'1队',selector:'FV',memberSource:'new'}}],regions,catalog)
    assert.equal(explicit[0]!.capability === 'formation.cover' && explicit[0]!.params.selector, 'FV', '明确IFV仍保留原单位要求')
  } finally { await f.dispose() }
})

test('防空车编入后立即攻击飞行兵：只理解一次，交接后直接攻击，恢复仍不扩大敌方兵种', async () => {
  const f = await fixture([member(101,'HTK',true)])
  try {
    const enemies: SnapshotUnit[] = [{id:201,name:'E1',type:3,rx:130,ry:86,isIdle:true,zone:0},{id:202,name:'JUMPJET',type:3,rx:90,ry:155,isIdle:true,zone:1}]
    await f.tick(enemies)
    await f.voice('防空车编入2队，攻击敌方飞行兵', [{capability:'formation.assign',params:{formationId:'2队',selector:'HTK',quantity:'all'}},{capability:'combat.attack',params:{formationId:'2队',selector:'HTK',target:'units'}}])
    await f.tick(enemies); await f.tick(enemies); await f.tick(enemies)
    assert.deepEqual(f.calls(),{interpretations:1,generations:0})
    assert.equal(f.formations.ownerOf(101),'2队')
    assert.ok(f.submitted.some(action=>action.kind==='attack'&&action.targetId===202&&action.unitIds.includes(101)))
    assert.ok(f.submitted.every(action=>action.kind!=='attack'||action.targetId===202))
    const attack=[...f.runtime.goals.values()].find(goal=>goal.spec.kind==='attack')!
    assert.deepEqual(attack.spec.kind==='attack'&&attack.spec.objective!.target.unitNames,['JUMPJET'])
    const state = persistState(f.runtime), restored = await harness(f.executor,{formations:new FormationRegistry()})
    await restored.runtime.onSnapshot(f.runtime.snapshot!);restoreState(restored.runtime,state)
    await restored.runtime.onSnapshot({...f.runtime.snapshot!,seq:f.runtime.snapshot!.seq+1,tick:f.runtime.snapshot!.tick+30,enemies:[enemies[0]!]})
    assert.ok(restored.submitted.every(action=>action.kind!=='attack'), '没有飞行兵时不改打附近大兵')
  } finally { await f.dispose() }
})

test('区域进攻直接攻击并保留敌方并集；同句移动合并，不等到区域中心', async () => {
  const f = await fixture([member(101,'HTNK'),member(102,'HTK',true)])
  try {
    f.formations.create('1队',[101,102])
    const enemies: SnapshotUnit[]=[{id:201,name:'E1',type:3,rx:102,ry:168,isIdle:true,zone:0},{id:202,name:'JUMPJET',type:3,rx:103,ry:167,isIdle:true,zone:1},{id:203,name:'MTNK',type:7,rx:104,ry:165,isIdle:true},{id:204,name:'E1',type:3,rx:128,ry:85,isIdle:true,zone:0}]
    await f.tick(enemies)
    await f.voice('1队向3楼左下移动，攻击所有大兵和飞行兵',[{capability:'combat.move',params:{formationId:'1队',regionName:'三楼左下'}},{capability:'combat.attack',params:{formationId:'1队',target:'units',regionName:'三楼左下'}}])
    await f.tick(enemies)
    assert.equal([...f.runtime.goals.values()].filter(goal=>goal.spec.rawText.includes('攻击')).length,1)
    const goal=[...f.runtime.goals.values()].find(goal=>goal.spec.kind==='attack')!
    assert.equal(goal.spec.kind==='attack'&&goal.spec.objective!.search.kind,'region')
    assert.deepEqual(f.calls(),{interpretations:1,generations:0})
    assert.equal(f.submitted.length>0&&f.submitted.every(action=>action.kind==='attack'&&[201,202].includes(action.targetId)),true)
    assert.ok(f.submitted.every(action=>action.kind!=='attack'||!action.unitIds.includes(101)||action.targetId===201),'不能让犀牛选择空中的飞行兵')
    assert.ok(goal.spec.kind==='attack'&&inTargetRegion(102,168,goal.spec.objective!.target.region!))
    f.submitted.length=0;await f.tick([enemies[3]!])
    assert.ok(f.submitted.some(action=>action.kind==='move'),'区内没有匹配敌人时继续搜索')
    assert.equal(f.submitted.some(action=>action.kind==='attack'),false,'不攻击分区外敌人')
    const catalog=await loadGameCatalog(f.ctx,()=>{},prompts.game),{regions}=await loadIceMap()
    const clear=normalizeOperations('1队进攻三楼左下空中步兵',[{capability:'combat.clear-region',params:{formationId:'1队',regionName:'三楼左下'}}],regions,catalog)
    assert.equal(clear[0]!.capability==='combat.clear-region'&&clear[0]!.params.targetDomain,'air')
    f.submitted.length=0
    await executeCapabilities(clear,f.ctx,{text:'1队进攻三楼左下空中步兵',prompts,catalog});await f.tick(enemies)
    assert.deepEqual(f.submitted.filter(action=>action.kind==='attack'),[{kind:'attack',unitIds:[102],targetId:202}], '类别、空地和区域同时生效，地面坦克不接对空任务')
  } finally { await f.dispose() }
})

test('掩护修正统一生产且保留数量、来源；当前人数排除阵亡历史成员', async () => {
  const original={capability:'formation.cover',params:{formationId:'1队',selector:'ifv',quantity:1,memberSource:'auto',protectedSelector:'tanks',protectedQuantity:5}}
  const corrected=retainBindingRepairs(original,[{capability:'production.produce',params:{target:'HTK',quantity:1,formationId:'1队'}},{capability:'formation.cover',params:{formationId:'1队',selector:'HTK',quantity:99,memberSource:'new'}}],prompts,'造5个坦克，1个防空车掩护')
  assert.equal(corrected.length,1)
  assert.equal(corrected[0]!.capability,'formation.cover')
  assert.deepEqual(corrected[0]!.params,{...prompts.capabilities.parse(original).params,selector:'antiAirVehicle'})
  assert.throws(()=>retainBindingRepairs(original,[{capability:'production.produce',params:{target:'HTK',quantity:1}}],prompts,'防空车掩护'),/必须保留同队掩护/)
  const f=await fixture([member(101,'HTNK'),member(102,'HTK',true)])
  try {
    f.formations.create('1队',[50,101])
    const result=await executeCapabilities([{capability:'formation.cover',params:{formationId:'1队',selector:'antiAirVehicle',quantity:1,memberSource:'existing'}}],f.ctx,{text:'1个防空车掩护1队',prompts})
    assert.match(result.choices.join(' '),/2个现有单位/)
    assert.ok(f.formations.membersOf('1队').includes(50),'历史保留，人数按当前存活事实显示')
    assert.equal(f.calls().generations,0)
  } finally {await f.dispose()}
})
