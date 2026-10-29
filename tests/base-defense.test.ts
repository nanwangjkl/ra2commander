import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CombatGoal, SnapshotUnit, TargetRegion } from '../packages/contracts/src/index.ts'
import { inTargetRegion } from '../packages/contracts/src/index.ts'
import { loadPrompts } from '../packages/command/src/index.ts'
import { FormationRegistry, persistState, restoreState } from '../packages/runtime/src/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { runTranscript } from '../apps/companion/src/transcript.ts'
import { executeCapabilities } from '../apps/companion/src/capabilities/index.ts'
import { retainBindingScope } from '../apps/companion/src/capabilities/binding-recovery.ts'
import { loadIceMap } from '../apps/companion/src/map-binding.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { harness, snapshot, production, outcome } from './helpers.ts'

const game=loadPrompts().game
const soldier=(id:number,x=120,y=80):SnapshotUnit=>({id,name:'HTNK',type:7,rx:x,ry:y,isIdle:true,primaryWeapon:{maxRange:6,minRange:0,aa:false,ag:true}})
const enemy=(id:number,x:number,y:number):SnapshotUnit=>({id,name:'E1',type:3,rx:x,ry:y,isIdle:true})
async function fixture(pending=false) {
  const root=mkdtempSync(join(tmpdir(),'ra2c-base-defense-')),{regions}=await loadIceMap()
  const {runtime,formations,submitted}=await harness({run:async()=>outcome([])},{formations:new FormationRegistry(),regionsAt:(x,y)=>regions.regionsAt(x,y)})
  const own:SnapshotUnit[]=[{id:90,name:'NACNST',type:2,rx:94,ry:130,isIdle:true},...(!pending?[soldier(101)]:[])]
  await runtime.onSnapshot(snapshot({seq:2,self:own,enemies:[],mapWidth:200,mapHeight:200}))
  if(pending)runtime.upsertGoal(production({id:'tanks',target:'HTNK',quantity:10,formationId:'3队'}))
  else formations.create('3队',[101])
  let requests=0
  const provider={generate:async({messages}:{messages:Array<{content:string}>})=>{
    assert.ok('text' in JSON.parse(messages[1]!.content),'防守基地不生成作战脚本')
    requests++
    return {text:JSON.stringify({summary:'守基地',operations:[{capability:'formation.assign',params:{formationId:'3队',selector:'tanks',quantity:10}},{capability:'combat.hold',params:{formationId:'3队',regionName:'基地附近'}}]}),model:'fixture',durationMs:0}
  }}
  const ctx={runtime,formations,controller:new ProgramController({runtime,executor:{run:async()=>outcome([])},provider:()=>provider as never}),currentProvider:()=>provider,
    mapRegions:regions,mapSessionKey:runtime.battleKey,bridge:{rules:async(name:string)=>({...game.entry(name),...(name==='NACNST'?{undeploysInto:'SMCV'}:name==='SMCV'?{deploysInto:'NACNST'}:{})})},
  } as unknown as CommandContext
  return {root,ctx,runtime,formations,submitted,own,regions,requests:()=>requests,
    voice:()=>runTranscript('3队防守基地',ctx,root),
    tick:(enemies:SnapshotUnit[]=[])=>runtime.onSnapshot({...runtime.snapshot!,self:own,enemies,seq:runtime.snapshot!.seq+1,tick:runtime.snapshot!.tick+30}),
    dispose:()=>rmSync(root,{recursive:true,force:true}),
  }
}

test('防守基地按基地真实分区响应入侵，无敌人原地待命、不先集结；敌人出区后停止追击',async()=>{
  const f=await fixture()
  try {
    await f.voice();await f.tick()
    const goal=[...f.runtime.goals.values()].find(goal=>goal.spec.kind==='combat')!
    assert.equal(goal.spec.kind,'combat')
    if(goal.spec.kind!=='combat')throw new Error('missing goal')
    assert.equal(goal.spec.baseDefense!.region.name,'二楼左下')
    assert.equal(goal.spec.destination,undefined)
    assert.equal(f.runtime.goals.size,1,'不擅自从现有单位凑十辆或增加编队目标')
    assert.deepEqual(f.submitted,[],'无敌人不移动到基地或分区中心')
    assert.equal(f.requests(),1)
    assert.match(f.runtime.goalExecution(goal.spec.id)!.detail!,/原地待命/)
    const intruder=enemy(201,94,130),outside=enemy(202,120,80)
    assert.equal(inTargetRegion(outside.rx,outside.ry,goal.spec.baseDefense!.region),false)
    await f.tick([outside,intruder])
    assert.deepEqual(f.submitted,[{kind:'attack',unitIds:[101],targetId:201}],'队伍不在基地分区内也直接攻击入侵者，由游戏接近')
    f.own[1]!.isIdle=false
    f.submitted.length=0;await f.tick([outside,{...intruder,rx:120,ry:80}])
    assert.deepEqual(f.submitted,[{kind:'stop',unitIds:[101]}])
    f.own[1]!.isIdle=true;f.submitted.length=0;await f.tick([outside])
    assert.deepEqual(f.submitted,[])
    assert.equal(goal.status,'active')
    // 已有掩护关系也不在无敌人时额外发站位移动。
    f.own.push({...soldier(102),name:'HTK',primaryWeapon:{maxRange:6,minRange:0,aa:true,ag:true}})
    f.formations.transfer([102],'3队')
    f.runtime.setCover('3队',{runId:'cover',version:'0.2.4',escortIds:[102],gap:4,resumeGap:2,retryTicks:90})
    await f.tick()
    assert.deepEqual(f.submitted,[])
  } finally {f.dispose()}
})

test('异形防区排除孔洞；基地展开、收起和跨区后继续关联，同局恢复与暂停不重放任务',async()=>{
  const area:TargetRegion={id:'base-a',name:'A区',polygons:[{outer:[[20,20],[40,20],[40,40],[20,40],[20,20]],holes:[[[28,28],[32,28],[32,32],[28,32],[28,28]]]}]}
  const next:TargetRegion={id:'base-b',name:'B区',polygons:[{outer:[[40,20],[60,20],[60,40],[40,40],[40,20]],holes:[]}]}
  const regionsAt=(x:number,y:number)=>[area,next].filter(region=>inTargetRegion(x,y,region))
  const h=await harness({run:async()=>outcome([])},{formations:new FormationRegistry(),regionsAt})
  h.formations.create('3队',[101])
  let self:SnapshotUnit[]=[soldier(101,5,5),{id:90,name:'SMCV',type:7,rx:22,ry:22,isIdle:true}]
  let enemies=[enemy(201,25,25),enemy(202,30,30),enemy(203,45,25)]
  const tick=()=>h.runtime.onSnapshot({...h.runtime.snapshot!,self,enemies,seq:h.runtime.snapshot!.seq+1,tick:h.runtime.snapshot!.tick+30})
  await tick()
  const spec:CombatGoal={id:'defense',kind:'combat',rawText:'3队防守基地',formationId:'3队',executionMode:'native',mode:'hold',region:{name:'行军',x1:0,y1:0,x2:99,y2:99},allowedActions:['move','attack','stop'],baseDefense:{anchorId:90,anchorNames:['SMCV','NACNST'],position:{x:22,y:22},region:area}}
  const owner=h.runtime.upsertGoal(spec);h.runtime.activateNativeGoals(owner);await tick()
  assert.deepEqual(h.submitted,[{kind:'attack',unitIds:[101],targetId:201}])
  self=[{...self[0]!,isIdle:false},{...self[1]!,id:91,name:'NACNST'}];await tick()
  assert.equal(h.runtime.goals.get('defense')!.facts.baseDefense!.anchorId,91)
  self=[self[0]!,{...self[1]!,id:92,name:'SMCV'}];await tick()
  self[1]!.rx=45;self[1]!.ry=25;h.submitted.length=0;await tick()
  assert.equal(h.runtime.goals.get('defense')!.facts.baseDefense!.region.id,'base-b')
  assert.deepEqual(h.submitted,[{kind:'attack',unitIds:[101],targetId:203}])
  h.runtime.pause(owner);h.submitted.length=0;enemies=[];await tick()
  assert.deepEqual(h.submitted,[])
  const saved=persistState(h.runtime),other=await harness({run:async()=>outcome([])},{formations:new FormationRegistry(),regionsAt})
  await other.runtime.onSnapshot(h.runtime.snapshot!);restoreState(other.runtime,saved)
  await other.runtime.onSnapshot({...h.runtime.snapshot!,seq:h.runtime.snapshot!.seq+1,tick:h.runtime.snapshot!.tick+30})
  assert.equal(other.runtime.goalExecution('defense')!.state,'paused')
  assert.equal(other.runtime.goals.get('defense')!.facts.baseDefense!.region.id,'base-b')
  assert.deepEqual(other.submitted,[])
  other.runtime.resume(owner)
  await other.runtime.onSnapshot({...other.runtime.snapshot!,seq:other.runtime.snapshot!.seq+1,tick:other.runtime.snapshot!.tick+30})
  assert.deepEqual(other.submitted,[{kind:'stop',unitIds:[101]}],'恢复后结束离区目标的旧追击，原地待命')
})

test('防守基地等待明确生产编队，不增加生产或改守当前位置；绑定修正不可丢基地范围',async()=>{
  const f=await fixture(true)
  try {
    await f.voice();await f.tick()
    assert.equal(f.runtime.goals.size,2)
    const guard=[...f.runtime.goals.values()].find(goal=>goal.spec.kind==='combat')!
    assert.equal(f.runtime.goalExecution(guard.spec.id)!.state,'pending')
    assert.equal(f.runtime.goals.get('tanks')!.spec.kind,'production')
    assert.deepEqual(f.submitted,[])
    f.own.splice(0,1)
    const result=await executeCapabilities([{capability:'combat.hold',params:{formationId:'3队',defendBase:true}}],f.ctx,{text:'3队防守基地'})
    assert.match(result.skipped.join(' '),/未找到己方基地/)
    const original={capability:'combat.hold',params:{formationId:'3队',defendBase:true}}
    const repaired=retainBindingScope(original,{capability:'combat.hold',params:{formationId:'别的队',bounds:[0,0,10,10]}},loadPrompts())
    assert.equal(repaired.capability==='combat.hold'&&repaired.params.defendBase,true)
    assert.equal(repaired.capability==='combat.hold'&&repaired.params.formationId,'3队')
    assert.throws(()=>retainBindingScope(original,{capability:'combat.attack',params:{formationId:'3队'}},loadPrompts()),/必须保留基地分区/)
  } finally {f.dispose()}
})
