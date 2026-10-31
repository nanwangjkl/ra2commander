import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPrompts, type GameDataEntry } from '../packages/command/src/index.ts'
import { computePrerequisiteClosure } from '../packages/runtime/src/index.ts'
import { loadGameCatalog } from '../apps/companion/src/game-catalog.ts'
import { prepareGoals } from '../apps/companion/src/prepare-goals.ts'
import { executeCapabilities } from '../apps/companion/src/capabilities/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { runTranscript } from '../apps/companion/src/transcript.ts'
import { TaskRuntime } from '../packages/runtime/src/index.ts'
import type { ActionRequest, Snapshot, SnapshotUnit } from '../packages/contracts/src/index.ts'
import { harness, production, snapshot } from './helpers.ts'

const profile = loadPrompts().game
const rule = (item: GameDataEntry) => ({ ...item, label: item.englishName, buildCat: item.buildCat === 'Combat' ? 0 : 1 })
const rules = async (name: string, type: number) => { const item = profile.entry(name); return item?.defined && item.type === type ? rule(item) : undefined }
const yard = (name = 'GACNST'): SnapshotUnit => ({ id: 100, name, type: 2, rx: 50, ry: 50, elevation: 0, isIdle: true })

test('重放最新反馈：电厂和飞机都进入理解候选，原样的“飞机”可生产四架，无需重决策', async () => {
  const executor = new StepExecutor(), root = mkdtempSync(join(tmpdir(), 'ra2c-category-'))
  try {
    const { runtime, formations, submitted } = await harness(executor)
    const initial = snapshot({ seq: 2, country: 'French', self: [yard(), ...['GAPOWR', 'GAREFN', 'GAAIRC'].map((name, i) => ({ ...yard(name), id: 101 + i }))],
      production: { ...snapshot().production!, available: ['GAPOWR', 'ORCA'], queues: [0, 4].map(type => ({ type, status: 0, size: 0, maxSize: 5, items: [] })) } })
    await runtime.onSnapshot(initial)
    let interpretations = 0, compilations = 0
    const source = `function step(s,m){const actions=[];for(const g of s.control.goals){if(g.spec.kind==='production'&&g.productionPlan.availableToProduce.includes(g.spec.target))actions.push({goalId:g.spec.id,request:{kind:'produce',name:g.spec.target,quantity:g.produceRemaining[g.spec.target]}});}return {actions,memory:m}}`
    const provider = { generate: async ({ messages }: { messages: Array<{ content: string }> }) => {
      const input = JSON.parse(messages[1]!.content)
      assert.ok(!input.failures, '类别名在宿主绑定，不应浪费一次失败重决策')
      if ('text' in input) {
        interpretations++
        assert.ok(input.catalog.some((item: { name: string }) => item.name === 'GAPOWR'))
        assert.ok(input.catalog.some((item: { name: string; roles: string[] }) => item.name === 'ORCA' && item.roles.includes('aircraft')))
        return { text: '{"summary":"补建1座电厂，并生产4架飞机（盟军战机）。","operations":[{"capability":"production.produce","params":{"target":"电厂","quantity":1}},{"capability":"production.produce","params":{"target":"飞机","quantity":4}}]}', model: 'fixture', durationMs: 0 }
      }
      compilations++
      return { text: source, model: 'fixture', durationMs: 0 }
    } }
    const controller = new ProgramController({ runtime, executor, provider: () => provider as never,
      prepare: (goals, signal, prompts) => prepareGoals(goals, runtime.snapshot!, rules, signal, prompts.game) })
    const ctx = { runtime, formations, controller, currentProvider: () => provider, bridge: { rules } } as unknown as CommandContext
    const result = await runTranscript('补一个电厂，造 4 个飞机', ctx, root)
    assert.doesNotMatch(result, /未执行|未找到/)
    assert.deepEqual([...runtime.goals.values()].flatMap(goal => goal.spec.kind === 'production' ? [[goal.spec.target, goal.spec.quantity]] : []), [['GAPOWR', 1], ['ORCA', 4]])
    assert.equal(interpretations, 1); assert.equal(compilations, 0)
    await runtime.onSnapshot({ ...initial, seq: 3, tick: initial.tick + 30 })
    assert.deepEqual(submitted.filter(action => action.kind === 'produce').map(action => [action.name, action.quantity]), [['GAPOWR', 1], ['ORCA', 4]])
  } finally { await executor.dispose(); rmSync(root, { recursive: true, force: true }) }
})

test('通用类别按本国、可造性选具体项目，未解锁和新 MOD 飞机不依赖逐机别名', async () => {
  const { runtime } = await harness()
  for (const [country, available, expected] of [['French', ['GAPOWR', 'CMIN'], 'ORCA'], ['Alliance', ['BEAG'], 'BEAG'], ['French', ['NEWPLANE'], 'NEWPLANE']] as const) {
    await runtime.onSnapshot(snapshot({ seq: runtime.snapshot!.seq + 1, country, self: [yard()], production: { ...snapshot().production!, available: [...available] } }))
    const liveRules = async (name: string, type: number) => name === 'NEWPLANE' && type === 1 ? { label: 'MOD 新战机', prerequisite: ['RADAR'], techLevel: 3 } : rules(name, type)
    const catalog = await loadGameCatalog({ runtime, bridge: { rules: liveRules } } as unknown as CommandContext, () => {}, profile)
    assert.equal(catalog.resolve('飞机')?.name, expected)
    assert.equal(catalog.resolve('aircraft')?.name, expected)
    assert.equal(catalog.resolve('犀牛')?.name, 'MTNK', '类别补充不能把同类坦克替代变成生产矿车')
    assert.equal(catalog.resolve('坦克')?.name, 'MTNK', '通用生产也按角色类型选单位，不能选成部署后的建筑')
    const supplied = catalog.forTranscript('补一个电厂，造飞机，再出步兵和车辆')
    assert.ok(supplied.some(item => item.name === 'GAPOWR'))
    assert.ok(supplied.some(item => item.name === expected))
    assert.ok([1, 3, 7].every(type => supplied.some(item => item.type === type)), '每个提及类别各自保留候选')
    assert.equal(catalog.resolve('HORNET'), undefined, '不能把航母自动产生的飞机当普通生产候选')
  }
})

test('完整中文目录在巨炮尚未解锁时仍能绑定；类别前置自动递归，本局规则可覆盖导入数据', async () => {
  const runtime = new TaskRuntime({ executor: { run: async () => ({ ok: true, actions: [], memory: {} }) }, submit: async () => [], checkpoint: () => {} })
  const initial = snapshot({ country: 'French', self: [yard()], production: { ...snapshot().production!, available: ['GAPOWR'] } })
  await runtime.onSnapshot(initial)
  const catalog = await loadGameCatalog({ runtime, bridge: { rules } } as unknown as CommandContext, () => {}, profile)
  assert.ok(profile.entries().length > 400)
  assert.equal(catalog.resolve('巨炮')!.name, 'GTGCAN')
  assert.equal(catalog.resolve('巨炮')!.available, false)
  assert.equal(catalog.resolve('灰熊坦克')!.name, 'MTNK', '中文同名优先生产单位，不能误选部署建筑')
  assert.equal(catalog.resolve('灰熊坦克', { mobile: true })!.name, 'MTNK')
  assert.equal(catalog.resolve('DMTK')!.name, 'DMTK', '明确原生 ID 仍保留玩家选择')
  const latest = await executeCapabilities([
    { capability: 'production.produce', params: { target: '盟军战车工厂', quantity: 1 } },
    { capability: 'production.produce', params: { target: '灰熊坦克', quantity: 5, formationId: '1队' } },
  ], { runtime, formations: runtime.formations, controller: { activateNative: () => '绑定检查', refresh: async () => '绑定检查' } } as unknown as CommandContext, { text: '造重工，出5台坦克编入1队', catalog })
  assert.deepEqual(latest.skipped, [])
  assert.deepEqual(latest.goals.flatMap(goal => goal.kind === 'production' ? [[goal.target, goal.quantity]] : []), [['GAWEAP', 1], ['MTNK', 5]])
  const supplied = catalog.forTranscript('补两个电厂，在基地上方，左边和右边各造一个巨炮')
  assert.ok(supplied.some(item => item.name === 'GTGCAN' && !item.available))
  assert.ok(supplied.length < catalog.all.length)
  const prepared = await prepareGoals([production({ target: 'GTGCAN' })], initial, rules, new AbortController().signal, profile)
  assert.deepEqual(prepared[0]!.kind === 'production' && prepared[0]!.prerequisites, ['GAPOWR', 'GAREFN', 'GAAIRC'])
  const american = await prepareGoals([production({ target: 'GATECH' })], { ...initial, country: 'Americans' }, rules, new AbortController().signal, profile)
  assert.ok(american[0]!.kind === 'production' && american[0]!.prerequisites.includes('AMRADR'))
  assert.ok(american[0]!.kind === 'production' && !american[0]!.prerequisites.includes('GAAIRC'))
  const override = await prepareGoals([production({ target: 'GTGCAN' })], initial, async (name, type) => { const r = await rules(name, type); return name === 'GTGCAN' && r ? { ...r, prerequisite: ['GATECH', 'GACNST'] } : r }, new AbortController().signal, profile)
  assert.ok(override[0]!.kind === 'production' && override[0]!.prerequisites.includes('GATECH'))
  const facility = await prepareGoals([production({ target: 'ADOG' })], initial, async (name, type) => { const r = await rules(name, type); return name === 'ADOG' && r ? { ...r, prerequisite: [], factory: 0 } : r }, new AbortController().signal, profile)
  assert.ok(facility[0]!.kind === 'production' && facility[0]!.prerequisites.includes('GAPILE'), '单位的科技前置即使为空，仍按类型补齐生产设施')
  const limited = await prepareGoals([production({ target: 'GTGCAN' })], { ...initial, country: 'British' }, rules, new AbortController().signal, profile)
  assert.ok(limited[0]!.kind === 'production' && limited[0]!.unlockConditions!.some(condition => /限定国家/.test(condition.reason)))
})

test('统一规则规划回放巨炮反馈：自动补电厂、矿场、空指部，共享前置与明确数量，保留逐座方位', async () => {
  const executor = new StepExecutor(), actions: ActionRequest[] = [], queues = new Map<number, string>()
  let own = [yard()], nextId = 200, seq = 0
  const source = `function step(s,m){const actions=[];for(const g of s.control.goals){if(g.spec.kind!=='production')continue;for(const name of g.productionPlan.readyToPlace)actions.push({goalId:g.spec.id,request:{kind:'place',name}});for(const name of g.productionPlan.availableToProduce)actions.push({goalId:g.spec.id,request:{kind:'produce',name,quantity:1}});}return {actions,memory:m}}`
  const available = () => profile.entries().filter(item => item.defined && item.techLevel >= 0 && !profile.limitation(item.name, 'French') && item.prerequisite.every(dep => (profile.categories(own)[dep] ?? [dep]).some(name => own.some(unit => unit.name === name)))).map(item => item.name)
  const current = (): Snapshot => snapshot({ seq: ++seq, tick: seq * 15, country: 'French', self: own, production: { ...snapshot().production!, available: available(), queues: [0, 1].map(type => ({ type, status: queues.has(type) ? 3 : 0, size: queues.has(type) ? 1 : 0, maxSize: 1, items: queues.has(type) ? [{ name: queues.get(type)!, quantity: 1, progress: 1, creditsEach: 1, creditsSpent: 1 }] : [] })) } })
  const runtime = new TaskRuntime({ executor, checkpoint: () => {}, submit: async (requests, ctx, guard) => {
    if (!guard()) return []
    for (const request of requests) {
      actions.push(request)
      if (request.kind === 'produce') {
        assert.ok(available().includes(request.name), `尚未解锁就尝试生产 ${request.name}`)
        queues.set(profile.entry(request.name)!.buildCat === 'Combat' ? 1 : 0, request.name)
      } else if (request.kind === 'place') {
        if (![...queues.values()].includes(request.name)) continue
        const point = request.placement?.direction === 'up' ? [46, 46] : request.placement?.direction === 'left' ? [46, 54] : request.placement?.direction === 'right' ? [54, 46] : [52, 50]
        own = [...own, { ...yard(), id: nextId++, name: request.name, rx: point[0]!, ry: point[1]! }]
        queues.delete(profile.entry(request.name)!.buildCat === 'Combat' ? 1 : 0)
      }
    }
    return requests.map(() => ({ ok: true, submitted: 1, session: ctx.session }))
  } })
  try {
    await runtime.onSnapshot(current())
    const catalog = await loadGameCatalog({ runtime, bridge: { rules } } as unknown as CommandContext, () => {}, profile)
    const controller = new ProgramController({ runtime, executor, provider: () => ({ generate: async () => ({ text: source, model: 'fixture', durationMs: 0 }) }) as never, prepare: (goals, signal, prompts) => prepareGoals(goals, runtime.snapshot!, rules, signal, prompts.game) })
    const ctx = { runtime, formations: runtime.formations, controller, bridge: {} } as unknown as CommandContext
    const result = await executeCapabilities([
      { capability: 'production.produce', params: { target: '电厂', quantity: 2 } },
      { capability: 'production.produce', params: { target: '巨炮', quantity: 3, placementDirections: ['up', 'left', 'right'], placementAnchor: '基地' } },
    ], ctx, { text: '补两个电厂，在基地上方，左边和右边各造一个巨炮', catalog })
    assert.deepEqual(result.skipped, [])
    for (let n = 0; n < 25 && result.goals.some(goal => runtime.goalExecution(goal.id)?.state !== 'completed'); n++) await runtime.onSnapshot(current())
    assert.ok(result.goals.every(goal => runtime.goalExecution(goal.id)?.state === 'completed'))
    assert.equal(own.filter(unit => unit.name === 'GTGCAN').length, 3)
    assert.equal(own.filter(unit => unit.name === 'GAPOWR').length, 2)
    assert.equal(actions.filter(action => action.kind === 'place' && action.name === 'GAPOWR').length, 2)
    assert.equal(own.filter(unit => unit.name === 'GAREFN').length, 1)
    assert.equal(own.filter(unit => unit.name === 'GAAIRC').length, 1)
    const placed = actions.flatMap(action => action.kind === 'place' && action.name === 'GTGCAN' ? [action.placement!.direction] : [])
    assert.deepEqual(placed, ['up', 'left', 'right'])
  } finally { await executor.dispose() }
})

test('类别候选失败不会污染其他分支；循环前置被识别，真实可造性优先于目录限制', async () => {
  const plan = await computePrerequisiteClosure('TARGET', { available: async () => [], categories: { RADAR: ['BAD', 'GOOD'] }, prerequisites: async name => ({ TARGET: ['RADAR'], BAD: ['TARGET'], GOOD: [] })[name] }, [])
  assert.deepEqual(plan.toBuild, ['GOOD'])
  assert.deepEqual(plan.blocked, [])
  const built = await computePrerequisiteClosure('GTGCAN', { available: async () => ['GTGCAN'], prerequisites: async () => undefined, restriction: async () => ({ reason: '目录提示可能受限' }) }, [])
  assert.deepEqual(built.blocked, [])
})
