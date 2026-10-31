import test from 'node:test'
// 保留脚本生成、替换与修复链路的覆盖；默认本机生产另由集成用例验证。
process.env.RA2C_PRODUCTION_EXECUTOR = 'script'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { handleCommand, type CommandContext } from '../apps/companion/src/commands.ts'
import { prepareGoals } from '../apps/companion/src/prepare-goals.ts'
import { loadPrompts } from '../packages/command/src/index.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { persistState, restoreState, saveStateFile, readStateFile, FormationRegistry, computePrerequisiteClosure } from '../packages/runtime/src/index.ts'
import type { ActionRequest, GoalSpec, Snapshot } from '../packages/contracts/src/index.ts'
import { activate, code, deferred, harness, outcome, production, snapshot, spec } from './helpers.ts'

// 固定模型产物只用于验证接线；脚本从动态上下文读取成员与进度。
const source = `function step(snapshot,memory) {
  const actions=[]; const queued={};
  for (const g of snapshot.control.goals) {
    const s=g.spec;
    if (g.blocked) continue;
    if (s.kind==='combat' || s.kind==='rally') {
      const x=s.kind==='rally'?s.x:6; const y=s.kind==='rally'?s.y:6;
      const key=g.unitIds.join(',')+':'+x+','+y;
      if(g.unitIds.length && memory[s.id]!==key) { actions.push({goalId:s.id,request:{kind:'move',unitIds:g.unitIds,x,y}}); memory[s.id]=key; }
    } else if(s.kind==='production') {
      for(const name of s.prerequisites.concat([s.target])) {
        if((g.observed[name]||[]).length && name!==s.target) continue;
        if(g.produceRemaining[name]>0 && !queued[name]) { actions.push({goalId:s.id,request:{kind:'produce',name,quantity:Math.min(3,g.produceRemaining[name])}}); queued[name]=true; }
        break;
      }
    } else if(s.kind==='formation') {
      if(s.request.kind==='dissolveFormation') actions.push({goalId:s.id,request:s.request});
      else if(g.unitIds.length===g.maxUnits) actions.push({goalId:s.id,request:{...s.request,unitIds:g.unitIds}});
    } else if(s.kind==='reinforce' && g.unitIds.length && g.maxUnits>0) {
      actions.push({goalId:s.id,request:{kind:'transferUnits',formationId:s.formationId,unitIds:g.unitIds.slice(0,g.maxUnits)}});
    }
  }
  return {actions,memory};
}`
const model = { generate: async () => ({ text: source, model: 'fixture', durationMs: 0 }) }

function context(runtime: Awaited<ReturnType<typeof harness>>['runtime'], executor: StepExecutor): CommandContext {
  const controller = new ProgramController({ runtime, executor, provider: () => model as never, prepare: (goals, signal) => prepareGoals(goals, runtime.snapshot!, async (name, type) => type === (name === 'NAPOWR' ? 2 : 7) ? { prerequisite: [] } : undefined, signal) })
  return { runtime, controller, formations: runtime.formations, bridge: { get latest() { return runtime.snapshot } } as never, page: {} as never, browser: {} as never, providers: new Map(), currentProvider: () => model as never }
}

test('文本入口驱动两队与全局；新增建设延续生产进度，改一队不替换其他对象', async () => {
  const executor = new StepExecutor()
  try {
    const { runtime, submitted, formations } = await harness(executor)
    formations.create('B', [2])
    const ctx = context(runtime, executor)
    await handleCommand('task new 守桥 @A --region=0,0,10,10 守桥', ctx)
    await handleCommand('task new 待命 @B --region=0,0,10,10 待命', ctx)
    await handleCommand('produce MTNK 5', ctx)
    await runtime.onSnapshot(snapshot({ seq: 2 }))
    assert.deepEqual(submitted.filter(a => a.kind === 'produce').map(a => a.quantity), [3])
    await handleCommand('produce NAPOWR 1', ctx)
    await runtime.onSnapshot(snapshot({ seq: 3 }))
    assert.deepEqual(submitted.filter(a => a.kind === 'produce').map(a => [a.name, a.quantity]), [['MTNK', 3], ['MTNK', 2], ['NAPOWR', 1]])
    const current = snapshot().self
    const units = [11, 12, 13, 14, 15].map(id => ({ ...current[0]!, id }))
    await runtime.onSnapshot(snapshot({ seq: 4, self: [...current, ...units, { ...current[0]!, id: 16, name: 'NAPOWR', type: 2 }] }))
    assert.ok([...runtime.goals.values()].filter(g => g.spec.kind === 'production').every(g => g.status === 'completed'))
    const globalVersion = runtime.programs.get('global')!.script!.version
    const guardB = [...runtime.goals.values()].find(goal => goal.ownerId === 'formation:B')!
    const secondSpec = structuredClone(guardB.activeSpec)
    assert.equal(secondSpec!.executionMode, 'native')
    await handleCommand('task new 新任务 @A --region=0,0,10,10 换位置', ctx)
    assert.equal(runtime.programs.size, 3)
    assert.equal(runtime.programs.get('global')!.script!.version, globalVersion)
    assert.deepEqual(runtime.goals.get(guardB.spec.id)!.activeSpec, secondSpec)
    // 全局脚本实际抛错只暂停全局，两队继续执行。
    activate(runtime, production({ id: 'bad-global' }), "function step(s,m){throw new Error('fault')}")
    for (const seq of [5, 6, 7]) await runtime.onSnapshot(snapshot({ seq }))
    assert.equal(runtime.programs.get('global')!.status, 'paused')
    assert.equal(runtime.programs.get('formation:A')!.status, 'active')
    assert.equal(runtime.programs.get('formation:B')!.status, 'active')
  } finally { await executor.dispose() }
})

test('全局连续命令合并完整目标，迟到候选不能覆盖最新脚本', async () => {
  const first = deferred<{ text: string; model: string; durationMs: number }>()
  const started = deferred<void>()
  let calls = 0
  const inputs: string[] = []
  const provider = { generate: async (input: { messages: Array<{ content: string }> }) => {
    inputs.push(input.messages[1]!.content)
    if (++calls === 1) { started.resolve(); return first.promise }
    return { text: code, model: 'fixture', durationMs: 0 }
  } }
  const executor = { run: async () => outcome() }
  const { runtime } = await harness(executor)
  const controller = new ProgramController({ runtime, executor, provider: () => provider as never })
  const old = controller.submit(production({ id: 'tanks' }))
  await started.promise
  await controller.submit(production({ id: 'power', target: 'NAPOWR', targetType: 2 }))
  first.resolve({ text: code, model: 'fixture', durationMs: 0 })
  await old
  assert.deepEqual(runtime.programs.get('global')!.activeGoalIds, ['tanks', 'power'])
  assert.equal(runtime.programs.get('global')!.script!.version, 1)
  assert.deepEqual(JSON.parse(inputs[1]!).control.goals.map((g: { spec: GoalSpec }) => g.spec.id), ['tanks', 'power'])
})

test('取消全局单个目标后，旧脚本里的其他目标仍能提交动作', async () => {
  const executor = new StepExecutor()
  try {
    const { runtime, submitted } = await harness(executor)
    activate(runtime, production({ id: 'cancel-me' }))
    activate(runtime, production({ id: 'keep-me', target: 'NAPOWR', targetType: 2 }), `function step(s,m){return {actions:[{goalId:'cancel-me',request:{kind:'produce',name:'MTNK',quantity:1}},{goalId:'keep-me',request:{kind:'produce',name:'NAPOWR',quantity:1}}],memory:{}}}`)
    await runtime.cancelGoal('cancel-me')
    await runtime.onSnapshot(snapshot({ seq: 2 }))
    assert.deepEqual(submitted, [{ kind: 'produce', name: 'NAPOWR', quantity: 1 }])
    assert.equal(runtime.programs.get('global')!.stats.errors, 0)
  } finally { await executor.dispose() }
})

test('多个建设目标共用单格队列时先推进一个，共享前置不重复下单且其他目标继续', async () => {
  const executor = new StepExecutor()
  const shared = `function step(s,m){const actions=[];for(const g of s.control.goals){for(const name of g.spec.prerequisites.concat([g.spec.target])){if(g.produceRemaining[name]>0&&s.production.available.includes(name)){actions.push({goalId:g.spec.id,request:{kind:'produce',name,quantity:g.produceRemaining[name]}});break}}}return {actions,memory:m}}`
  try {
    const { runtime, submitted } = await harness(executor)
    const snap = snapshot({ seq: 2, production: { power: { total: 0, drain: 0, isLowPower: false }, available: ['GAPOWR'], queues: [{ type: 0, size: 0, maxSize: 1, status: 0, items: [] }, { type: 2, size: 0, maxSize: 99, status: 0, items: [] }] } })
    await runtime.onSnapshot(snap)
    activate(runtime, production({ id: 'barracks', target: 'GAPILE', targetType: 2, prerequisites: ['GAPOWR'], queueTypes: { GAPOWR: 0, GAPILE: 0 } }), shared)
    activate(runtime, production({ id: 'dogs', target: 'ADOG', targetType: 3, quantity: 3, prerequisites: ['GAPOWR', 'GAPILE'], queueTypes: { GAPOWR: 0, GAPILE: 0, ADOG: 2 } }), shared)
    await runtime.onSnapshot({ ...snap, seq: 3 })
    await runtime.onSnapshot({ ...snap, seq: 4 })
    assert.deepEqual(submitted, [{ kind: 'produce', name: 'GAPOWR', quantity: 1 }])
    const power = { ...snap.self[0]!, id: 100, name: 'GAPOWR', type: 2 }
    await runtime.onSnapshot({ ...snap, seq: 5, self: [...snap.self, power], production: { ...snap.production!, available: ['GAPOWR', 'GAPILE'] } })
    assert.deepEqual(submitted.at(-1), { kind: 'produce', name: 'GAPILE', quantity: 1 })
    const barracks = { ...power, id: 101, name: 'GAPILE' }
    await runtime.onSnapshot({ ...snap, seq: 6, self: [...snap.self, power, barracks], production: { ...snap.production!, available: ['GAPOWR', 'GAPILE', 'ADOG'] } })
    assert.deepEqual(submitted.filter(action => action.kind === 'produce').map(action => [action.name, action.quantity]), [['GAPOWR', 1], ['GAPILE', 1], ['ADOG', 3]])
    assert.equal(runtime.programs.get('global')!.stats.errors, 0)
    assert.equal(runtime.programs.get('global')!.status, 'active')
  } finally { await executor.dispose() }
})

test('同队列独立目标顺延而不丢失，排队不掩盖超出目标额度的错误', async () => {
  const executor = new StepExecutor()
  try {
    const { runtime, submitted } = await harness(executor)
    const snap = snapshot({ seq: 2, production: { power: { total: 0, drain: 0, isLowPower: false }, available: ['GAPOWR', 'NAPOWR'], queues: [{ type: 0, size: 0, maxSize: 1, status: 0, items: [] }] } })
    await runtime.onSnapshot(snap)
    const source = `function step(s,m){const actions=[];for(const g of s.control.goals){if(g.produceRemaining[g.spec.target]>0)actions.push({goalId:g.spec.id,request:{kind:'produce',name:g.spec.target,quantity:g.produceRemaining[g.spec.target]}})}return {actions,memory:m}}`
    activate(runtime, production({ id: 'first', target: 'GAPOWR', targetType: 2 }), source)
    activate(runtime, production({ id: 'second', target: 'NAPOWR', targetType: 2 }), source)
    await runtime.onSnapshot({ ...snap, seq: 3 })
    await runtime.onSnapshot({ ...snap, seq: 4 })
    assert.deepEqual(submitted, [{ kind: 'produce', name: 'GAPOWR', quantity: 1 }])
    await runtime.onSnapshot({ ...snap, seq: 5, self: [...snap.self, { ...snap.self[0]!, id: 100, type: 2, name: 'GAPOWR' }] })
    assert.deepEqual(submitted.at(-1), { kind: 'produce', name: 'NAPOWR', quantity: 1 })
    const lease = runtime.beginCompile('global'), frame = runtime.compileFrame(lease)
    frame.constraints.ignoreInactiveGoals = true
    frame.constraints.goals!.second!.produceRemaining = { NAPOWR: 1 }
    frame.constraints.goals!.second!.queueSpace = { 0: 1 }
    const excessive = await executor.run("function step(s,m){return {actions:[{goalId:'second',request:{kind:'produce',name:'NAPOWR',quantity:2}}],memory:m}}", frame.snapshot, {}, frame.constraints)
    assert.equal(excessive.ok, false)
    assert.match(excessive.error!, /额度|空位/)
    runtime.releaseCommand(lease)
  } finally { await executor.dispose() }
})

test('转编停车失败时不开放新队指挥，确认后动态接入且不重置原任务', async () => {
  const executor = new StepExecutor()
  let parking = false
  const sent: ActionRequest[] = []
  try {
    const { runtime, formations } = await harness(executor, { submit: async (actions, context, guard) => {
      if (!guard()) return []
      if (actions[0]!.kind === 'stop' && !parking) return [{ ok: false, submitted: 0, session: context.session, reason: 'api-error' }]
      sent.push(...actions)
      return [{ ok: true, submitted: 1, session: context.session }]
    } })
    formations.create('B', [2])
    activate(runtime, spec(), source)
    activate(runtime, spec({ id: 'b', formationId: 'B' }), source)
    activate(runtime, { id: 'transfer', kind: 'formation', rawText: '转编到B', request: { kind: 'transferUnits', formationId: 'B', unitIds: [1] } }, source)
    await runtime.onSnapshot(snapshot({ seq: 2 }))
    assert.equal(formations.ownerOf(1), 'B')
    assert.equal(runtime.handoffs.length, 1)
    sent.length = 0
    await runtime.onSnapshot(snapshot({ seq: 3 }))
    assert.ok(sent.every(a => !('unitIds' in a) || !a.unitIds.includes(1)))
    parking = true
    await runtime.onSnapshot(snapshot({ seq: 4 }))
    assert.equal(runtime.handoffs.length, 0)
    assert.equal(runtime.goals.get('transfer')!.status, 'completed')
    assert.deepEqual(sent.filter(a => a.kind === 'move').at(-1)!.unitIds, [2, 1])
    assert.equal(runtime.programs.get('formation:B')!.script!.version, 1)
    assert.equal(runtime.goals.get('b')!.facts.members.length, 1)
  } finally { await executor.dispose() }
})

test('生产先保存预留再发送；重启的未决记录不重放，旧状态留备份', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ra2c-state-'))
  const file = join(dir, 'state.json')
  const executor = { run: async (_code: string, value: unknown) => {
    const view = (value as Snapshot).control!.goals[0]!
    return outcome(view.produceRemaining.MTNK ? [{ kind: 'produce', name: 'MTNK', quantity: 1 }] : [], {}, view.spec.id)
  } }
  let failSave = true
  let calls = 0
  let current: Awaited<ReturnType<typeof harness>>['runtime']
  const checkpoint = () => { if (failSave) throw new Error('disk unavailable'); saveStateFile(file, persistState(current)) }
  try {
    writeFileSync(file, JSON.stringify({ version: 2 }))
    const first = await harness(executor, { checkpoint, submit: async () => {
      calls++
      assert.equal(readStateFile(file).production.at(-1)!.state, 'reserved')
      throw new Error('lost ack')
    } })
    current = first.runtime
    activate(current, production())
    await current.onSnapshot(snapshot({ seq: 2 }))
    assert.equal(calls, 0)
    failSave = false
    await current.onSnapshot(snapshot({ seq: 3 }))
    assert.equal(calls, 1)
    assert.equal(JSON.parse(readFileSync(file + '.v2.bak', 'utf8')).version, 2)
    const saved = readStateFile(file)
    const next = await harness(executor, { formations: new FormationRegistry(), checkpoint })
    current = next.runtime
    restoreState(current, saved)
    await current.onSnapshot(snapshot({ seq: 4 }))
    assert.deepEqual(next.submitted, [])
    const pending = current.production.find(r => r.state === 'unknown')!
    current.resolveProduction(pending.id, 'not-sent')
    await current.onSnapshot(snapshot({ seq: 5 }))
    assert.deepEqual(next.submitted, [{ kind: 'produce', name: 'MTNK', quantity: 1 }])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('矿场前置先解析电厂，未落地解锁时不能提前提交矿场', async () => {
  const rules: Record<string, string[]> = { MTNK: ['GAWEAP'], GAWEAP: ['PROC', 'GAPILE', 'GACNST'], GAREFN: ['POWER', 'GACNST'], GAPILE: ['POWER', 'GACNST'], GAPOWR: ['GACNST'], GACNST: [] }
  const own = [{ ...snapshot().self[0]!, id: 100, name: 'GACNST', type: 2 }]
  const closure = await computePrerequisiteClosure('MTNK', { available: async () => ['GAPOWR'], prerequisites: async name => rules[name], categories: loadPrompts().game.categories(own) }, own)
  assert.deepEqual(closure.unknown, [])
  assert.ok(closure.toBuild.indexOf('GAPOWR') < closure.toBuild.indexOf('GAREFN'))
  assert.ok(closure.toBuild.indexOf('GAREFN') < closure.toBuild.indexOf('GAWEAP'))
  const executor = new StepExecutor()
  try {
    const { runtime, submitted } = await harness(executor)
    await runtime.onSnapshot(snapshot({ seq: 2, self: own, production: { power: { drain: 0, total: 0, isLowPower: false }, queues: [], available: ['GAPOWR'] } }))
    activate(runtime, production({ prerequisites: closure.toBuild }), "function step(s,m){return {actions:[{goalId:'production',request:{kind:'produce',name:'GAREFN',quantity:1}}],memory:{}}}")
    await runtime.onSnapshot(snapshot({ seq: 3, self: own, production: { power: { drain: 0, total: 0, isLowPower: false }, queues: [], available: ['GAPOWR'] } }))
    assert.deepEqual(submitted, [])
    assert.equal(runtime.production.length, 0)
    assert.match(runtime.programs.get('global')!.stats.lastError!, /尚未解锁/)
    const second = await harness(executor)
    const stage = snapshot({ seq: 2, production: { power: { drain: 0, total: 100, isLowPower: false }, queues: [{ type: 0, status: 0, size: 0, maxSize: 1, items: [] }], available: ['GAPOWR', 'GAREFN'] } })
    await second.runtime.onSnapshot(stage)
    activate(second.runtime, production({ id: 'power', target: 'GAPOWR', targetType: 2 }))
    activate(second.runtime, production({ id: 'refinery', target: 'GAREFN', targetType: 2 }), "function step(s,m){return {actions:[{goalId:'power',request:{kind:'produce',name:'GAPOWR',quantity:1}},{goalId:'refinery',request:{kind:'produce',name:'GAREFN',quantity:1}}],memory:{}}}")
    await second.runtime.onSnapshot({ ...stage, seq: 3 })
    assert.deepEqual(second.submitted, [{ kind: 'produce', name: 'GAPOWR', quantity: 1 }])
    assert.equal(second.runtime.production.length, 1)
    assert.equal(second.runtime.programs.get('global')!.stats.errors, 0)
  } finally { await executor.dispose() }
})
