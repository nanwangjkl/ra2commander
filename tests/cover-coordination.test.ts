import test from 'node:test'
import assert from 'node:assert/strict'
import type { CombatGoal, CoverPolicy, SnapshotUnit } from '../packages/contracts/src/index.ts'
import { FormationRegistry, persistState, restoreState } from '../packages/runtime/src/index.ts'
import { coverCombat } from '../packages/runtime/src/cover-combat.ts'
import { emptyCoverMotion, recordCoverOrder } from '../packages/runtime/src/cover.ts'
import { harness, outcome, snapshot } from './helpers.ts'

const unit=(id:number,x:number,y:number,escort=false):SnapshotUnit=>({id,name:escort?'E2':'HTNK',type:escort?3:7,rx:x,ry:y,isIdle:true,speed:escort?10.24:23.630769230769232,zone:0,primaryWeapon:{maxRange:6,minRange:0,aa:false,ag:true}})
const policy:CoverPolicy={runId:'cover',version:'0.2.5',escortIds:[6,7,8,9,10,11,12,13,14],gap:4,resumeGap:2,retryTicks:90}
const destination={x:110,y:43},region={name:'全图',x1:0,y1:0,x2:199,y2:199}

test('回放一队在(130,72)停车：远处补员独立追赶，恢复和改令后主体继续推进，会合后才纳入队形',async()=>{
  const body=[unit(1,129,70),unit(2,130,72),unit(3,129,71),unit(4,131,72),unit(5,130,71),
    ...[[134,73],[131,71],[132,70],[129,72],[130,70],[134,73],[131,71],[135,74],[129,72]].map(([x,y],i)=>unit(i+6,x!,y!,true))]
  const own=[...body,unit(20,107,121),unit(21,105,141)]
  const h=await harness({run:async()=>outcome([])},{formations:new FormationRegistry()})
  h.formations.create('1队',own.map(u=>u.id));h.runtime.setCover('1队',policy)
  await h.runtime.onSnapshot(snapshot({seq:2,self:own,enemies:[],mapWidth:200,mapHeight:200}))
  const spec:CombatGoal={id:'advance',kind:'combat',rawText:'1队前进',formationId:'1队',executionMode:'native',allowedActions:['move','stop'],region,destination}
  h.runtime.activateNativeGoals(h.runtime.upsertGoal(spec))
  const goal=h.runtime.goals.get(spec.id)!
  goal.facts.coverMotion={...emptyCoverMotion(),heldIds:body.map(u=>u.id),orders:Object.fromEntries(body.map(u=>[u.id,{kind:'stop',tick:15}]))}
  const tick=(runtime=h.runtime)=>runtime.onSnapshot({...runtime.snapshot!,self:own,enemies:[],seq:runtime.snapshot!.seq+1,tick:runtime.snapshot!.tick+30})
  await tick()
  assert.deepEqual(goal.facts.coverMotion!.cohesion!.catchingUpIds,[20,21])
  assert.equal(goal.facts.coverMotion!.heldIds.length,0)
  assert.ok(h.submitted.some(a=>a.kind==='move'&&a.unitIds.some(id=>policy.escortIds.includes(id))&&a.x===destination.x&&a.y===destination.y),'旧停车领行者重新获得终点长令')
  assert.ok(h.submitted.some(a=>a.kind==='move'&&a.unitIds.includes(20)&&a.y>60),'补员追赶前线主体，不直接冲向敌人')
  const restored=await harness({run:async()=>outcome([])},{formations:new FormationRegistry()})
  await restored.runtime.onSnapshot(h.runtime.snapshot!);restoreState(restored.runtime,persistState(h.runtime));await tick(restored.runtime)
  assert.deepEqual(restored.runtime.goals.get(spec.id)!.facts.coverMotion!.cohesion!.catchingUpIds,[20,21])
  restored.runtime.activateNativeGoals(restored.runtime.upsertGoal({...spec,id:'new-order',destination:{x:90,y:40}}));await tick(restored.runtime)
  const active=restored.runtime.goals.get('new-order')!
  assert.deepEqual(active.facts.coverMotion!.cohesion!.catchingUpIds,[20,21],'改令不会重新把远处补员纳入主体')
  own.find(u=>u.id===20)!.rx=131;own.find(u=>u.id===20)!.ry=73
  await tick(restored.runtime)
  assert.ok(active.facts.coverMotion!.cohesion!.coreIds.includes(20))
  assert.ok(!active.facts.coverMotion!.cohesion!.catchingUpIds.includes(20))
  assert.equal(restored.formations.ownerOf(21),'1队','追赶状态不改变编队归属')
})

test('原有成员绕路时只有限重聚，无进展后掉队者追赶，领行者恢复推进而不反复全队停车',()=>{
  const own=Array.from({length:14},(_,i)=>unit(i+1,70,70,i>=5))
  let state=emptyCoverMotion()
  const plan=(tick:number)=>coverCombat(policy,snapshot({tick,self:own,enemies:[],mapWidth:200,mapHeight:200}),own.map(u=>u.id),{targets:[],threats:[],destination,region,waiting:false},state,[])
  let current=plan(15);state=current.state
  for(const action of current.actions)recordCoverOrder(state,action,15,[{ok:true,submitted:1,session:1}])
  own[13]!.rx=30
  current=plan(45);state=current.state
  assert.ok(state.heldIds.length>0,'严重脱队仍允许短时重聚')
  state=JSON.parse(JSON.stringify(state))
  current=plan(600);state=current.state
  assert.deepEqual(state.cohesion!.catchingUpIds,[14])
  assert.equal(state.heldIds.length,0)
  assert.ok(current.actions.some(action=>action.kind==='move'&&action.unitIds.some(id=>policy.escortIds.includes(id))&&action.x===destination.x))
  current=plan(900)
  assert.equal(current.state.heldIds.length,0,'掉队者仍在原地也不会重置重聚并继续拖住主体')
})

test('暂停期间游戏继续运行不耗尽重聚额度，同局恢复后仍先完成剩余重聚',async()=>{
  const own=Array.from({length:14},(_,i)=>unit(i+1,70,70,i>=5))
  const h=await harness({run:async()=>outcome([])},{formations:new FormationRegistry()})
  h.formations.create('1队',own.map(u=>u.id));h.runtime.setCover('1队',policy)
  await h.runtime.onSnapshot(snapshot({seq:2,self:own,enemies:[],mapWidth:200,mapHeight:200}))
  const spec:CombatGoal={id:'pause-group',kind:'combat',rawText:'前进',formationId:'1队',executionMode:'native',allowedActions:['move','stop'],region,destination}
  h.runtime.activateNativeGoals(h.runtime.upsertGoal(spec))
  const tick=(runtime=h.runtime,step=30)=>runtime.onSnapshot({...runtime.snapshot!,self:own,enemies:[],seq:runtime.snapshot!.seq+1,tick:runtime.snapshot!.tick+step})
  await tick();own[13]!.rx=30;await tick()
  assert.ok(h.runtime.goals.get(spec.id)!.facts.coverMotion!.heldIds.length)
  h.runtime.pause('formation:1队');await tick(h.runtime,1000)
  const restored=await harness({run:async()=>outcome([])},{formations:new FormationRegistry()})
  await restored.runtime.onSnapshot(h.runtime.snapshot!);restoreState(restored.runtime,persistState(h.runtime))
  restored.runtime.resume('formation:1队');await tick(restored.runtime)
  const motion=restored.runtime.goals.get(spec.id)!.facts.coverMotion!
  assert.ok(motion.heldIds.length>0,'暂停经过的游戏时间不能把有限重聚直接跳过')
  assert.equal(motion.cohesion!.catchingUpIds.includes(14),false)
})
