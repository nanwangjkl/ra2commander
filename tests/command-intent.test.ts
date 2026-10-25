import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { runTranscript } from '../apps/companion/src/transcript.ts'
import { CommandLog } from '../apps/companion/src/command-log.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { inTargetRegion, validateActions, liveScriptActions, type TargetRegion } from '../packages/contracts/src/index.ts'
import { activate, harness, snapshot, spec } from './helpers.ts'

const reply = (text: string) => ({ text, model: 'fixture', durationMs: 0 })
const formationCode = `function step(s,m){const actions=[];for(const g of s.control.goals)if(g.spec.kind==='formation')actions.push({goalId:g.spec.id,request:{...g.spec.request,unitIds:g.unitIds}});return {actions,memory:m}}`
const rules = async (name: string, type: number) => name === 'MTNK' && type === 7 ? { label: 'Grizzly Battle Tank', prerequisite: [] } : undefined

test('重放两条错误解析：编入现有坦克、合并既有队伍，不生成生产目标或重复转入', async () => {
  for (const [all, availableCount] of [[false, 5], [true, 6], [false, 3]] as const) {
    const executor = new StepExecutor(), root = mkdtempSync(join(tmpdir(), 'ra2c-intent-'))
    try {
      const { runtime, formations, submitted } = await harness(executor)
      formations.clear()
      if (all) { formations.create('1队', [1]); formations.create('2队', [2]) }
      const snap = snapshot({ seq: 2, self: snapshot().self.slice(0, availableCount) })
      await runtime.onSnapshot(snap)
      const provider = { generate: async (input: { messages: Array<{ content: string }> }) => {
        const payload = JSON.parse(input.messages[1]!.content)
        return reply('text' in payload ? JSON.stringify({ summary: '将现有全部灰熊坦克编入1队', operations: [{ capability: 'production.produce', params: { target: 'MTNK', quantity: all ? 6 : 5, formationId: '1队' } }] }) : formationCode)
      } }
      const log = new CommandLog()
      const ctx = { runtime, formations, bridge: { rules }, commandLog: log, currentProvider: () => provider,
        controller: new ProgramController({ runtime, executor, provider: () => provider as never }) } as unknown as CommandContext
      const text = all ? '所有坦克编入1队' : '5个坦克编入1队'
      await runTranscript(text, ctx, root)
      assert.ok([...runtime.goals.values()].every(goal => goal.spec.kind === 'formation'))
      const summary = log.since(0).find(event => event.stage === 'understood')!.summary!
      assert.match(summary, /现有.*不新增生产/)
      await runtime.onSnapshot({ ...snap, seq: 3 })
      assert.deepEqual(formations.membersOf('1队').sort((a, b) => a - b), snap.self.map(unit => unit.id))
      assert.ok(submitted.every(action => action.kind !== 'produce'))
      if (availableCount === 3) assert.ok(log.since(0).some(event => event.stage === 'skipped' && event.error?.includes('未追加生产')))
      if (all) {
        const actions = submitted.length
        await runTranscript(text, ctx, root)
        const lastId = log.since(0).filter(event => event.stage === 'received').at(-1)!.commandId
        assert.equal(log.since(0).filter(event => event.commandId === lastId).at(-1)!.stage, 'completed')
        assert.equal(submitted.length, actions)
      }
    } finally { await executor.dispose(); rmSync(root, { recursive: true, force: true }) }
  }
})

test('区域清敌纠正 move+attackAll，按真实分区选敌且只指挥指定队，到达不代表清空', async () => {
  const executor = new StepExecutor(), root = mkdtempSync(join(tmpdir(), 'ra2c-intent-'))
  try {
    const { runtime, formations, submitted } = await harness(executor)
    formations.clear(); formations.create('1队', [1]); formations.create('2队', [2])
    const snap = snapshot({ seq: 2, mapWidth: 200, mapHeight: 200,
      enemies: [{ ...snapshot().enemies[0]!, id: 99, rx: 152, ry: 83 }, { ...snapshot().enemies[0]!, id: 100, rx: 20, ry: 20 }] })
    await runtime.onSnapshot(snap)
    const provider = { generate: async (input: { messages: Array<{ content: string }> }) => {
      const payload = JSON.parse(input.messages[1]!.content)
      if ('text' in payload) return reply(JSON.stringify({ summary: '前往三楼右下并攻击全部敌人', operations: [{ capability: 'combat.move', params: { formationId: '1队', regionName: '三楼右下' } }, { capability: 'combat.attack-all', params: {  } }] }))
      assert.equal(payload.control.goals.length, 1)
      assert.equal(payload.control.goals[0].spec.attackRegion.name, '三楼右下')
      assert.deepEqual(payload.enemies.map((enemy: { id: number }) => enemy.id), [99])
      assert.ok(!input.messages[1]!.content.includes('polygons'))
      return reply(`function step(s,m){const g=s.control.goals[0],t=s.enemies[0];return {actions:t?[{goalId:g.spec.id,request:{kind:'attack',unitIds:g.unitIds,targetId:t.id}}]:[],memory:m}}`)
    } }
    const ctx = { runtime, formations, bridge: { rules }, currentProvider: () => provider,
      controller: new ProgramController({ runtime, executor, provider: () => provider as never }) } as unknown as CommandContext
    await runTranscript('1队摧毁3楼右下所有敌人', ctx, root)
    const goal = [...runtime.goals.values()][0]!
    assert.equal(runtime.goals.size, 1)
    assert.equal(runtime.programs.has('formation:2队'), false)
    await runtime.onSnapshot({ ...snap, seq: 3 })
    assert.deepEqual(submitted, [{ kind: 'attack', unitIds: [1], targetId: 99 }], '射程外也交给游戏处理接近和攻击')
    await runtime.onSnapshot({ ...snap, seq: 4, self: snap.self.map(unit => unit.id === 1 ? { ...unit, rx: 152, ry: 83 } : unit) })
    assert.equal(goal.status, 'active')
    await runtime.onSnapshot({ ...snap, seq: 5, enemies: snap.enemies.filter(enemy => enemy.id === 100) })
    assert.equal(goal.status, 'active', '区域敌人暂时不可见不能据此宣布完成')
    assert.equal(runtime.programs.get('formation:1队')!.stats.errors, 0)
  } finally { await executor.dispose(); rmSync(root, { recursive: true, force: true }) }
})

test('消失目标和失效成员跳过当次动作，异形区域包含孔洞，行军不触发沿途攻击', async () => {
  const executor = new StepExecutor()
  try {
    const { runtime, submitted } = await harness(executor)
    activate(runtime, spec({ region: { name: '全图', x1: 0, y1: 0, x2: 99, y2: 99 } }), `function step(s,m){return {actions:[{goalId:'alpha',request:{kind:'attack',unitIds:[1,999],targetId:98}},{goalId:'alpha',request:{kind:'attack',unitIds:[1,999],targetId:99}}],memory:m}}`)
    for (const seq of [2, 3, 4]) await runtime.onSnapshot(snapshot({ seq, enemies: [{ ...snapshot().enemies[0]!, rx: 90, ry: 90 }] }))
    assert.equal(runtime.programs.get('formation:A')!.status, 'active')
    assert.equal(runtime.programs.get('formation:A')!.stats.errors, 0)
    assert.ok(submitted.every(action => action.kind === 'attack' && action.targetId === 99 && action.unitIds.join() === '1'))
    const region: TargetRegion = { id: 'L', name: '异形区', polygons: [{ outer: [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]], holes: [[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]] }] }
    assert.equal(inTargetRegion(8, 8, region), false)
    assert.equal(inTargetRegion(1.5, 1.5, region), false)
    assert.equal(inTargetRegion(3, 8, region), true)
    const goal = { allowedUnitIds: [1], enemyIds: [], mapWidth: 100, mapHeight: 100, allowedActions: ['move', 'attackMove'] as Array<'move' | 'attackMove'>, region: { name: '行军范围', x1: 0, y1: 0, x2: 99, y2: 99 }, targetRegion: region }
    const request = { kind: 'attackMove' as const, unitIds: [1], x: 3, y: 8 }
    const converted = liveScriptActions([{ goalId: 'a', request }], { ...goal, ignoreInactiveGoals: true, goals: { a: goal } }, snapshot({ self: [{ ...snapshot().self[0]!, rx: 50, ry: 50 }] }))
    assert.equal(converted[0]!.request.kind, 'move')
    assert.match(validateActions([{ ...request, x: 8, y: 8 }], goal)!, /目标分区/)
  } finally { await executor.dispose() }
})
