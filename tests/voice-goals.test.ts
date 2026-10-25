import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { runTranscript } from '../apps/companion/src/transcript.ts'
import { prepareGoals } from '../apps/companion/src/prepare-goals.ts'
import { loadPrompts } from '../packages/command/src/index.ts'
import { activate, harness, production, snapshot } from './helpers.ts'

test('模拟转写保留原话，将显示名绑定为内部名并合并卫星与补电目标', async () => {
  const executor = new StepExecutor()
  const folder = mkdtempSync(join(tmpdir(), 'ra2c-transcript-'))
  const inputs: Array<{ messages: Array<{ content: string }> }> = []
  const provider = { generate: async (input: typeof inputs[number]) => {
    inputs.push(input)
    return { text: inputs.length === 1 ? JSON.stringify({ summary: '制造卫星并保持电量健康', operations: [{ capability: 'production.produce', params: { target: 'SpySat Uplink', quantity: 1 } }, { capability: 'production.power', params: { reserve: 100 } }] }) : 'function step(s,m){return {actions:[],memory:m}}', model: 'fixture', durationMs: 0 }
  } }
  try {
    const { runtime } = await harness(executor)
    await runtime.onSnapshot(snapshot({ seq: 2, self: [{ ...snapshot().self[0]!, name: 'GACNST', type: 2 }] }))
    const controller = new ProgramController({ runtime, executor, provider: () => provider as never })
    const rules: Record<string, { label: string; power: number }> = { GACNST: { label: 'Construction Yard', power: 0 }, GAPOWR: { label: 'Power Plant', power: 200 }, GASPYSAT: { label: 'SpySat Uplink', power: -100 } }
    const text = '制造间谍卫星，保持电量健康'
    const output = await runTranscript(text, { runtime, controller, formations: runtime.formations, currentProvider: () => provider, bridge: { rules: async (name: string, type: number) => type === 2 ? rules[name] : undefined } } as never, folder)
    assert.match(output, /已生效/)
    const prompts = loadPrompts()
    assert.equal(inputs[0]!.messages[0]!.content, prompts.render('interpret'))
    assert.equal(inputs[1]!.messages[0]!.content, prompts.compileFor([...runtime.goals.values()].map(goal => goal.spec)))
    const requestId = /记录：(\S+)/.exec(output)![1]!
    const saved = JSON.parse(readFileSync(join(folder, '.runtime/transcripts', `${requestId}.json`), 'utf8'))
    assert.equal(saved.promptVersions.interpret, prompts.version)
    assert.equal(saved.promptVersions.compile.global, prompts.version)
    const goals = [...runtime.goals.values()]
    assert.equal(goals.length, 2)
    assert.ok(goals.every(g => g.spec.rawText === text && g.status === 'active'))
    assert.deepEqual(goals.map(g => g.spec.kind === 'production' ? g.spec.target : ''), ['GASPYSAT', 'GAPOWR'])
    assert.equal(runtime.programs.get('global')!.script!.version, 1)
    assert.equal(JSON.parse(inputs[0]!.messages[1]!.content).faction, 'Allied 盟军')
  } finally { await executor.dispose(); rmSync(folder, { recursive: true, force: true }) }
})

test('同名重工和模型阵营误选都能落到本局可用项目并提交生产', async () => {
  for (const example of [
    { self: snapshot().self, available: 'NAWEAP', target: 'War Factory' },
    { self: [{ ...snapshot().self[0]!, name: 'GACNST', type: 2 }], available: 'GAWEAP', target: 'NAWEAP' },
  ]) {
    const executor = new StepExecutor()
    const folder = mkdtempSync(join(tmpdir(), 'ra2c-transcript-'))
    let calls = 0
    const provider = { generate: async () => ({ text: ++calls === 1
      ? JSON.stringify({ summary: '制造重工', operations: [{ capability: 'production.produce', params: { target: example.target, quantity: 1 } }] })
      : 'function step(s,m){const g=s.control.goals[0];return {actions:g.produceRemaining[g.spec.target]>0?[{goalId:g.spec.id,request:{kind:"produce",name:g.spec.target,quantity:1}}]:[],memory:m}}', model: 'fixture', durationMs: 0 }) }
    const rules = async (name: string, type: number) => type === 2 && ['GAWEAP', 'NAWEAP'].includes(name)
      ? { label: 'War Factory', power: 0, prerequisite: [] } : undefined
    try {
      const { runtime, submitted } = await harness(executor)
      const snap = snapshot({ seq: 2, self: example.self, production: { power: { total: 100, drain: 0, isLowPower: false }, queues: [], available: [example.available] } })
      await runtime.onSnapshot(snap)
      const controller = new ProgramController({ runtime, executor, provider: () => provider as never,
        prepare: (goals, signal) => prepareGoals(goals, runtime.snapshot!, rules, signal) })
      const output = await runTranscript('制造重工', { runtime, controller, formations: runtime.formations, currentProvider: () => provider, bridge: { rules } } as never, folder)
      assert.match(output, /已生效/)
      await runtime.onSnapshot({ ...snap, seq: 3 })
      assert.deepEqual(submitted, [{ kind: 'produce', name: example.available, quantity: 1 }])
    } finally { await executor.dispose(); rmSync(folder, { recursive: true, force: true }) }
  }
})

test('多辆基地车会选择一辆展开，同句无法绑定的操作不阻止它执行', async () => {
  const executor = new StepExecutor()
  const folder = mkdtempSync(join(tmpdir(), 'ra2c-transcript-'))
  let calls = 0
  const provider = { generate: async () => ({ text: ++calls === 1
    ? JSON.stringify({ summary: '展开基地并移动编队', operations: [{ capability: 'combat.move', params: { formationId: '不存在的队', regionName: '东区' } }, { capability: 'base.deploy', params: {  } }] })
    : 'function step(s,m){const g=s.control.goals[0];return {actions:[{goalId:g.spec.id,request:{kind:"deploy",unitIds:g.unitIds}}],memory:m}}', model: 'fixture', durationMs: 0 }) }
  try {
    const { runtime, submitted } = await harness(executor)
    const snap = snapshot({ seq: 2, self: [
      { ...snapshot().self[0]!, name: 'AMCV', canDeploy: true },
      { ...snapshot().self[1]!, name: 'AMCV', canDeploy: true },
    ] })
    await runtime.onSnapshot(snap)
    const controller = new ProgramController({ runtime, executor, provider: () => provider as never })
    const rules = async (name: string, type: number) => name === 'AMCV' && type === 7 ? { deploysInto: 'GACNST' } : undefined
    const output = await runTranscript('展开基地，东区那队移动过去', { runtime, controller, formations: runtime.formations, currentProvider: () => provider, bridge: { rules } } as never, folder)
    assert.match(output, /已生效/)
    assert.match(output, /未执行部分：.*编队不存在/)
    await runtime.onSnapshot({ ...snap, seq: 3 })
    const action = submitted[0]
    assert.ok(action?.kind === 'deploy' && action.unitIds.length === 1 && snap.self.some(u => u.id === action.unitIds[0]))
  } finally { await executor.dispose(); rmSync(folder, { recursive: true, force: true }) }
})

test('展开基地经脚本动作提交，并以新建造厂的实际出现确认完成', async () => {
  const executor = new StepExecutor()
  try {
    const { runtime, submitted } = await harness(executor)
    const mcv = { ...snapshot().self[0]!, name: 'AMCV', canDeploy: true }
    await runtime.onSnapshot(snapshot({ seq: 2, self: [mcv] }))
    activate(runtime, { id: 'base', kind: 'deploy', rawText: '展开基地', unitIds: [mcv.id], target: 'GACNST' }, `function step(s,m){const g=s.control.goals[0];return {actions:g.unitIds.length?[{goalId:g.spec.id,request:{kind:'deploy',unitIds:g.unitIds}}]:[],memory:m}}`)
    await runtime.onSnapshot(snapshot({ seq: 3, self: [mcv] }))
    assert.deepEqual(submitted, [{ kind: 'deploy', unitIds: [mcv.id] }])
    assert.equal(runtime.goals.get('base')!.status, 'active')
    await runtime.onSnapshot(snapshot({ seq: 4, self: [{ ...mcv, id: 40, name: 'GACNST', type: 2, canDeploy: false }] }))
    assert.equal(runtime.goals.get('base')!.status, 'completed')
  } finally { await executor.dispose() }
})

test('制造后编队只接收该生产目标的新身份，不把既有同类单位算作新造', async () => {
  const executor = new StepExecutor()
  try {
    const { runtime, formations, submitted } = await harness(executor)
    activate(runtime, production({ id: 'new-tanks', quantity: 5, formationId: '1队' }), `function step(s,m){const g=s.control.goals[0],a=[],c=s.constraints.goals[g.spec.id];if(g.produceRemaining.MTNK>0)a.push({goalId:g.spec.id,request:{kind:'produce',name:'MTNK',quantity:g.produceRemaining.MTNK}});if(g.unitIds.length)a.push({goalId:g.spec.id,request:{kind:c.management.kind,formationId:g.spec.formationId,unitIds:g.unitIds}});return {actions:a,memory:m}}`)
    await runtime.onSnapshot(snapshot({ seq: 2 }))
    assert.deepEqual(submitted[0], { kind: 'produce', name: 'MTNK', quantity: 5 })
    const own = snapshot().self
    const born = [11, 12, 13, 14, 15].map(id => ({ ...own[0]!, id }))
    await runtime.onSnapshot(snapshot({ seq: 3, self: [...own, ...born] }))
    await runtime.onSnapshot(snapshot({ seq: 4, self: [...own, ...born] }))
    assert.deepEqual(formations.membersOf('1队'), [11, 12, 13, 14, 15])
    assert.equal(formations.ownerOf(2), undefined)
    assert.equal(runtime.goals.get('new-tanks')!.status, 'completed')
  } finally { await executor.dispose() }
})

test('持续补电等待已提交电厂，恢复健康后停止追加，耗电再次上升时继续补电', async () => {
  const executor = new StepExecutor()
  try {
    const { runtime, submitted } = await harness(executor)
    const initial = snapshot({ seq: 2, production: { power: { total: 200, drain: 185, isLowPower: false }, queues: [], available: ['NAPOWR'] } })
    await runtime.onSnapshot(initial)
    activate(runtime, production({ id: 'power', target: 'NAPOWR', targetType: 2, maintainPower: { reserve: 100, output: 200 } }), `function step(s,m){const g=s.control.goals[0],n=g.produceRemaining.NAPOWR;return {actions:n>0?[{goalId:g.spec.id,request:{kind:'produce',name:'NAPOWR',quantity:n}}]:[],memory:m}}`)
    await runtime.onSnapshot({ ...initial, seq: 3 })
    await runtime.onSnapshot({ ...initial, seq: 4 })
    assert.equal(submitted.filter(a => a.kind === 'produce').length, 1)
    const built = { ...initial, seq: 5, self: [...initial.self, { ...initial.self[0]!, id: 60, name: 'NAPOWR', type: 2 }], production: { ...initial.production!, power: { total: 400, drain: 185, isLowPower: false } } }
    await runtime.onSnapshot(built)
    assert.equal(runtime.goals.get('power')!.status, 'active')
    assert.equal(submitted.filter(a => a.kind === 'produce').length, 1)
    await runtime.onSnapshot({ ...built, seq: 6, production: { ...built.production, power: { total: 400, drain: 450, isLowPower: true } } })
    assert.equal(submitted.filter(a => a.kind === 'produce').length, 2)
  } finally { await executor.dispose() }
})
