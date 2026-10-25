import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPrompts, type CapabilityCall } from '../packages/command/src/index.ts'
import { CAPABILITY_TYPES_FILE, generatedCapabilityTypes } from '../packages/command/src/generate-capabilities.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { CommandLog } from '../apps/companion/src/command-log.ts'
import { handleCommand, type CommandContext } from '../apps/companion/src/commands.ts'
import { runTranscript } from '../apps/companion/src/transcript.ts'
import { validateBindings } from '../apps/companion/src/capabilities/index.ts'
import { prepareGoals } from '../apps/companion/src/prepare-goals.ts'
import { applyCommandEvent, type CardData } from '../apps/companion/ui/command-card.ts'
import { code, deferred, harness, snapshot } from './helpers.ts'

const source = `function step(s,m){const actions=[];for(const g of s.control.goals){const p=g.spec,c=s.constraints.goals[p.id];
 if(p.kind==='formation'){actions.push({goalId:p.id,request:p.request.kind==='dissolveFormation'?p.request:{...p.request,unitIds:g.unitIds}});}
 if(p.kind==='reinforce'&&g.maxUnits>0&&g.unitIds.length){actions.push({goalId:p.id,request:{kind:'transferUnits',formationId:p.formationId,unitIds:g.unitIds.slice(0,g.maxUnits)}});}
 if(p.kind==='rally'&&g.unitIds.length){actions.push({goalId:p.id,request:{kind:'move',unitIds:g.unitIds,x:p.x,y:p.y}});}
 if(p.kind==='production'&&g.produceRemaining[p.target]>0){actions.push({goalId:p.id,request:{kind:'produce',name:p.target,quantity:g.produceRemaining[p.target]}});}
}return {actions,memory:m}}`
const reply = (text: string) => ({ text, model: 'fixture', durationMs: 0 })
const rules = async (name: string, type: number) => ({ MTNK: 7, GI: 3, NAPOWR: 2 }[name] === type ? { label: name === 'MTNK' ? 'Grizzly Battle Tank' : name === 'GI' ? 'GI' : 'Tesla Reactor', prerequisite: [], power: name === 'NAPOWR' ? 200 : 0 } : undefined)
function cards(log: CommandLog) {
  const result = new Map<string, CardData>()
  for (const event of log.since(0)) result.set(event.commandId, applyCommandEvent(event, result.get(event.commandId)))
  return result
}
async function fixture() {
  const executor = new StepExecutor(), root = mkdtempSync(join(tmpdir(), 'ra2c-capabilities-'))
  const { runtime, formations, submitted } = await harness(executor)
  const initial = snapshot({ seq: 2, production: { power: { drain: 0, total: 100, isLowPower: false }, queues: [], available: ['MTNK', 'GI', 'NAPOWR'] },
    self: [...snapshot().self, ...[11, 12, 13, 14].map(id => ({ ...snapshot().self[0]!, id, name: 'GI', type: 3 }))] })
  await runtime.onSnapshot(initial)
  let operations: CapabilityCall[] = [], failCompile = false, generations = 0
  const provider = { generate: async (input: { messages: Array<{ content: string }> }) => {
    if ('text' in JSON.parse(input.messages[1]!.content)) return reply(JSON.stringify({ summary: '模型原始概括', operations }))
    generations++
    if (failCompile) throw new Error('模拟生成失败')
    return reply(source)
  } }
  const controller = new ProgramController({ runtime, executor, provider: () => provider as never,
    prepare: (goals, signal) => prepareGoals(goals, runtime.snapshot!, rules, signal) })
  const log = new CommandLog()
  const ctx = { runtime, formations, controller, commandLog: log, currentProvider: () => provider,
    bridge: { rules, get latest() { return runtime.snapshot }, submit: async (action: never) => { submitted.push(action); return { ok: true, submitted: 1, session: runtime.session } } },
    page: {}, browser: {}, providers: new Map(),
  } as unknown as CommandContext
  return { ctx, runtime, formations, submitted, executor, log, root,
    generations: () => generations,
    failCompile: () => { failCompile = true },
    voice: (calls: CapabilityCall[], text = '执行这些指令') => { operations = calls; return runTranscript(text, ctx, root) },
    tick: () => runtime.onSnapshot({ ...runtime.snapshot!, seq: runtime.snapshot!.seq + 1 }),
    dispose: async () => { await executor.dispose(); rmSync(root, { recursive: true, force: true }) },
  }
}

test('Markdown 参数同时驱动类型、模型说明和校验，能力绑定完整', () => {
  const prompts = loadPrompts()
  validateBindings(prompts)
  assert.equal(readFileSync(CAPABILITY_TYPES_FILE, 'utf8'), generatedCapabilityTypes())
  const definition = prompts.capabilities.definitions().find(definition => definition.id === 'production.produce')!
  const call = prompts.capabilities.parse({ capability: definition.id, params: { target: 'GI' } })
  assert.equal((call.params as { quantity: number }).quantity, definition.parameters.quantity!.default)
  assert.ok(prompts.render('interpret').includes('formation.transfer'))
  assert.throws(() => prompts.capabilities.parse({ capability: 'production.produce', params: { target: 'GI', quantity: '3' } }), /参数类型/)
  assert.throws(() => prompts.capabilities.parse({ capability: 'base.deploy', params: { invented: true } }), /不接受参数/)
  assert.throws(() => prompts.capabilities.assertBindings([]), /缺少实现/)
})

test('终端与模拟语音用同一能力编入现有步兵，实际交接不产生生产', async () => {
  for (const entry of ['cli', 'voice']) {
    const f = await fixture()
    try {
      const call: CapabilityCall = { capability: 'formation.assign', params: { formationId: '一队', selector: 'infantry', quantity: 2 } }
      const output = entry === 'voice' ? await f.voice([call], '两个步兵编入1队') : await handleCommand(`cap ${call.capability} ${JSON.stringify(call.params)}`, f.ctx)
      assert.match(output, /现有2个.*不新增生产/)
      await f.tick()
      assert.deepEqual(f.formations.membersOf('1队'), [11, 12])
      assert.ok(f.submitted.every(action => action.kind !== 'produce'))
    } finally { await f.dispose() }
  }
})

test('转编、持续补员、未编队集结与解散经共同入口落实到真实归属', async () => {
  const f = await fixture()
  try {
    await handleCommand('form create B 11,12', f.ctx); await f.tick()
    await f.voice([{ capability: 'formation.transfer', params: { formationId: 'A', sourceFormationId: 'B', selector: 'infantry', quantity: 1 } }]); await f.tick()
    assert.deepEqual(f.formations.membersOf('B'), [12])
    await f.voice([{ capability: 'management.reinforce', params: { formationId: 'A', target: 'GI', targetSize: 3 } }]); await f.tick()
    assert.deepEqual(f.formations.membersOf('A'), [1, 11, 13, 14])
    await f.voice([{ capability: 'management.rally', params: { selector: 'tanks', x: 20, y: 20 } }]); await f.tick()
    const move = f.submitted.find(action => action.kind === 'move')!
    assert.equal(move.kind, 'move')
    if ('unitIds' in move) assert.deepEqual(move.unitIds, [2, 3, 4, 5, 6, 7, 8, 9, 10])
    await f.voice([{ capability: 'formation.dissolve', params: { formationId: 'B' } }]); await f.tick()
    assert.equal(f.formations.ownerOf(12), undefined)
    assert.ok(!f.formations.list().some(formation => formation.id === 'B'))
  } finally { await f.dispose() }
})

test('暂停恢复不重编；改总量保留已提交进度，取消及失败改令反馈独立并可恢复', async () => {
  const f = await fixture()
  try {
    await f.voice([{ capability: 'production.produce', params: { target: 'MTNK', quantity: 5 } }, { capability: 'production.produce', params: { target: 'GI', quantity: 1 } }])
    const originalId = f.log.since(0)[0]!.commandId
    await f.tick()
    const tank = [...f.runtime.goals.values()].find(goal => goal.spec.kind === 'production' && goal.spec.target === 'MTNK')!
    const infantry = [...f.runtime.goals.values()].find(goal => goal.spec.kind === 'production' && goal.spec.target === 'GI')!
    const before = f.generations()
    await f.voice([{ capability: 'control.pause', params: { scope: 'global' } }])
    assert.equal(f.runtime.programs.get('global')!.status, 'paused')
    await f.voice([{ capability: 'control.resume', params: { scope: 'global' } }])
    assert.equal(f.generations(), before)
    assert.equal(f.runtime.programs.get('global')!.status, 'active')
    await f.voice([{ capability: 'goal.edit', params: { goalId: tank.spec.id, quantity: 8 } }]); await f.tick()
    assert.deepEqual(f.submitted.flatMap(action => action.kind === 'produce' && action.name === 'MTNK' ? [action.quantity] : []), [5, 3])
    await f.voice([{ capability: 'goal.cancel', params: { goalId: infantry.spec.id } }]); await f.tick()
    assert.equal(infantry.status, 'cancelled')
    assert.equal(tank.status, 'active')
    f.failCompile()
    await f.voice([{ capability: 'goal.edit', params: { goalId: tank.spec.id, quantity: 10 } }])
    const allCards = cards(f.log), lastId = f.log.since(0).filter(event => event.stage === 'received').at(-1)!.commandId
    assert.equal(allCards.get(lastId)!.stage, 'failed')
    assert.equal(allCards.get(originalId)!.goals.get(tank.spec.id)!.execution!.state, 'running')
    assert.equal((tank.activeSpec as { quantity: number }).quantity, 8)
    const count = f.submitted.length
    const restored = new CommandLog()
    restored.restoreCurrent(f.root, f.runtime)
    assert.equal(cards(restored).get(lastId)!.stage, 'failed')
    assert.ok([...cards(restored).values()].some(card => card.goals.size === 0 && card.stage === 'completed'))
    const last = restored.lastSeq(); restored.restoreCurrent(f.root, f.runtime)
    assert.equal(restored.lastSeq(), last)
    assert.equal(f.submitted.length, count)
  } finally { await f.dispose() }
})

test('停止通过统一入口取消在途生成，迟到结果不能恢复已撤销目标', async () => {
  const f = await fixture(), started = deferred<void>(), late = deferred<ReturnType<typeof reply>>()
  try {
    f.ctx.controller = new ProgramController({ runtime: f.runtime, executor: f.executor, provider: () => ({ generate: async () => { started.resolve(); return late.promise } }) as never })
    const pending = f.voice([{ capability: 'production.produce', params: { target: 'MTNK', quantity: 5 } }])
    await started.promise
    await handleCommand('global pause', f.ctx)
    assert.equal(f.runtime.goalExecution([...f.runtime.goals.keys()][0]!)!.state, 'paused')
    await handleCommand('global stop', f.ctx)
    assert.equal(f.runtime.programs.get('global')!.status, 'stopped')
    late.resolve(reply(code)); await pending; await f.tick()
    assert.equal(f.runtime.pendingCommandIds().length, 0)
    assert.ok([...f.runtime.goals.values()].every(goal => goal.status === 'cancelled'))
    assert.ok(f.submitted.every(action => action.kind !== 'produce'))
  } finally { late.resolve(reply(code)); await f.dispose() }
})

test('坐标移动、守区与指定队进攻共用对象选择，单队停止保留其他队伍', async () => {
  const f = await fixture()
  try {
    f.formations.create('B', [2])
    await f.voice([{ capability: 'combat.move', params: { formationId: 'A', x: 30, y: 40 } }, { capability: 'combat.hold', params: { formationId: 'B', bounds: [0, 0, 10, 10], retreatLoss: 0.6, retreatX: 1, retreatY: 1 } }])
    const goalA = [...f.runtime.goals.values()].find(goal => goal.ownerId === 'formation:A')!.spec
    assert.equal(goalA.kind, 'combat')
    if (goalA.kind === 'combat') assert.deepEqual(goalA.destination, { x: 30, y: 40 })
    const versionB = f.runtime.programs.get('formation:B')!.script!.version
    await f.voice([{ capability: 'combat.attack-all', params: { formationId: 'A' } }])
    assert.equal(f.runtime.programs.get('formation:B')!.script!.version, versionB)
    await f.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 1, mapWidth: 256, mapHeight: 256 })
    await f.voice([{ capability: 'combat.hold', params: { formationId: 'B', regionName: '三楼右下' } }])
    const hold = [...f.runtime.goals.values()].filter(goal => goal.ownerId === 'formation:B').at(-1)!
    if (hold.spec.kind !== 'combat' || !hold.spec.destination) throw new Error('缺少守区就位点')
    const point = hold.spec.destination
    await f.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 1, self: f.runtime.snapshot!.self.map(unit => unit.id === 2 ? { ...unit, rx: point.x, ry: point.y } : unit) })
    assert.equal(hold.status, 'active')
    assert.equal(f.runtime.goalExecution(hold.spec.id)!.state, 'continuous')
    await f.voice([{ capability: 'control.stop', params: { scope: 'formation', formationId: 'A' } }])
    assert.equal(f.runtime.programs.get('formation:A')!.status, 'stopped')
    assert.equal(f.runtime.programs.get('formation:B')!.status, 'active')
    await f.voice([{ capability: 'control.stop', params: { scope: 'all' } }])
    assert.ok([...f.runtime.programs.values()].every(program => program.status === 'stopped'))
  } finally { await f.dispose() }
})

test('已完成生产改总量只补增量，重新生成失败保留原完成事实', async () => {
  const f = await fixture()
  try {
    await f.voice([{ capability: 'production.produce', params: { target: 'MTNK', quantity: 2 } }]); await f.tick()
    const originalId = f.log.since(0)[0]!.commandId
    const goal = [...f.runtime.goals.values()][0]!
    const born = [21, 22].map(id => ({ ...snapshot().self[0]!, id }))
    await f.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 1, self: [...f.runtime.snapshot!.self, ...born] })
    assert.equal(goal.status, 'completed')
    await f.voice([{ capability: 'goal.edit', params: { goalId: goal.spec.id, quantity: 3 } }]); await f.tick()
    assert.deepEqual(f.submitted.flatMap(action => action.kind === 'produce' ? [action.quantity] : []), [2, 1])
    assert.equal(cards(f.log).get(originalId)!.stage, 'running')
    await f.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 1, self: [...f.runtime.snapshot!.self, { ...born[0]!, id: 23 }] })
    assert.equal(goal.status, 'completed')
    f.failCompile()
    await f.voice([{ capability: 'goal.edit', params: { goalId: goal.spec.id, quantity: 4 } }])
    const lastId = f.log.since(0).filter(event => event.stage === 'received').at(-1)!.commandId
    assert.equal(cards(f.log).get(lastId)!.stage, 'failed')
    assert.equal(cards(f.log).get(originalId)!.stage, 'completed')
    assert.equal(goal.activeSpec, undefined)
    const restored = new CommandLog()
    restored.restoreCurrent(f.root, f.runtime)
    assert.equal(cards(restored).get(originalId)!.stage, 'completed')
  } finally { await f.dispose() }
})
