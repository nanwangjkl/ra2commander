import test from 'node:test'
import assert from 'node:assert/strict'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { FormationRegistry, persistState, restoreState, type RuntimeDeps } from '../packages/runtime/src/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { executeCapabilities } from '../apps/companion/src/capabilities/index.ts'
import { GameCatalog } from '../apps/companion/src/game-catalog.ts'
import { loadPrompts } from '../packages/command/src/index.ts'
import { loadIceMap } from '../apps/companion/src/map-binding.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { inTargetRegion, type ActionRequest, type SnapshotUnit, type RelocateGoal, type ProductionGoal } from '../packages/contracts/src/index.ts'
import { harness, snapshot } from './helpers.ts'

const source = `function step(s,m){const actions=[];for(const g of s.control.goals){if(g.blocked)continue;
if(g.spec.kind==='relocate'&&g.relocation.action)actions.push({goalId:g.spec.id,request:g.relocation.action});
if(g.spec.kind==='production'){for(const name of g.productionPlan.readyToPlace)actions.push({goalId:g.spec.id,request:{kind:'place',name}});for(const name of g.productionPlan.availableToProduce)actions.push({goalId:g.spec.id,request:{kind:'produce',name,quantity:1}});}}
return {actions,memory:m}}`
const yard: SnapshotUnit = { id: 100, name: 'GACNST', type: 2, rx: 50, ry: 50, isIdle: true }

async function fixture(rejectFirst = false, staleFirst = false, startVehicle = false) {
  const executor = new StepExecutor(), actions: ActionRequest[] = []
  let own = [startVehicle ? { ...yard, name: 'AMCV', type: 7, canDeploy: true } : yard], ready = false, nextId = 200, rejected = false
  const submit: RuntimeDeps['submit'] = async (requests, context, guard) => {
    if (!guard()) return []
    const results = []
    for (const request of requests) {
      actions.push(request)
      if (request.kind === 'move') {
        const unit = own.find(unit => request.unitIds.includes(unit.id))!
        own = own.filter(other => other.id !== unit.id)
        own.push(unit.type === 2 ? { ...unit, id: nextId++, name: 'AMCV', type: 7, canDeploy: true } : { ...unit, rx: request.x, ry: request.y })
      } else if (request.kind === 'deploy') {
        if (rejectFirst && !rejected) { rejected = true; results.push({ ok: false, submitted: 0, reason: 'deploy-rejected', session: context.session }); continue }
        const unit = own.find(unit => request.unitIds.includes(unit.id))!
        own = [...own.filter(other => other.id !== unit.id), { ...unit, id: nextId++, name: 'GACNST', type: 2, canDeploy: false }]
      } else if (request.kind === 'produce' || request.kind === 'place') {
        assert.equal([...runtime.goals.values()].find(goal => goal.spec.kind === 'relocate')?.status, 'completed', '搬迁完成前不得在旧址生产或放置后续矿场')
        if (request.kind === 'produce') ready = true
        else {
          const base = own.find(unit => unit.name === 'GACNST')!
          const point = { x: base.rx + 1, y: base.ry + 1 }
          assert.ok(request.placementRegion && inTargetRegion(point.x, point.y, request.placementRegion))
          own.push({ ...yard, id: nextId++, name: 'GAREFN', rx: point.x, ry: point.y }); ready = false
        }
      }
      results.push({ ok: true, submitted: 1, session: context.session })
    }
    return results
  }
  const env = await harness(executor, { formations: new FormationRegistry(), checkpoint: () => {}, submit })
  let runtime = env.runtime
  const current = () => snapshot({ seq: runtime.snapshot!.seq + 1, tick: runtime.snapshot!.tick + 30, self: [...own], mapWidth: 200, mapHeight: 200,
    production: { ...snapshot().production!, available: ['GAREFN'], queues: [{ type: 0, status: ready ? 3 : 0, size: ready ? 1 : 0, maxSize: 1, items: ready ? [{ name: 'GAREFN', quantity: 1, progress: 1, creditsEach: 1, creditsSpent: 1 }] : [] }] } })
  await runtime.onSnapshot(current())
  const prompts = loadPrompts(), { regions } = await loadIceMap()
  const catalog = new GameCatalog([
    { name: 'GACNST', type: 2, power: 0, available: false, aliases: ['基地'], roles: ['constructionYard'], factions: [], undeploysInto: 'AMCV' },
    { name: 'AMCV', type: 7, power: 0, available: false, aliases: ['基地车'], roles: ['constructionVehicle'], factions: [], deploysInto: 'GACNST' },
    { name: 'GAREFN', type: 2, power: -50, available: true, aliases: ['矿场'], roles: ['refinery'], factions: [] },
  ], runtime.snapshot!, prompts.game)
  let generations = 0
  const controller = new ProgramController({ runtime, executor, provider: () => ({ generate: async () => ({ text: staleFirst && generations++ === 0 ? `function step(s,m){const g=s.control.goals.find(g=>g.spec.kind==='relocate');return {actions:[{goalId:g.spec.id,request:{kind:'move',unitIds:[g.spec.unitId],x:g.spec.destination.x,y:g.spec.destination.y}}],memory:m}}` : source, model: 'fixture', durationMs: 0 }) }) as never,
    prepare: async goals => goals.map(goal => goal.kind === 'production' ? { ...goal, targetType: 2, queueTypes: { GAREFN: 0 } } : goal) })
  const ctx = { runtime, formations: runtime.formations, controller, mapRegions: regions, mapSessionKey: runtime.battleKey } as unknown as CommandContext
  const run = () => executeCapabilities([
    // 即使模型顺序颠倒，宿主也要先绑定搬迁依赖。
    { capability: 'production.produce', params: { target: '矿场', quantity: 1, placementAnchor: '一楼' } },
    { capability: 'base.relocate', params: { regionName: '一楼' } },
  ], ctx, { text: '把基地搬到一楼，在一楼造一个矿场', prompts, catalog })
  return { get runtime() { return runtime }, executor, ctx, actions, run, generations: () => generations, tick: () => runtime.onSnapshot(current()),
    restore: async () => {
      const saved = persistState(runtime)
      const restored = await harness(executor, { formations: new FormationRegistry(), submit, checkpoint: () => {} })
      await restored.runtime.onSnapshot(current())
      restoreState(restored.runtime, JSON.parse(JSON.stringify(saved)))
      runtime = restored.runtime; ctx.runtime = runtime; ctx.formations = runtime.formations
    },
    own: () => own,
  }
}

test('基地搬迁换ID、候选展开与后续区域矿场按真实状态串联', async () => {
  const f = await fixture(true)
  try {
    const result = await f.run()
    assert.deepEqual(result.skipped, [])
    const relocation = result.goals.find(goal => goal.kind === 'relocate') as RelocateGoal
    const mine = result.goals.find(goal => goal.kind === 'production') as ProductionGoal
    assert.equal(mine.afterGoalId, relocation.id)
    assert.equal(mine.placementRegion!.name, '一楼')
    for (let n = 0; n < 12 && f.runtime.goals.get(mine.id)?.status !== 'completed'; n++) await f.tick()
    assert.equal(f.runtime.goals.get(relocation.id)!.status, 'completed')
    assert.equal(f.runtime.goals.get(mine.id)!.status, 'completed')
    assert.ok(f.runtime.goals.get(relocation.id)!.facts.relocation!.unitId !== relocation.unitId)
    assert.equal(f.actions.filter(action => action.kind === 'deploy').length, 2)
    assert.equal(f.actions.filter(action => action.kind === 'produce').length, 1)
    assert.ok(inTargetRegion(f.own().find(unit => unit.name === 'GACNST')!.rx, f.own().find(unit => unit.name === 'GACNST')!.ry, relocation.targetRegion!))
  } finally { await f.executor.dispose() }
})

test('搬迁中取消会停车；依赖矿场保持受阻，不在旧址补建', async () => {
  const f = await fixture()
  try {
    const result = await f.run(), relocation = result.goals.find(goal => goal.kind === 'relocate')!, mine = result.goals.find(goal => goal.kind === 'production')!
    await f.tick(); await f.tick()
    const currentId = f.runtime.goals.get(relocation.id)!.facts.relocation!.unitId
    await f.runtime.cancelGoal(relocation.id)
    for (let n = 0; n < 3; n++) await f.tick()
    assert.ok(f.actions.some(action => action.kind === 'stop' && action.unitIds.includes(currentId)))
    assert.ok(f.actions.every(action => action.kind !== 'deploy' && action.kind !== 'produce'))
    assert.match(f.runtime.goalExecution(mine.id)!.detail!, /取消.*未在旧址建造/)
  } finally { await f.executor.dispose() }
})

test('变形交接期间保存重连，继续跟踪新基地且不重放收起或生产', async () => {
  const f = await fixture()
  try {
    const result = await f.run(), mine = result.goals.find(goal => goal.kind === 'production')!
    await f.tick() // 引擎已转成基地车，宿主下一次采样前保存。
    await f.restore()
    for (let n = 0; n < 10 && f.runtime.goals.get(mine.id)!.status !== 'completed'; n++) await f.tick()
    assert.equal(f.runtime.goals.get(mine.id)!.status, 'completed')
    assert.equal(f.actions.filter(action => action.kind === 'move' && action.unitIds.includes(yard.id)).length, 1)
    assert.equal(f.actions.filter(action => action.kind === 'produce').length, 1)
  } finally { await f.executor.dispose() }
})

test('缓存旧基地ID的候选代码会在生效前反馈模型重新生成', async () => {
  const f = await fixture(false, true)
  try {
    const result = await f.run()
    assert.deepEqual(result.skipped, [])
    assert.equal(f.generations(), 2)
    assert.equal(f.actions.length, 0, '所有阶段检查均为隔离试跑')
    assert.equal(f.runtime.programs.get('global')!.script!.version, 1)
  } finally { await f.executor.dispose() }
})

test('已有基地车直接移动和展开，不追加生产基地车', async () => {
  const f = await fixture(false, false, true)
  try {
    const result = await f.run(), relocation = result.goals.find(goal => goal.kind === 'relocate')!
    for (let n = 0; n < 8 && f.runtime.goals.get(relocation.id)!.status !== 'completed'; n++) await f.tick()
    assert.equal(f.runtime.goals.get(relocation.id)!.status, 'completed')
    assert.equal(f.actions.filter(action => action.kind === 'move').length, 1)
    assert.equal(f.actions.filter(action => action.kind === 'deploy').length, 1)
    assert.ok(f.actions.every(action => action.kind !== 'produce' || action.name === 'GAREFN'))
  } finally { await f.executor.dispose() }
})
