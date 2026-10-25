import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { loadGameCatalog } from '../apps/companion/src/game-catalog.ts'
import { prepareGoals } from '../apps/companion/src/prepare-goals.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { compileCommand, loadPrompts, PromptLoader, readPrompts } from '../packages/command/src/index.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { computePrerequisiteClosure } from '../packages/runtime/src/index.ts'
import { code, harness, outcome, production, snapshot, spec } from './helpers.ts'

function assets() {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-game-rules-'))
  for (const directory of ['templates', 'capabilities', 'games', 'tactics']) cpSync(new URL(`../prompts/${directory}/`, import.meta.url), join(root, 'prompts', directory), { recursive: true })
  cpSync(new URL('../skills/', import.meta.url), join(root, 'skills'), { recursive: true })
  const url = pathToFileURL(join(root, 'prompts/templates') + sep)
  return { root, url, loader: new PromptLoader(url), dispose: () => rmSync(root, { recursive: true, force: true }) }
}
const reply = (text: string) => ({ text, model: 'fixture', durationMs: 0 })

test('同一目录按真实可造项、阵营和角色选项目，当前中国阵营与侦察犬可绑定', async () => {
  const profile = loadPrompts().game
  for (const [yard, expected] of [['GACNST', 'MTNK'], ['NACNST', 'HTNK'], ['CACNST', 'LTNK']]) {
    const { runtime } = await harness()
    const snap = snapshot({ seq: 2, self: [{ ...snapshot().self[0]!, name: yard!, type: 2 }], production: { power: { drain: 0, total: 100, isLowPower: false }, queues: [], available: [expected!, 'DOG'] } })
    await runtime.onSnapshot(snap)
    const rules = async (name: string, type: number) => ['MTNK', 'HTNK', 'LTNK'].includes(name) && type === 7 ? { label: name, prerequisite: [] }
      : ['DOG', 'ADOG'].includes(name) && type === 3 ? { label: name, prerequisite: [] } : undefined
    const catalog = await loadGameCatalog({ runtime, bridge: { rules } } as unknown as CommandContext, () => {}, profile)
    assert.equal(catalog.resolve('坦克')!.name, expected)
    assert.equal(catalog.resolve('侦察犬')!.name, 'DOG', '实际可造项目优先于静态阵营候选')
  }
})

test('只改 Markdown 候选即可绑定新名称；实时规则可覆盖静态角色提示', async () => {
  const files = assets()
  try {
    const file = join(files.root, 'prompts/games/current-mod.md')
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('MTNK', 'CUSTOMTANK'))
    const profile = files.loader.load().game
    const { runtime } = await harness()
    const unit = { ...snapshot().self[0]!, name: 'CUSTOMTANK' }
    await runtime.onSnapshot(snapshot({ seq: 2, self: [{ ...unit, id: 100, name: 'GACNST', type: 2 }, unit] }))
    let harvester = false
    const rules = async (name: string, type: number) => name === 'CUSTOMTANK' && type === 7 ? { label: '自定义车辆', prerequisite: [], harvester } : undefined
    const catalog = await loadGameCatalog({ runtime, bridge: { rules } } as unknown as CommandContext, () => {}, profile)
    assert.equal(catalog.resolve('灰熊')!.name, 'CUSTOMTANK')
    assert.equal(catalog.matchesUnit(unit, 'tanks'), true)
    harvester = true
    const changed = await loadGameCatalog({ runtime, bridge: { rules } } as unknown as CommandContext, () => {}, profile)
    assert.equal(changed.matchesUnit(unit, 'tanks'), false)
  } finally { files.dispose() }
})

test('前置按当前引擎计算并共享查询，生成和逐步执行使用可造、待建、就绪事实', async () => {
  const profile = loadPrompts().game
  const calls = new Map<string, number>()
  const dictionary: Record<string, string[]> = { CACNST: [], CAPOWR: ['CACNST'], CAREFN: ['POWER', 'CACNST'], CAHAND: ['POWER', 'CACNST'], CAWEAP: ['PROC', 'BARRACKS', 'CACNST'] }
  const rules = async (name: string, type: number) => {
    calls.set(`${name}:${type}`, (calls.get(`${name}:${type}`) ?? 0) + 1)
    return type === 2 && name in dictionary ? { label: name, prerequisite: dictionary[name], power: name === 'CAPOWR' ? 200 : -25 } : undefined
  }
  const yard = { ...snapshot().self[0]!, name: 'CACNST', type: 2 }
  const initial = snapshot({ seq: 2, self: [yard], production: { power: { drain: 0, total: 0, isLowPower: false }, available: ['CAPOWR'], queues: [{ type: 0, status: 0, size: 0, maxSize: 1, items: [] }] } })
  const goals = await prepareGoals([production({ target: 'CAWEAP' }), production({ id: 'refinery', target: 'CAREFN' })], initial, rules, new AbortController().signal, profile)
  assert.ok(calls.get('CAPOWR:2') === 1 && calls.get('CAREFN:2') === 1, '同一准备过程共享规则读取')
  assert.deepEqual((goals[0] as { prerequisites: string[] }).prerequisites, ['CAPOWR', 'CAREFN', 'CAHAND'])
  const source = `function step(s,m){const actions=[];for(const g of s.control.goals){const p=g.productionPlan;if(!p)continue;if(p.readyToPlace.length)actions.push({goalId:g.spec.id,request:{kind:'place',name:p.readyToPlace[0]}});else if(p.availableToProduce.length)actions.push({goalId:g.spec.id,request:{kind:'produce',name:p.availableToProduce[0],quantity:1}});}return {actions,memory:m}}`
  const executor = new StepExecutor()
  try {
    const { runtime, submitted } = await harness(executor)
    await runtime.onSnapshot(initial)
    let compilePlan: unknown
    const controller = new ProgramController({ runtime, executor, provider: () => ({ generate: async (input: { messages: Array<{ content: string }> }) => { compilePlan = JSON.parse(input.messages[1]!.content).control.goals[0].productionPlan; return reply(source) } }) as never,
      prepare: (goals, signal, prompts) => prepareGoals(goals, runtime.snapshot!, rules, signal, prompts.game) })
    await controller.submit(production({ target: 'CAWEAP' }))
    assert.deepEqual((compilePlan as { availableToProduce: string[] }).availableToProduce, ['CAPOWR'])
    await runtime.onSnapshot({ ...initial, seq: 3 })
    await runtime.onSnapshot({ ...initial, seq: 4, production: { ...initial.production!, queues: [{ type: 0, status: 1, size: 1, maxSize: 1, items: [{ name: 'CAPOWR', quantity: 1, progress: 0.5, creditsEach: 500, creditsSpent: 250 }] }] } })
    const lease = runtime.beginCompile('global')
    const waiting = runtime.compileFrame(lease).snapshot.control!.goals[0]!.productionPlan!
    runtime.releaseCommand(lease)
    assert.deepEqual(waiting.pendingPrerequisites, ['CAPOWR'])
    assert.deepEqual(waiting.availableToProduce, [])
    await runtime.onSnapshot({ ...initial, seq: 5, production: { ...initial.production!, queues: [{ type: 0, status: 3, size: 1, maxSize: 1, items: [{ name: 'CAPOWR', quantity: 1, progress: 1, creditsEach: 500, creditsSpent: 500 }] }] } })
    assert.ok(submitted.some(action => action.kind === 'place' && action.name === 'CAPOWR'))
    await runtime.onSnapshot({ ...initial, seq: 6, self: [yard, { ...yard, id: 201, name: 'CAPOWR' }], production: { ...initial.production!, available: ['CAREFN', 'CAHAND'] } })
    assert.deepEqual(submitted.flatMap(action => action.kind === 'produce' ? [action.name] : []), ['CAPOWR', 'CAREFN'])
    const confirmed = await computePrerequisiteClosure('CAWEAP', { categories: profile.categories(initial.self), available: async () => ['CAWEAP'], prerequisites: async () => { throw new Error('可造目标无需重算前置') } }, initial.self)
    assert.deepEqual(confirmed.toBuild, [])
  } finally { await executor.dispose() }
})

test('编译只组合相关战术，校验重试才加入恢复说明，错误重载保持原提示', async () => {
  const prompts = loadPrompts()
  const requests: string[] = []
  const control = { owner: { kind: 'formation' as const, formationId: 'A' }, goals: [{ spec: spec(), unitIds: [1], produceRemaining: {}, submitted: {}, observed: {}, uncertain: [], lossRatio: 0, retreatActive: false }], formations: [] }
  const output = await compileCommand({ generate: async (input: { messages: Array<{ content: string }> }) => { requests.push(input.messages[0]!.content); return reply(requests.length === 1 ? '没有代码' : code) } } as never,
    { snapshot: snapshot({ control }), constraints: { allowedUnitIds: [1], enemyIds: [99], mapWidth: 100, mapHeight: 100 } }, { run: async () => outcome() })
  assert.match(requests[0]!, /# 编队作战/)
  assert.ok(!requests[0]!.includes('# 生产协调') && !requests[0]!.includes('# 异常恢复'))
  assert.match(requests[1]!, /# 异常恢复/)
  assert.ok(output.log[1]!.promptTopics.includes('recovery'))
  assert.ok(!prompts.compileFor([production()]).includes('# 编队作战'))
  const files = assets()
  try {
    const first = files.loader.load()
    const productionFile = join(files.root, 'prompts/tactics/production.md')
    writeFileSync(productionFile, readFileSync(productionFile, 'utf8') + '\n新的生产约定。\n')
    const changed = files.loader.load()
    assert.ok(changed.compileFor([production()]).includes('新的生产约定。'))
    assert.ok(!first.compileFor([production()]).includes('新的生产约定。'))
    writeFileSync(join(files.root, 'prompts/games/current-mod.md'), '损坏的目录')
    const errors: string[] = []
    assert.equal(files.loader.load({ onFallback: error => errors.push(error.message) }), changed)
    assert.match(errors[0]!, /current-mod\.md/)
    assert.throws(() => readPrompts(files.url), /current-mod\.md/)
  } finally { files.dispose() }
})
