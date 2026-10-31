import test from 'node:test'
// 保留脚本生成、替换与修复链路的覆盖；默认本机生产另由集成用例验证。
process.env.RA2C_PRODUCTION_EXECUTOR = 'script'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { FormationRegistry, persistState, restoreState } from '../packages/runtime/src/index.ts'
import { inTargetRegion, type MiningGoal, type SnapshotUnit } from '../packages/contracts/src/index.ts'
import { loadPrompts } from '../packages/command/src/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { runTranscript } from '../apps/companion/src/transcript.ts'
import { loadIceMap } from '../apps/companion/src/map-binding.ts'
import { regionDestination } from '../apps/companion/src/capabilities/selectors.ts'
import { MiningObserver } from '../apps/companion/src/mining.ts'
import { executeCapabilities } from '../apps/companion/src/capabilities/index.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { activate, code, deferred, harness, snapshot, spec } from './helpers.ts'
import { handleCommand } from '../apps/companion/src/commands.ts'

const source = `function step(s,m){const actions=[];for(const g of s.control.goals){if(g.spec.kind==='mining'){for(const request of g.mining.actions)actions.push({goalId:g.spec.id,request});}else if(g.spec.kind==='rally'&&g.unitIds.length)actions.push({goalId:g.spec.id,request:{kind:'move',unitIds:g.unitIds,x:g.spec.x,y:g.spec.y}});}return {actions,memory:m}}`
const reply = (text: string) => ({ text, model: 'fixture', durationMs: 0 })

async function fixture(formation = false) {
  const executor = new StepExecutor(), root = mkdtempSync(join(tmpdir(), 'ra2c-mining-'))
  const env = await harness(executor, { formations: new FormationRegistry() }), runtime = env.runtime
  const { regions } = await loadIceMap()
  const ctx = { runtime, formations: runtime.formations, mapRegions: regions, mapSessionKey: runtime.battleKey } as unknown as CommandContext
  await runtime.onSnapshot(snapshot({ seq: 2, mapWidth: 200, mapHeight: 200 }))
  const { destination: point, region } = await regionDestination(ctx, '一楼', () => {})
  let own: SnapshotUnit[] = [11, 12].map((id, i) => ({ id, name: 'CMIN', type: 7, rx: point.x + (i ? 2 : -2), ry: point.y, isIdle: true }))
  own.push({ ...own[0]!, id: 13, name: 'MTNK' })
  const ore = new Set([(point.y * 200 + point.x - 1), (point.y * 200 + point.x + 1)])
  await runtime.onSnapshot(snapshot({ seq: 3, self: own, mapWidth: 200, mapHeight: 200 }))
  if (formation) runtime.formations.create('矿队', [11])
  let requests = 0
  const provider = { generate: async ({ messages }: { messages: Array<{ content: string }> }) => {
    requests++
    return reply('text' in JSON.parse(messages[1]!.content) ? JSON.stringify({ summary: '现有矿车采一楼的矿，不区分矿种', operations: [{ capability: 'economy.gather', params: { regionName: '一楼' } }] }) : source)
  } }
  const controller = new ProgramController({ runtime, executor, provider: () => provider as never })
  Object.assign(ctx, { controller, currentProvider: () => provider, bridge: {
    rules: async (name: string, type: number) => ['CMIN', 'MTNK'].includes(name) && type === 7 ? { label: name, harvester: name === 'CMIN', prerequisite: [] } : undefined,
    readMapBatch: async (cells: number[]) => {
      assert.ok(cells.length <= 256)
      assert.ok(cells.every(cell => inTargetRegion(cell % 200, Math.floor(cell / 200), region)))
      return { seen: cells, impassable: [], ore: cells.filter(cell => ore.has(cell)) }
    },
  } })
  const observer = new MiningObserver()
  return { ctx, runtime, executor, root, ore, point, observer, submitted: env.submitted, requests: () => requests,
    goals: () => [...runtime.goals.values()].filter(goal => goal.spec.kind === 'mining'),
    voice: () => runTranscript('让所有矿车到一楼的彩色矿区去采矿', ctx, root),
    tick: async (delta = 30) => runtime.onSnapshot({ ...runtime.snapshot!, self: own, seq: runtime.snapshot!.seq + 1, tick: runtime.snapshot!.tick + delta }),
    busy: (value: boolean, returning = false) => { own = own.map(unit => ({ ...unit, isIdle: !value, ...(returning && unit.id === 11 ? { rx: 2, ry: 2 } : {}) })) },
    dispose: async () => { ctx.commandLog?.ensureArchive(root).close(); await executor.dispose(); rmSync(root, { recursive: true, force: true }) },
  }
}

test('反馈命令经共同入口发出并行采矿；返厂和卸货不重发，空闲后换矿点，不以抵达完成', async () => {
  const f = await fixture()
  try {
    const result = await f.voice()
    assert.equal(f.requests(), 1, '正常新采矿命令只调用一次理解')
    assert.equal(f.runtime.programs.get('global')!.script, undefined)
    assert.match(result, /不区分矿种/)
    assert.ok(f.goals().every(goal => goal.spec.kind === 'mining'))
    await f.observer.poll(f.ctx)
    await f.tick()
    const gathers = f.submitted.filter(action => action.kind === 'gather')
    assert.equal(gathers.length, 2)
    assert.ok(gathers.every(action => action.kind === 'gather' && action.unitIds.length === 1 && [11, 12].includes(action.unitIds[0]!)))
    assert.equal(new Set(gathers.map(action => action.kind === 'gather' ? `${action.x},${action.y}` : '')).size, 2)
    assert.equal(f.runtime.goalExecution(f.goals()[0]!.spec.id)!.state, 'continuous')
    const sent = f.submitted.length, requests = f.requests()
    f.busy(true, true)
    f.ore.clear()
    await f.tick(360); await f.observer.poll(f.ctx); await f.tick(60)
    assert.equal(f.submitted.length, sent, '忙碌矿车不受矿点耗尽影响，继续返厂和卸货')
    f.ore.add((f.point.y + 1) * 200 + f.point.x)
    await f.observer.poll(f.ctx)
    f.busy(false)
    await f.tick(60); await f.tick(60)
    assert.equal(f.submitted.filter(action => action.kind === 'gather').length, 4)
    assert.equal(f.requests(), requests, '搜索和执行不逐步调用云模型')
    assert.ok(f.submitted.every(action => action.kind !== 'produce'))
  } finally { await f.dispose() }
})

test('重编和同局恢复保留采矿发令事实；取消后迟到观察不能接管矿车', async () => {
  const f = await fixture()
  try {
    await f.voice(); await f.observer.poll(f.ctx); await f.tick()
    f.busy(true)
    await f.tick()
    const before = f.submitted.length
    await f.ctx.controller.refresh('global'); await f.tick(120)
    assert.equal(f.submitted.length, before)
    const restored = await harness(f.executor, { formations: new FormationRegistry() })
    await restored.runtime.onSnapshot(f.runtime.snapshot!)
    restoreState(restored.runtime, JSON.parse(JSON.stringify(persistState(f.runtime))))
    await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 1, tick: f.runtime.snapshot!.tick + 300 })
    assert.deepEqual(restored.submitted, [])
    const pending = deferred<{ seen: number[]; impassable: number[]; ore: number[] }>(), started = deferred<void>()
    f.ctx.bridge.readMapBatch = async () => { started.resolve(); return pending.promise }
    const goal = f.goals()[0]!, prior = JSON.stringify(goal.facts.mining)
    const polling = f.observer.poll(f.ctx)
    await started.promise
    await f.runtime.cancelGoal(goal.spec.id)
    pending.resolve({ seen: [f.point.y * 200 + f.point.x], impassable: [], ore: [f.point.y * 200 + f.point.x] })
    await polling
    assert.equal(JSON.stringify(goal.facts.mining), prior)
    assert.ok(f.submitted.some(action => action.kind === 'stop'))
    await f.tick(120)
    assert.equal(f.submitted.filter(action => action.kind === 'gather').length, 2)
  } finally { await f.dispose() }
})

test('已编队和未编队矿车使用各自控制对象；单车改令保留其他矿车的任务', async () => {
  const f = await fixture(true)
  try {
    await f.voice()
    assert.equal(f.requests(), 1, '多个控制对象的本机采矿不额外生成脚本')
    assert.deepEqual(f.goals().map(goal => goal.ownerId).sort(), ['formation:矿队', 'global'])
    await f.observer.poll(f.ctx); await f.tick(); await f.observer.poll(f.ctx); await f.tick()
    assert.equal(f.submitted.filter(action => action.kind === 'gather').length, 2)
    const global = f.goals().find(goal => goal.ownerId === 'global')!, grouped = f.goals().find(goal => goal.ownerId !== 'global')!
    const catalog = await import('../apps/companion/src/game-catalog.ts').then(module => module.loadGameCatalog(f.ctx, () => {}, loadPrompts().game))
    await executeCapabilities([{ capability: 'management.rally', params: { unitIds: [12], x: 30, y: 30 } }], f.ctx, { text: '12号矿车去30,30', catalog })
    assert.equal(global.status, 'cancelled')
    assert.equal(grouped.status, 'active')
    assert.equal(f.runtime.formations.ownerOf(11), '矿队')
  } finally { await f.dispose() }
})

test('编队脚本与本机采矿双向改令，撤销迟到候选并保留真实成员归属', async () => {
  const f = await fixture(true)
  try {
    activate(f.runtime, spec({ id: 'old-tactics', formationId: '矿队', region: { name: '全图', x1: 0, y1: 0, x2: 199, y2: 199 } }))
    const program = f.runtime.programs.get('formation:矿队')!, oldScript = program.script
    const lease = f.runtime.beginCompile(program.id)
    await f.voice()
    const mining = f.goals().find(goal => goal.ownerId === program.id)!
    assert.equal(lease.signal.aborted, true)
    assert.equal(f.runtime.commitCompile(lease, source), false)
    assert.equal(f.runtime.goals.get('old-tactics')!.status, 'cancelled')
    assert.equal(program.script, oldScript, '本机改令不增加代码版本')
    assert.deepEqual(program.activeGoalIds, [mining.spec.id])
    await f.observer.poll(f.ctx); await f.tick(); await f.observer.poll(f.ctx); await f.tick()
    const gathered = f.submitted.filter(action => action.kind === 'gather' && action.unitIds.includes(11)).length
    activate(f.runtime, spec({ id: 'new-tactics', formationId: '矿队', region: { name: '全图', x1: 0, y1: 0, x2: 199, y2: 199 } }))
    assert.equal(mining.status, 'cancelled')
    assert.deepEqual(program.activeGoalIds, ['new-tactics'])
    await f.tick(300)
    assert.equal(f.submitted.filter(action => action.kind === 'gather' && action.unitIds.includes(11)).length, gathered)
    assert.equal(f.runtime.formations.ownerOf(11), '矿队')
  } finally { await f.dispose() }
})

test('复合命令的全局生成等待或失败时，另一编队的本机采矿先执行', async () => {
  for (const fail of [false, true]) {
    const f = await fixture(true), started = deferred<void>(), release = deferred<void>()
    const provider = { generate: async () => {
      started.resolve(); await release.promise
      if (fail) throw new Error('fixture 生成失败')
      return reply(code)
    } }
    f.ctx.controller = new ProgramController({ runtime: f.runtime, executor: f.executor, provider: () => provider as never })
    const prompts = loadPrompts(), catalog = await import('../apps/companion/src/game-catalog.ts').then(module => module.loadGameCatalog(f.ctx, () => {}, prompts.game))
    const pending = executeCapabilities([
      { capability: 'production.produce', params: { target: 'MTNK', quantity: 1 } },
      { capability: 'economy.gather', params: { regionName: '一楼', formationId: '矿队' } },
    ], f.ctx, { text: '造一辆坦克，矿队去一楼采矿', prompts, catalog })
    try {
      await Promise.race([started.promise, pending.then(() => { throw new Error('应当进入全局脚本生成') })])
      const mining = f.goals()[0]!
      assert.equal(mining.status, 'active', '无需等待全局模型返回')
      await f.observer.poll(f.ctx); await f.tick()
      assert.ok(f.submitted.some(action => action.kind === 'gather' && action.unitIds.includes(11)))
      assert.equal(f.runtime.programs.get('global')!.script, undefined)
      release.resolve(); await pending
      assert.equal(mining.status, 'active', '其他对象生成失败不撤销已经执行的采矿')
      assert.equal(!!f.runtime.programs.get('global')!.compileError, fail)
    } finally { release.resolve(); await pending; await f.dispose() }
  }
})

test('直接采矿无模型；暂停恢复与按能力回退保留发令事实', async () => {
  const f = await fixture(true)
  try {
    const catalog = await import('../apps/companion/src/game-catalog.ts').then(module => module.loadGameCatalog(f.ctx, () => {}, loadPrompts().game))
    await executeCapabilities([{ capability: 'economy.gather', params: { regionName: '一楼' } }], f.ctx, { text: '所有矿车采一楼', catalog })
    assert.equal(f.requests(), 0)
    await handleCommand('global pause', f.ctx)
    await handleCommand('task pause @矿队', f.ctx)
    await f.observer.poll(f.ctx); await f.tick()
    assert.deepEqual(f.submitted, [])
    await handleCommand('global resume', f.ctx)
    await handleCommand('task resume @矿队', f.ctx)
    await f.observer.poll(f.ctx); await f.tick(); await f.observer.poll(f.ctx); await f.tick()
    const sent = f.submitted.length
    f.busy(true); await f.tick()
    const facts = f.goals().map(goal => structuredClone(goal.facts.mining))
    f.ctx.controller.useScriptExecution(['mining'])
    assert.deepEqual(f.goals().map(goal => goal.facts.mining), facts)
    for (const owner of ['global', 'formation:矿队']) await f.ctx.controller.refresh(owner)
    await f.tick(120)
    assert.equal(f.submitted.length, sent)
    assert.ok(f.goals().every(goal => goal.activeSpec!.executionMode === 'script'))
    assert.equal(f.requests(), 2, '回退后每个对象生成一次脚本')
  } finally { await f.dispose() }
})
