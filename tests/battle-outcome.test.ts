import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BattleStatus } from '../packages/contracts/src/index.ts'
import { persistState, restoreState } from '../packages/runtime/src/index.ts'
import { BattleRecords } from '../apps/companion/src/battle-records.ts'
import { exportBattle, openBattleBundle } from '../apps/companion/src/battle-export.ts'
import { activate, harness, snapshot, spec, production } from './helpers.ts'

const battle = (outcome?: 'victory' | 'defeat'): BattleStatus => ({ phase: outcome ? 'ended' : 'playing', ...(outcome ? { outcome } : {}), evidence: 'public-player-status', players: [
  { name: 'self', defeated: outcome === 'defeat', allied: true, combatant: true, isObserver: false },
  { name: 'enemy', defeated: outcome === 'victory', allied: false, combatant: true, isObserver: false },
] })

test('胜利后结束持续进攻，未完成生产保留部分进度，不再发令；同局重启及新局有明确边界', async () => {
  const h = await harness()
  activate(h.runtime, spec({ id: 'attack', destination: { x: 9, y: 9 } }), 'function step(s,m){return {actions:[],memory:m}}')
  activate(h.runtime, production({ id: 'unfinished', quantity: 5 }), 'function step(s,m){return {actions:[],memory:m}}')
  h.runtime.production.push({ id: 'existing', goalId: 'unfinished', name: 'MTNK', quantity: 2, building: false, state: 'submitted', observedIds: [1, 2], placed: false })
  await h.runtime.onSnapshot(snapshot({ seq: 2, battle: battle(), enemies: [] }))
  assert.equal(h.runtime.goals.get('attack')!.status, 'active', '没有可见敌人不等于胜利')
  const beforeEnd = persistState(h.runtime)
  await h.runtime.onSnapshot(snapshot({ seq: 3, tick: 16, battle: battle('victory'), enemies: [] }))
  assert.equal(h.runtime.goalExecution('attack')!.state, 'completed')
  assert.match(h.runtime.goalExecution('attack')!.detail!, /对局胜利/)
  assert.equal(h.runtime.goals.get('unfinished')!.status, 'partial')
  assert.equal(h.runtime.production[0]!.quantity, 2)
  assert.equal(h.submitted.length, 0)
  assert.throws(() => h.runtime.upsertGoal(production()), /对局已结束/)
  const saved = persistState(h.runtime), restored = await harness()
  restoreState(restored.runtime, saved)
  await restored.runtime.onSnapshot(snapshot({ seq: 3, tick: 30 }))
  assert.equal(restored.submitted.length, 0)
  assert.equal(restored.runtime.battleResult!.outcome, 'victory')
  assert.equal(restored.runtime.goals.get('attack')!.status, 'completed')
  const ended = await harness()
  await ended.runtime.onSnapshot(snapshot({ seq: 2, battle: battle('victory') }))
  restoreState(ended.runtime, beforeEnd)
  assert.equal(ended.runtime.goalExecution('attack')!.state, 'completed', '重连的第一帧已结束，旧检查点立即收尾，无需再等游戏 tick')
  assert.equal(ended.runtime.goals.get('unfinished')!.status, 'partial')
  assert.equal(ended.submitted.length, 0)
  await restored.runtime.onSnapshot(snapshot({ sessionKey: 'new-game', seq: 1 }))
  assert.equal(restored.runtime.battleResult, undefined)
  assert.doesNotThrow(() => restored.runtime.upsertGoal(production()))
})

test('失败有真实终态，不把进攻伪装成完成；结束状态进入归档、摘要与压缩提交包', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-outcome-')), records = new BattleRecords(root)
  try {
    const h = await harness()
    activate(h.runtime)
    await h.runtime.onSnapshot(snapshot({ seq: 2, battle: battle() }))
    records.setSession(h.runtime.battleKey); records.observe(h.runtime)
    await h.runtime.onSnapshot(snapshot({ seq: 3, tick: 16, battle: battle('defeat') }))
    records.observe(h.runtime); records.close()
    assert.equal(h.runtime.goalExecution('alpha')!.state, 'failed')
    assert.match(h.runtime.goalExecution('alpha')!.detail!, /对局失败/)
    const archive = new BattleRecords(root), id = archive.list()[0]!.id
    assert.equal(archive.list()[0]!.result!.outcome, 'defeat')
    assert.equal(archive.read(id)!.result!.outcome, 'defeat')
    assert.match(archive.summary(id)!, /对局结果：失败/)
    assert.match(readFileSync(join(root, '.runtime/battles', id, 'meta.json'), 'utf8'), /"outcome":"defeat"/)
    const output = join(root, 'battle.ra2c.jsonl.gz')
    await exportBattle(root, id, output)
    const bundle = await openBattleBundle(output)
    try { assert.equal(bundle.records.read(bundle.id)!.result!.outcome, 'defeat'); assert.match(bundle.records.summary(bundle.id)!, /对局结果：失败/) }
    finally { bundle.dispose() }
    archive.close()
  } finally { records.close(); rmSync(root, { recursive: true, force: true }) }
})

test('败局结束帧清空己方列表时优先结束对局，保留之前损失六辆、尚存四辆的事实和掩护状态',async()=>{
  const h=await harness({run:async()=>({ok:true,actions:[],memory:{}})})
  h.formations.transfer([2,3,4,5,6,7,8,9,10],'A')
  h.runtime.setCover('A',{runId:'cover',version:'0.2.5',escortIds:[4],gap:4,resumeGap:2,retryTicks:90})
  const goal={id:'raid',kind:'attack' as const,rawText:'攻击矿车',formationId:'A',executionMode:'native' as const,unitIds:[1,2,3,4,5,6,7,8,9,10],aircraftIds:[],preparationGoalIds:[],ammoCapacity:{},targetKind:'units' as const,targetNames:[]}
  h.runtime.activateNativeGoals(h.runtime.upsertGoal(goal))
  await h.runtime.onSnapshot(snapshot({seq:2,battle:battle()}))
  await h.runtime.onSnapshot(snapshot({seq:3,tick:45,battle:battle(),self:snapshot().self.slice(0,4)}))
  const before=JSON.parse(JSON.stringify(h.runtime.goals.get('raid')!.facts.attack))
  assert.equal(before.members.filter((m:{phase:string})=>m.phase==='lost').length,6)
  h.submitted.length=0
  await h.runtime.onSnapshot(snapshot({seq:4,tick:60,battle:battle('defeat'),self:[]}))
  assert.deepEqual(h.runtime.goals.get('raid')!.facts.attack,before)
  assert.match(h.runtime.goalExecution('raid')!.detail!,/对局失败/)
  assert.ok(h.formations.coverOf('A'),'不能因结束帧清空而篡改为掩护全灭')
  assert.equal(h.submitted.length,0)
})
