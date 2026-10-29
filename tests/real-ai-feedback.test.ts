import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityCall } from '../packages/command/src/index.ts'
import { loadPrompts } from '../packages/command/src/index.ts'
import { inTargetRegion, matchingAttackTargets, type SnapshotUnit } from '../packages/contracts/src/index.ts'
import { FormationRegistry, persistState, restoreState } from '../packages/runtime/src/index.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { runTranscript } from '../apps/companion/src/transcript.ts'
import { executeCapabilities } from '../apps/companion/src/capabilities/index.ts'
import { retainBindingRepairs, retainBindingScope } from '../apps/companion/src/capabilities/binding-recovery.ts'
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
    bridge: { rules: async (name: string) => ({...prompts.game.entry(name),isBaseDefense:['GAPILL','NASAM','GTGCAN'].includes(name)}) },
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

test('胜局反馈：部队与防御建筑保留并集，实际攻击步兵、车辆和防御设施，排除普通建筑', async () => {
  const f = await fixture([member(101,'HTNK'),{...member(102,'HTNK'),rx:134},{...member(103,'HTNK'),rx:139}])
  try {
    f.formations.create('1队',[101,102,103])
    const enemies:SnapshotUnit[]=[
      {id:201,name:'E1',type:3,rx:130,ry:85,isIdle:true},
      {id:202,name:'MTNK',type:7,rx:135,ry:85,isIdle:true},
      {id:203,name:'GAPILL',type:2,rx:140,ry:85,isIdle:true},
      {id:204,name:'NAREFN',type:2,rx:129,ry:85,isIdle:true},
    ]
    await f.tick(enemies)
    await f.voice('1队消灭敌方部队和防御建筑',[{capability:'combat.attack',params:{formationId:'1队',target:'buildings',targetSelectors:['infantry','vehicle','building']}}])
    await f.tick(enemies)
    const goal=[...f.runtime.goals.values()].find(goal=>goal.spec.kind==='attack')!
    if(goal.spec.kind!=='attack')throw new Error('missing attack')
    assert.deepEqual(matchingAttackTargets(goal.spec,enemies).map(unit=>unit.id),[201,202,203])
    const attacked=new Set<number>()
    let remaining=enemies
    for(let i=0;i<3;i++) {
      const target=f.submitted.find(action=>action.kind==='attack'&&!attacked.has(action.targetId))
      assert.ok(target?.kind==='attack')
      attacked.add(target.targetId);remaining=remaining.filter(unit=>unit.id!==target.targetId)
      await f.tick(remaining)
    }
    assert.deepEqual([...attacked].sort(),[201,202,203],'集中攻击依次处理并集目标，不攻击普通建筑')
    assert.deepEqual(f.calls(),{interpretations:1,generations:0})
    const catalog=await loadGameCatalog(f.ctx,()=>{},prompts.game)
    const partial=normalizeOperations('1队攻击大兵和自定义威胁',[{capability:'combat.attack',params:{formationId:'1队',targetSelectors:['E1','MTNK']}}],undefined,catalog)
    assert.ok(partial[0]!.capability==='combat.attack'&&partial[0]!.params.targetSelectors!.includes('MTNK'),'局部词命中不再覆盖模型识别的其余目标')
  } finally {await f.dispose()}
})

test('胜局反馈：核电站尚未解锁也绑定核子反应炉，修正不能降为普通电厂',async()=>{
  const f=await fixture()
  try {
    await f.voice('造作战实验室，出核电站',[
      {capability:'production.produce',params:{target:'NATECH',quantity:1}},
      {capability:'production.produce',params:{target:'核电站',quantity:1}},
    ])
    assert.deepEqual([...f.runtime.goals.values()].flatMap(goal=>goal.spec.kind==='production'?[goal.spec.target]:[]),['NATECH','NANRCT'])
    assert.deepEqual(f.calls(),{interpretations:1,generations:1},'别名直接绑定，无额外失败重决策')
    const catalog=await loadGameCatalog(f.ctx,()=>{},prompts.game)
    assert.ok(catalog.forTranscript('造核电站').some(item=>item.name==='NANRCT'&&!item.available))
    const original={capability:'production.produce',params:{target:'核电站',quantity:2,placementDirections:['up']}}
    assert.throws(()=>retainBindingScope(original,{capability:'production.produce',params:{target:'NAPOWR'}},prompts),/不能丢弃具体项目类别/)
    const corrected=retainBindingScope(original,{capability:'production.produce',params:{target:'NANRCT',quantity:99}},prompts)
    assert.ok(corrected.capability==='production.produce'&&corrected.params.quantity===2)
    assert.ok(corrected.capability==='production.produce'&&corrected.params.placementDirections?.[0]==='up')
  } finally {await f.dispose()}
})

test('胜局反馈：蜘蛛离场等待，同 ID 重现继续攻击，恢复与暂停不丢命令，停止后不复活',async()=>{
  const first=member(101,'DRON'),second=member(102,'DRON'),f=await fixture([first,second])
  try {
    f.formations.create('2队',[101,102])
    const enemies:SnapshotUnit[]=[{id:201,name:'MTNK',type:7,rx:130,ry:85,isIdle:true},{id:202,name:'V3',type:7,rx:140,ry:85,isIdle:true}]
    await f.tick(enemies)
    await f.voice('2队攻击视野内任何车辆单位',[{capability:'combat.attack',params:{formationId:'2队',target:'units',targetSelectors:['vehicle']}}])
    await f.tick(enemies)
    let goal=[...f.runtime.goals.values()].find(goal=>goal.spec.kind==='attack')!
    f.own.splice(f.own.findIndex(unit=>unit.id===101),1);await f.tick(enemies)
    f.own.splice(f.own.findIndex(unit=>unit.id===102),1);f.submitted.length=0;await f.tick(enemies)
    assert.equal(goal.status,'active')
    assert.equal(f.runtime.goalExecution(goal.spec.id)!.state,'pending')
    assert.match(f.runtime.goalExecution(goal.spec.id)!.detail!,/暂时不可观测/)
    assert.deepEqual(f.submitted,[])
    await f.voice('2队攻击敌方V3',[{capability:'combat.attack',params:{formationId:'2队',targetSelectors:['V3']}}])
    assert.equal(goal.status,'cancelled','离场期间的新命令替换旧任务')
    goal=[...f.runtime.goals.values()].find(goal=>goal.spec.kind==='attack'&&goal.status==='active')!
    await f.tick(enemies)
    assert.equal(f.runtime.goalExecution(goal.spec.id)!.state,'pending')
    const restored=await harness(f.executor,{formations:new FormationRegistry()})
    await restored.runtime.onSnapshot(f.runtime.snapshot!);restoreState(restored.runtime,persistState(f.runtime))
    const tick=()=>restored.runtime.onSnapshot({...restored.runtime.snapshot!,self:f.own,enemies,seq:restored.runtime.snapshot!.seq+1,tick:restored.runtime.snapshot!.tick+30})
    f.own.push(member(109,'DRON'));await tick()
    assert.equal(restored.submitted.length,0,'不自动接管同型新单位')
    f.own.push({...first,isIdle:false});await tick()
    assert.deepEqual(restored.submitted,[{kind:'attack',unitIds:[101],targetId:202}],'同一身份重现后按新命令发令，不受离场前旧动作去重影响')
    restored.runtime.pause('formation:2队');restored.submitted.length=0
    f.own.push(second);await tick();assert.equal(restored.submitted.length,0)
    restored.runtime.resume('formation:2队');await tick()
    assert.ok(restored.submitted.some(action=>action.kind==='attack'&&action.unitIds.includes(102)))
    await restored.runtime.stop('formation:2队');restored.submitted.length=0
    await tick();assert.equal(restored.submitted.length,0)
    assert.equal(restored.runtime.goalExecution(goal.spec.id)!.state,'cancelled')
  } finally {await f.dispose()}
})

test('蜘蛛编队全图作战同样保留离场成员，掩护不因暂时离场解除，普通坦克全灭仍结束',async()=>{
  const drone=member(101,'DRON'),escort=member(102,'HTNK'),f=await fixture([drone,escort])
  try {
    f.formations.create('2队',[101,102])
    f.runtime.setCover('2队',{runId:'cover-drone',version:'0.2.4',escortIds:[102],gap:4,resumeGap:2,retryTicks:90})
    const enemies:SnapshotUnit[]=[{id:201,name:'MTNK',type:7,rx:130,ry:85,isIdle:true}]
    await f.tick(enemies)
    await f.voice('2队摧毁全部敌人',[{capability:'combat.attack-all',params:{formationId:'2队'}}]);await f.tick(enemies)
    const goal=[...f.runtime.goals.values()].find(goal=>goal.spec.kind==='combat')!
    f.own.splice(f.own.findIndex(unit=>unit.id===101),1);await f.tick(enemies)
    assert.ok(f.formations.coverOf('2队'),'受护蜘蛛暂时离场不算一侧全灭')
    f.own.splice(f.own.findIndex(unit=>unit.id===102),1);await f.tick(enemies)
    assert.equal(goal.status,'active')
    assert.equal(f.runtime.goalExecution(goal.spec.id)!.state,'pending')
    await f.voice('2队继续摧毁全部敌人',[{capability:'combat.attack-all',params:{formationId:'2队'}}]);await f.tick(enemies)
    const current=[...f.runtime.goals.values()].find(goal=>goal.spec.kind==='combat'&&goal.status==='active')!
    assert.equal(f.runtime.goalExecution(current.spec.id)!.state,'pending','全队离场时也能给原编队改令')
    f.own.push(drone);await f.tick(enemies)
    assert.equal(current.status,'active')
    assert.equal(f.runtime.goalExecution(current.spec.id)!.state,'continuous')
    f.own.push(escort);assert.equal(f.formations.create('3队',[102],{force:true}).ok,true)
    await f.voice('3队摧毁全部敌人',[{capability:'combat.attack-all',params:{formationId:'3队'}}]);await f.tick(enemies)
    const ordinary=[...f.runtime.goals.values()].find(goal=>goal.spec.kind==='combat'&&goal.spec.formationId==='3队')!
    f.own.splice(f.own.findIndex(unit=>unit.id===102),1);await f.tick(enemies)
    assert.equal(ordinary.status,'failed','普通单位仍按既有全灭规则收尾')
  } finally {await f.dispose()}
})

test('普通编队攻击矿车共用稳定主目标，目标失效再切换，明确分头攻击才分散',async()=>{
  const f=await fixture([{...member(101,'HTNK'),rx:100},{...member(102,'HTNK'),rx:140}])
  try {
    f.formations.create('2队',[101,102])
    let enemies:SnapshotUnit[]=[{id:201,name:'HARV',type:7,rx:101,ry:85,isIdle:true},{id:202,name:'HARV',type:7,rx:139,ry:85,isIdle:true}]
    await f.tick(enemies)
    await f.voice('2队攻击敌方矿车',[{capability:'combat.attack',params:{formationId:'2队',targetSelectors:['harvester']}}]);await f.tick(enemies)
    assert.deepEqual(f.submitted,[{kind:'attack',unitIds:[101,102],targetId:201}])
    f.submitted.length=0;enemies[1]!.rx=120;await f.tick(enemies)
    assert.ok(f.submitted.every(a=>a.kind!=='attack'||a.targetId===201),'目标仍有效时不随最近距离摇摆')
    f.submitted.length=0;enemies=enemies.filter(u=>u.id!==201);await f.tick(enemies)
    assert.deepEqual(f.submitted,[{kind:'attack',unitIds:[101,102],targetId:202}])
    enemies=[{id:201,name:'HARV',type:7,rx:101,ry:85,isIdle:true},{id:202,name:'HARV',type:7,rx:139,ry:85,isIdle:true}]
    await f.tick(enemies);f.submitted.length=0
    await f.voice('2队分头攻击敌方矿车',[{capability:'combat.attack',params:{formationId:'2队',targetSelectors:['harvester']}}]);await f.tick(enemies)
    assert.deepEqual(f.submitted.filter(a=>a.kind==='attack').map(a=>a.targetId).sort(),[201,202])
  } finally {await f.dispose()}
})

test('坦克仍在生产时的攻击摘要和待准备兵种只引用实际来源，保留混编现有成员',async()=>{
  const f=await fixture([member(101,'HTNK'),{...member(102,'E2'),type:3}])
  try {
    f.formations.create('1队',[101,102])
    await f.voice('造10辆坦克编入1队',[{capability:'production.produce',params:{target:'HTNK',quantity:10,formationId:'1队'}}])
    const result=await f.voice('1队攻击最近敌军',[{capability:'combat.attack',params:{formationId:'1队'}}])
    assert.doesNotMatch(result,/飞机|满弹|投弹/)
    const attack=[...f.runtime.goals.values()].find(goal=>goal.spec.kind==='attack')!
    assert.ok(attack.spec.kind==='attack'&&attack.spec.membership?.kind==='prepared')
    assert.deepEqual(attack.spec.membership.names.sort(),['E2','HTNK'])
    await f.tick([{id:201,name:'HTNK',type:7,rx:130,ry:85,isIdle:true}])
    assert.ok(f.submitted.some(a=>a.kind==='attack'&&a.unitIds.includes(102)),'现有动员兵不能因待产项目只有坦克而被排除')
  } finally {await f.dispose()}
})
