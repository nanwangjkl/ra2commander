import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActionRequest, CombatGoal, GoalSpec, ProductionGoal, Snapshot, SnapshotUnit } from '../packages/contracts/src/index.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { FormationRegistry, persistState, restoreState } from '../packages/runtime/src/index.ts'
import { assessArrival } from '../packages/runtime/src/arrival.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { CommandLog } from '../apps/companion/src/command-log.ts'
import { runTranscript } from '../apps/companion/src/transcript.ts'
import { prepareGoals } from '../apps/companion/src/prepare-goals.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { normalizeOperations } from '../apps/companion/src/transcript-plan.ts'
import { loadRegionScheme } from '../packages/maps/src/index.ts'
import { harness, production, snapshot } from './helpers.ts'

const managementCode = `function step(s,m){const actions=[];for(const g of s.control.goals){if(g.blocked)continue;const p=g.spec,c=s.constraints.goals[p.id];
 if(p.kind==='formation'){const r=c.management;if(r&&g.unitIds.length)actions.push({goalId:p.id,request:{kind:r.kind,formationId:r.formationId,unitIds:g.unitIds,force:!!r.force}});}
 if(p.kind==='combat'&&g.unitIds.length&&p.destination)actions.push({goalId:p.id,request:{kind:'move',unitIds:g.unitIds,x:p.destination.x,y:p.destination.y}});
}return {actions,memory:m}}`
const result = (text: string) => ({ text, model: 'fixture', durationMs: 0 })
const unit = (id: number, name: string, type = 7): SnapshotUnit => ({ ...snapshot().self[0]!, id, name, type })
const rules = async (name: string, type: number) => {
  const types: Record<string, number> = { MTNK: 7, FV: 7, CMIN: 7, AMCV: 7, ADOG: 3, GACNST: 2, GAWEAP: 2 }
  return types[name] === type ? { label: name, prerequisite: name === 'FV' ? ['GAWEAP'] : [], harvester: name === 'CMIN', constructionYard: name === 'GACNST', ...(name === 'AMCV' ? { deploysInto: 'GACNST' } : {}) } : undefined
}
async function voiceFixture(self: SnapshotUnit[]) {
  const executor = new StepExecutor(), root = mkdtempSync(join(tmpdir(), 'ra2c-battle-fixes-'))
  const { runtime, formations, submitted } = await harness(executor, { formations: new FormationRegistry() })
  await runtime.onSnapshot(snapshot({ seq: 2, mapWidth: 256, mapHeight: 256, self }))
  let operations: unknown[] = []
  const calls = { interpret: 0, compile: 0 }
  const provider = { generate: async ({ messages }: { messages: Array<{ content: string }> }) => {
    const interpret = 'text' in JSON.parse(messages[1]!.content)
    calls[interpret ? 'interpret' : 'compile']++
    return result(interpret ? JSON.stringify({ summary: '原始模型解释', operations }) : managementCode)
  } }
  const log = new CommandLog()
  const controller = new ProgramController({ runtime, executor, provider: () => provider as never,
    prepare: (goals, signal, prompts) => prepareGoals(goals, runtime.snapshot!, rules, signal, prompts.game) })
  const ctx = { runtime, formations, controller, commandLog: log, currentProvider: () => provider,
    bridge: { rules }, page: {}, browser: {}, providers: new Map() } as unknown as CommandContext
  return { runtime, formations, submitted, log, executor, calls,
    say: (text: string, calls: unknown[]) => { operations = calls; return runTranscript(text, ctx, root) },
    tick: () => runtime.onSnapshot({ ...runtime.snapshot!, seq: runtime.snapshot!.seq + 1 }),
    dispose: async () => { await executor.dispose(); rmSync(root, { recursive: true, force: true }) },
  }
}
const assign = (selector: string, formationId = '1队') => ({ capability: 'formation.assign', params: { selector, formationId, quantity: 'all' } })
const move = (formationId: string, regionName: string) => ({ capability: 'combat.move', params: { formationId, regionName } })

const congestedArmy = () => [[87, 25], [86, 26], [86, 25], [87, 24], [86, 27], [88, 26], [87, 26], [88, 25], [88, 24], [85, 27]]
  .map(([rx, ry], i) => ({ ...unit(i + 1, i < 5 ? 'MTNK' : 'FV'), rx: rx!, ry: ry! }))

test('回放三楼右上拥堵：主体在路点周围即算到达，少量掉队可接受，侦察前锋和交接中的单位不误报', () => {
  const point = { x: 83, y: 21 }
  const army = congestedArmy()
  assert.ok(army.every(unit => Math.hypot(unit.rx - point.x, unit.ry - point.y) > 4), '反馈中的整队都在旧半径之外')
  assert.equal(assessArrival(army, point).reached, true)
  const withStragglers = army.map((unit, i) => i < 8 ? unit : { ...unit, rx: 180, ry: 180 })
  assert.equal(assessArrival(withStragglers, point).reached, true)
  assert.deepEqual(assessArrival(withStragglers, point).laggingUnitIds, [9, 10])
  const onlyScouts = army.map((unit, i) => i < 2 ? unit : { ...unit, rx: 180, ry: 180 })
  assert.equal(assessArrival(onlyScouts, point).reached, false)
  assert.equal(assessArrival([], point).reached, false)
  assert.equal(assessArrival(army, point, () => true).reached, false)
})

test('拥堵不再卡住路线：宿主推进下一站，旧严格脚本也跟随新站，掉队成员仍接收后续移动', async () => {
  const executor = new StepExecutor(), frames: Snapshot[] = []
  const formations = new FormationRegistry()
  formations.create('1队', congestedArmy().map(unit => unit.id))
  const { runtime, submitted } = await harness({ run: async (...args: Parameters<StepExecutor['run']>) => {
    frames.push(args[1] as Snapshot)
    return executor.run(...args)
  } }, { formations })
  try {
    const first = { x: 83, y: 21, name: '三楼右上' }, next = { x: 23, y: 84, name: '三楼左上' }
    const tick = (self: SnapshotUnit[]) => runtime.onSnapshot({ ...runtime.snapshot!, mapWidth: 256, mapHeight: 256, seq: runtime.snapshot!.seq + 1, self })
    await tick(congestedArmy().map((unit, i) => i < 2 ? unit : { ...unit, rx: 180, ry: 180 }))
    const goal: CombatGoal = { id: 'congested-route', kind: 'combat', rawText: '继续巡逻', formationId: '1队', region: { name: '沿途', x1: 0, y1: 0, x2: 255, y2: 255 }, allowedActions: ['move', 'stop'], destination: first, route: [first, next] }
    const oldStrictCode = `function step(s,m){const actions=[];for(const g of s.control.goals){const d=g.spec.destination;const units=s.self.filter(u=>g.unitIds.includes(u.id));if(d&&units.length&&!units.every(u=>Math.abs(u.rx-d.x)<=2&&Math.abs(u.ry-d.y)<=2))actions.push({goalId:g.spec.id,request:{kind:'move',unitIds:g.unitIds,x:d.x,y:d.y}})}return {actions,memory:m}}`
    runtime.upsertGoal(goal)
    assert.equal(runtime.commitCompile(runtime.beginCompile('formation:1队'), oldStrictCode), true)
    await tick(runtime.snapshot!.self)
    assert.equal(runtime.goalExecution(goal.id)!.progress!.completed, 0)
    await tick(congestedArmy().map((unit, i) => i < 8 ? unit : { ...unit, rx: 180, ry: 180 }))
    assert.equal(runtime.goalExecution(goal.id)!.progress!.completed, 1)
    const action = submitted.at(-1)!
    assert.ok(action.kind === 'move' && action.x === next.x && action.y === next.y)
    assert.ok('unitIds' in action && action.unitIds.includes(9) && action.unitIds.includes(10), '不丢弃掉队单位')
    const view = frames.at(-1)!.control!.goals[0]!
    assert.equal(view.arrival!.total, 10)
    assert.equal(view.arrival!.reached, false, '脚本读取的已是下一站的到达事实')
    await tick(congestedArmy().map((unit, i) => i < 8 ? { ...unit, rx: unit.rx - first.x + next.x, ry: unit.ry - first.y + next.y } : { ...unit, rx: 180, ry: 180 }))
    assert.equal(runtime.goalExecution(goal.id)!.state, 'completed')
    assert.equal(formations.membersOf('1队').length, 10)
  } finally { await executor.dispose() }
})

test('回放开局 IFV 失败：尚未解锁时中文名称也绑定 FV，整句生产目标共用一次脚本生成', async () => {
  const f = await voiceFixture([{ ...unit(1, 'AMCV'), canDeploy: true }])
  try {
    const output = await f.say('展开基地，造重工，生产5个ifv，5个灰熊', [
      { capability: 'base.deploy', params: {} },
      { capability: 'production.produce', params: { target: '战车工厂', quantity: 1 } },
      { capability: 'production.produce', params: { target: '多功能步兵车', quantity: 5 } },
      { capability: 'production.produce', params: { target: '灰熊坦克', quantity: 5 } },
    ])
    assert.doesNotMatch(output, /未找到可用生产项目/)
    const ifv = [...f.runtime.goals.values()].find(goal => goal.spec.kind === 'production' && goal.spec.target === 'FV')!
    assert.equal((ifv.spec as ProductionGoal).quantity, 5)
    assert.ok((ifv.spec as ProductionGoal).prerequisites.includes('GAWEAP'))
    assert.equal(f.runtime.goals.size, 4)
    assert.deepEqual(f.calls, { interpret: 1, compile: 1 })
  } finally { await f.dispose() }
})

test('回放四站巡逻：同队合成一个目标，按实地坐标依次推进，恢复保留进度，新命令仍替换旧路线', async () => {
  const base = { ...unit(90, 'GACNST', 2), rx: 90, ry: 160 }
  const f = await voiceFixture([{ ...unit(1, 'MTNK'), rx: 91, ry: 160 }, { ...unit(2, 'FV'), rx: 91, ry: 161 }, base])
  try {
    await f.say('所有战斗单位编入1队', [assign('combat')]); await f.tick()
    const before = { ...f.calls }
    const output = await f.say('1队从三楼左上巡逻到三楼右上，再到三楼右下，再回到基地附近', [
      move('1队', '三楼左上'), move('1队', '三楼右上'), move('1队', '三楼右下'), move('1队', '基地附近'),
    ])
    assert.doesNotMatch(output, /未找到地名|已被后续命令替换/)
    const goal = [...f.runtime.goals.values()].find(goal => goal.spec.kind === 'combat')!
    assert.equal([...f.runtime.goals.values()].filter(goal => goal.spec.kind === 'combat').length, 1)
    assert.equal(goal.spec.kind, 'combat')
    if (goal.spec.kind !== 'combat') throw new Error('缺少路线目标')
    const stops = goal.spec.route!
    assert.deepEqual(stops.map(stop => stop.name), ['三楼左上', '三楼右上', '三楼右下', '基地附近'])
    assert.ok(goal.spec.patrol && goal.spec.allowedActions.includes('attack'))
    assert.ok(Math.hypot(stops[3]!.x - base.rx, stops[3]!.y - base.ry) < 8)
    assert.equal(f.calls.interpret - before.interpret, 1)
    assert.equal(f.calls.compile - before.compile, 1)
    const at = (snap: Snapshot, point: { x: number; y: number }) => ({ ...snap, seq: snap.seq + 1, self: snap.self.map(unit => f.formations.ownerOf(unit.id) === '1队' ? { ...unit, rx: point.x, ry: point.y } : unit) })
    await f.runtime.onSnapshot(at(f.runtime.snapshot!, stops[3]!))
    assert.equal(f.runtime.goalExecution(goal.spec.id)!.progress!.completed, 0, '不能跳过前面的路点直接按末站完成')
    await f.runtime.onSnapshot(at(f.runtime.snapshot!, stops[0]!))
    assert.equal(goal.facts.routeIndex, 1)
    const sent = f.submitted.at(-1)!
    assert.ok(sent.kind === 'move' && sent.x === stops[1]!.x && sent.y === stops[1]!.y)
    await f.runtime.onSnapshot(at(f.runtime.snapshot!, stops[1]!))
    assert.equal(goal.facts.routeIndex, 2)
    const state = persistState(f.runtime)
    const restored = await harness(f.executor, { formations: new FormationRegistry() })
    await restored.runtime.onSnapshot(f.runtime.snapshot!)
    restoreState(restored.runtime, state)
    await restored.runtime.onSnapshot({ ...restored.runtime.snapshot!, seq: restored.runtime.snapshot!.seq + 1 })
    assert.deepEqual(restored.runtime.goalExecution(goal.spec.id)!.progress, { completed: 2, total: 4, label: '已到达路点' })
    const continuing = restored.submitted.at(-1)!
    assert.ok(continuing.kind === 'move' && continuing.x === stops[2]!.x && continuing.y === stops[2]!.y)
    await restored.runtime.onSnapshot(at(restored.runtime.snapshot!, stops[2]!))
    assert.equal(restored.runtime.goals.get(goal.spec.id)!.status, 'active')
    await restored.runtime.onSnapshot(at(restored.runtime.snapshot!, stops[3]!))
    assert.equal(restored.runtime.goalExecution(goal.spec.id)!.state, 'completed')
    assert.equal(restored.runtime.goalExecution(goal.spec.id)!.progress!.completed, 4)
    await f.say('1队前往三楼右下', [move('1队', '三楼右下')])
    assert.equal(goal.status, 'cancelled')
    assert.match(f.runtime.goalExecution(goal.spec.id)!.detail!, /已被后续命令替换/)
    assert.equal([...f.runtime.goals.values()].filter(goal => goal.spec.kind === 'combat' && goal.status === 'active').length, 1)
  } finally { await f.dispose() }
})

test('回放战斗单位编队误解：五辆灰熊和五辆 IFV 全部入队，矿车不混入；重叠选择只建一次队', async () => {
  const self = [...[1, 2, 3, 4, 5].map(id => unit(id, 'MTNK')), ...[11, 12, 13, 14, 15].map(id => unit(id, 'FV')), unit(21, 'CMIN')]
  for (const [text, count] of [['所有战斗单位编入1队', 10], ['所有坦克和所有车辆编入1队', 11]] as const) {
    const f = await voiceFixture(self)
    try {
      await f.say(text, [assign('tanks'), assign('vehicles')])
      assert.equal([...f.runtime.goals.values()].filter(goal => goal.spec.kind === 'formation').length, 1)
      await f.tick(); await f.tick()
      assert.equal(f.formations.membersOf('1队').length, count)
      assert.equal(f.formations.ownerOf(21), count === 10 ? undefined : '1队')
      assert.equal(f.runtime.programs.get('global')!.stats.errors, 0)
      assert.ok(f.submitted.every(action => action.kind === 'stop'), '选兵入队不追加生产')
    } finally { await f.dispose() }
  }
})

test('回放同句两队编入后出发：先交接再移动，改二队时仅替换二队且解释取消原因', async () => {
  const f = await voiceFixture([...Array.from({ length: 5 }, (_, i) => unit(i + 1, 'MTNK')), ...[11, 12, 13].map(id => unit(id, 'ADOG', 3))])
  try {
    const text = '所有坦克编入1队，所有狗编入2队，一队去三楼左下，2队去三楼右上'
    const output = await f.say(text, [assign('tanks'), assign('scoutDog', '2队'), move('1队', '三楼左下'), move('2队', '三楼右上')])
    assert.doesNotMatch(output, /编队不存在/)
    assert.deepEqual(f.calls, { interpret: 1, compile: 2 }, '编入现有成员本机执行，两个普通移动编队各生成一次')
    const combat = [...f.runtime.goals.values()].filter(goal => goal.spec.kind === 'combat')
    assert.equal(combat.length, 2)
    assert.ok(combat.every(goal => f.runtime.goalExecution(goal.spec.id)?.detail?.includes('等待')))
    await f.tick(); await f.tick(); await f.tick()
    assert.deepEqual(f.formations.membersOf('1队'), [1, 2, 3, 4, 5])
    assert.deepEqual(f.formations.membersOf('2队'), [11, 12, 13])
    for (const ids of [[1, 2, 3, 4, 5], [11, 12, 13]]) {
      const parked = f.submitted.findIndex(action => action.kind === 'stop' && action.unitIds.join(',') === ids.join(','))
      const moved = f.submitted.findIndex(action => action.kind === 'move' && action.unitIds.join(',') === ids.join(','))
      assert.ok(parked >= 0 && moved > parked)
    }
    assert.ok(combat.every(goal => goal.facts.members.length > 0), '建队后冻结真实成员基准')
    await f.say('2队去三楼右下', [move('2队', '三楼右下')])
    const oldTwo = combat.find(goal => goal.spec.kind === 'combat' && goal.spec.formationId === '2队')!
    assert.equal(f.runtime.goalExecution(oldTwo.spec.id)!.state, 'cancelled')
    assert.match(f.runtime.goalExecution(oldTwo.spec.id)!.detail!, /已被后续命令替换：2队去三楼右下/)
    assert.equal(combat.find(goal => goal.spec.kind === 'combat' && goal.spec.formationId === '1队')!.status, 'active')
  } finally { await f.dispose() }
})

test('同句不同队的巡逻与清敌各自保留目标，不跨队覆盖地域或意图', async () => {
  const map = await loadRegionScheme('maps/ice/schemes/nanwang-0.1.0.json')
  const operations = normalizeOperations('1队巡逻三楼左上，2队摧毁三楼右下所有敌人', [
    { capability: 'combat.move', params: { formationId: '1队', regionName: '三楼左上' } },
    { capability: 'combat.move', params: { formationId: '2队', regionName: '三楼右下' } },
    { capability: 'combat.attack-all', params: { formationId: '2队' } },
  ], map)
  assert.deepEqual(operations, [
    { capability: 'combat.move', params: { formationId: '1队', regionName: '三楼左上', patrol: true } },
    { capability: 'combat.clear-region', params: { formationId: '2队', regionName: '三楼右下' } },
  ])
})

test('回放前置代建：成果计入明确建设目标，放置无空位持续重试，换脚本不重造且仍可明确加造', async () => {
  const executor = new StepExecutor()
  const requests: ActionRequest[] = []
  let placementAttempts = 0
  const { runtime } = await harness(executor, { formations: new FormationRegistry(), submit: async (actions, context, guard) => {
    if (!guard()) return []
    requests.push(...actions)
    return actions.map(action => action.kind === 'place' && ++placementAttempts <= 2
      ? { ok: false, reason: 'no-spot', submitted: 0, session: context.session }
      : { ok: true, submitted: 1, session: context.session })
  } })
  try {
    let self = [unit(90, 'GACNST', 2)]
    const queues = (ready?: string) => [{ type: 0, status: ready ? 3 : 0, size: ready ? 1 : 0, maxSize: 1, items: ready ? [{ name: ready, quantity: 1, progress: 1, creditsEach: 100, creditsSpent: 100 }] : [] }]
    const tick = (available: string[], ready?: string) => runtime.onSnapshot({ ...runtime.snapshot!, seq: runtime.snapshot!.seq + 1, self, production: { power: { total: 100, drain: 0, isLowPower: false }, available, queues: queues(ready) } })
    await tick(['GAPILE'])
    const goal = (id: string, target: string, prerequisites: string[], targetType = 2): ProductionGoal => production({ id, target, targetType, prerequisites, queueTypes: { GAPILE: 0, GAWEAP: 0, MTNK: 3 } })
    const goals: GoalSpec[] = [goal('barracks', 'GAPILE', []), goal('factory', 'GAWEAP', ['GAPILE']), goal('tank', 'MTNK', ['GAPILE', 'GAWEAP'], 7)]
    for (const item of goals) runtime.upsertGoal(item)
    const delegatedCode = `function step(s,m){const actions=[];const g=s.control.goals.find(g=>g.spec.id==='tank');if(g){for(const name of g.productionPlan.readyToPlace)actions.push({goalId:g.spec.id,request:{kind:'place',name}});if(!g.productionPlan.readyToPlace.length){const name=g.productionPlan.availableToProduce[0];if(name)actions.push({goalId:g.spec.id,request:{kind:'produce',name,quantity:1}})}}return {actions,memory:m}}`
    assert.equal(runtime.commitCompile(runtime.beginCompile('global'), delegatedCode), true)
    await tick(['GAPILE'])
    assert.equal(runtime.production[0]!.goalId, 'barracks')
    await tick(['GAPILE'], 'GAPILE'); await tick(['GAPILE'], 'GAPILE')
    assert.match(runtime.goalExecution('barracks')!.detail!, /保留就绪建筑并继续重试/, '宿主放置回执归属实际生产记录的建设目标')
    await tick(['GAPILE'], 'GAPILE')
    assert.equal(requests.filter(action => action.kind === 'place').length, 3)
    assert.equal(requests.filter(action => action.kind === 'produce').length, 1)
    assert.ok(requests.every(action => action.kind !== 'cancel'))
    self = [...self, unit(100, 'GAPILE', 2)]
    await tick(['GAWEAP'])
    assert.equal(runtime.goals.get('barracks')!.status, 'completed')
    assert.equal(runtime.production.find(record => record.name === 'GAWEAP')!.goalId, 'factory')
    await tick(['GAWEAP'], 'GAWEAP')
    self = [...self, unit(101, 'GAWEAP', 2)]
    await tick(['MTNK', 'GAWEAP'])
    assert.equal(runtime.goals.get('factory')!.status, 'completed')
    const normalCode = `function step(s,m){const actions=[];for(const g of s.control.goals){const n=g.spec.target;if(g.produceRemaining[n]>0&&g.productionPlan.availableToProduce.includes(n))actions.push({goalId:g.spec.id,request:{kind:'produce',name:n,quantity:1}})}return {actions,memory:m}}`
    assert.equal(runtime.commitCompile(runtime.beginCompile('global'), normalCode), true)
    await tick(['MTNK', 'GAWEAP'])
    assert.equal(requests.filter(action => action.kind === 'produce' && ['GAPILE', 'GAWEAP'].includes(action.name)).length, 2)
    runtime.upsertGoal(goal('extra-factory', 'GAWEAP', []))
    assert.equal(runtime.commitCompile(runtime.beginCompile('global'), normalCode), true)
    await tick(['GAWEAP'])
    assert.equal(requests.filter(action => action.kind === 'produce' && action.name === 'GAWEAP').length, 2, '明确追加一座仍会生产')
  } finally { await executor.dispose() }
})
