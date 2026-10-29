import test from 'node:test'
import assert from 'node:assert/strict'
import type { ActionRequest, CoverPolicy, SnapshotUnit } from '../packages/contracts/src/index.ts'
import { coverMoves, emptyCoverMotion, movementPerTick, recordCoverOrder } from '../packages/runtime/src/cover.ts'
import { FormationRegistry, persistState, restoreState } from '../packages/runtime/src/index.ts'
import { executeCapabilities, loadCommandPrompts } from '../apps/companion/src/capabilities/index.ts'
import { GameCatalog } from '../apps/companion/src/game-catalog.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { bindings, type BindingContext } from '../apps/companion/src/capabilities/bindings.ts'
import { retainBindingScope } from '../apps/companion/src/capabilities/binding-recovery.ts'
import { normalizeOperations } from '../apps/companion/src/transcript-plan.ts'
import { coverCombat, coverRangePairs } from '../packages/runtime/src/cover-combat.ts'
import { activate, harness, outcome, production, snapshot } from './helpers.ts'

const policy: CoverPolicy = { runId: 'cover', version: '0.1.0', escortIds: [2], gap: 4, resumeGap: 2, retryTicks: 90 }
const productionSource = `function step(s,m){const actions=[];for(const g of s.control.goals){if(g.spec.kind!=='production')continue;
  const c=s.constraints.goals[g.spec.id],p=g.productionPlan||{};
  for(const name of p.availableToProduce||[]){const n=g.produceRemaining[name]||0;if(n>0)actions.push({goalId:g.spec.id,request:{kind:'produce',name,quantity:n}});}
  const a=c.management;if(a&&a.allowedUnitIds.length)actions.push({goalId:g.spec.id,request:{kind:a.kind,formationId:a.formationId,unitIds:a.allowedUnitIds}});
}return {actions,memory:m}}`
function simulateMovement(speeds: number[], escortIds: number[], combat = false) {
  const units = speeds.map((speed, i) => ({ ...snapshot().self[0]!, id: i + 1, speed, rx: 5, ry: 5 }))
  const destinations = new Map<number, { x: number; y: number }>()
  const orders: Array<{ tick: number; request: ActionRequest }> = []
  const selectedPolicy = { ...policy, escortIds }
  let state = emptyCoverMotion(), maximum = 0
  for (let step = 0; step < 150; step++) {
    const snap = snapshot({ tick: step * 15, self: units, enemies: [] }), ids = units.map(unit => unit.id)
    const point = { x: 80, y: 5 }
    const plan = combat ? coverCombat(selectedPolicy, snap, ids, { targets: [], threats: [], destination: point, region: { name: '全图', x1: 0, y1: 0, x2: 99, y2: 99 }, waiting: false }, state, []) : coverMoves(selectedPolicy, snap, ids, point, state)
    state = plan.state
    for (const action of plan.actions) {
      orders.push({ tick: snap.tick, request: structuredClone(action) })
      for (const id of 'unitIds' in action ? action.unitIds : []) {
        if (action.kind === 'move') destinations.set(id, action)
        if (action.kind === 'stop') destinations.delete(id)
      }
      recordCoverOrder(state, action, snap.tick, [{ ok: true, submitted: 1, session: 1 }])
    }
    for (const unit of units) {
      const target = destinations.get(unit.id), dx = (target?.x ?? unit.rx) - unit.rx, dy = (target?.y ?? unit.ry) - unit.ry, length = Math.hypot(dx, dy)
      // 引擎规则速度的单位是leptons/tick，每格256；每次采样前进15个游戏tick。
      const fraction = length ? Math.min(1, unit.speed! * 15 / 256 / length) : 0
      unit.rx += dx * fraction; unit.ry += dy * fraction; unit.isIdle = !length || fraction === 1
      unit.velocity = { x: !unit.isIdle ? dx / length * unit.speed! : 0, y: 0, z: !unit.isIdle ? dy / length * unit.speed! : 0 }
    }
    maximum = Math.max(maximum, ...units.flatMap(a => units.map(b => Math.hypot(a.rx - b.rx, a.ry - b.ry))))
  }
  return { units, orders, maximum, state }
}

for (const [mainSpeed, escortSpeed] of [[27.56923076923077, 39.38461538461539], [27.56923076923077, 20.48], [27.56923076923077, 27.56923076923077]]) test(`规则速度${mainSpeed}/${escortSpeed}：最慢成员直达，其余预测跟随，正常路段不发停车`, () => {
  const result = simulateMovement([mainSpeed!, escortSpeed!], [2])
  assert.ok(result.units.every(unit => Math.hypot(unit.rx - 80, unit.ry - 5) < 3))
  assert.ok(result.maximum < policy.gap * 2, '预测跟随不能让成员持续脱离队伍')
  assert.equal(result.orders.some(order => order.request.kind === 'stop'), false)
  const drivers = result.units.filter(unit => unit.speed === Math.min(mainSpeed!, escortSpeed!))
  for (const unit of drivers) {
    const moves = result.orders.filter(order => order.request.kind === 'move' && order.request.unitIds.includes(unit.id))
    assert.equal(moves.length, 1, '最慢成员的同一终点指令持续有效，不周期性替换或停车')
    assert.deepEqual(moves[0]!.request, { kind: 'move', unitIds: drivers.map(unit => unit.id), x: 80, y: 5 })
  }
})

test('复现五坦克两IFV停走：两种快慢关系和同速队伍的实际协调器都保持领行长令', () => {
  for (const speeds of [[27.56923076923077, 39.38461538461539], [27.56923076923077, 20.48], [27.56923076923077, 27.56923076923077]]) {
    const result = simulateMovement([...Array(5).fill(speeds[0]), ...Array(2).fill(speeds[1])], [6, 7], true)
    assert.ok(result.units.every(unit => Math.hypot(unit.rx - 80, unit.ry - 5) < 3))
    assert.ok(result.maximum < policy.gap * 2)
    assert.equal(result.orders.some(order => order.request.kind === 'stop'), false)
    for (const unit of result.units.filter(unit => unit.speed === Math.min(...speeds))) assert.equal(result.orders.filter(order => order.request.kind === 'move' && order.request.unitIds.includes(unit.id)).length, 1)
    const followers = result.units.filter(unit => unit.speed! > Math.min(...speeds))
    assert.ok(followers.every(unit => result.orders.some(order => order.request.kind === 'move' && order.request.unitIds.includes(unit.id) && order.request.x !== 80)), '跟随成员使用动态前视点，不独自直奔远方终点')
  }
})

test('预测使用引擎规则速度和公开移动方向，转向与领行成员变化后不沿用旧落点', () => {
  const tankSpeed = 7 * 256 / 65
  assert.ok(Math.abs(movementPerTick(tankSpeed) - 7 / 65) < 1e-9, '当前游戏每格256内部单位，规则速度按游戏tick换算')
  const predict = (speed: number) => {
    const units = [speed, 80].map((value, i) => ({ ...snapshot().self[0]!, id: i + 1, rx: 10, ry: 10, speed: value, velocity: { x: 1, y: 0, z: 0 } }))
    return coverMoves({ ...policy, predictionTicks: 15, replanTicks: 15 }, snapshot({ self: units }), [1, 2], { x: 80, y: 10 }, emptyCoverMotion())
  }
  const slow = predict(tankSpeed), fast = predict(tankSpeed * 2)
  const point = (plan: typeof slow) => plan.actions.find(action => action.kind === 'move' && action.unitIds.includes(2)) as Extract<ActionRequest, { kind: 'move' }>
  assert.ok(point(fast).x > point(slow).x, '公开移动向量完全相同，仅规则速度变化也应改变预测距离')
  for (const action of slow.actions) recordCoverOrder(slow.state, action, 15, [{ ok: true, submitted: 1, session: 1 }])
  const own = [tankSpeed, 80].map((speed, i) => ({ ...snapshot().self[0]!, id: i + 1, rx: 10, ry: 12, speed, isIdle: false, velocity: { x: 0, y: 1000, z: speed } }))
  const frame = snapshot({ tick: 45, self: own })
  const corner = coverMoves({ ...policy, predictionTicks: 15, replanTicks: 15 }, frame, [1, 2], { x: 80, y: 10 }, slow.state)
  assert.equal(point(corner).x, 10)
  assert.ok(point(corner).y > 12, '跟随实际地面x/z方向，不能把垂直分量或直线终点方向当成当前行进方向')
  assert.equal(corner.actions.some(action => action.kind === 'move' && action.unitIds.includes(1)), false)
  own[0]!.velocity = { x: 0, y: 0, z: 0 }
  const pausedCorner = coverMoves(policy, { ...frame, tick: 60 }, [1, 2], { x: 80, y: 10 }, corner.state)
  assert.equal(pausedCorner.state.prediction?.dx, 0)
  assert.equal(pausedCorner.state.prediction?.dy, 1, '转弯或短暂拥堵时沿用实际航向，不在终点方向和实际方向间来回改点')
  const changed = coverMoves(policy, frame, [1, 2], { x: 10, y: 80 }, corner.state)
  assert.ok(changed.actions.some(action => action.kind === 'move' && action.unitIds.includes(1) && action.x === 10 && action.y === 80))
  frame.self = [own[1]!, { ...own[0]!, id: 3 }]
  const replacement = coverMoves(policy, frame, [1, 2, 3], { x: 10, y: 80 }, changed.state)
  assert.equal(replacement.state.prediction?.guideId, 3)
  assert.ok(replacement.actions.every(action => !('unitIds' in action) || !action.unitIds.includes(1)))
})

test('直接攻击不等集结或射程，接敌途中仍兼容更快和更慢的掩护', () => {
  for (const speeds of [[27.57,39.38],[27.57,20.48]]) {
    const units = speeds.map((speed,i)=>({...snapshot().self[0]!,id:i+1,speed,rx:5,ry:5}))
    const enemy = {id:99,name:'ENEMY',type:7,rx:80,ry:5,isIdle:true}
    const orders = new Map<number, ActionRequest>(), target = {x:80,y:5}
    let state=emptyCoverMotion(), maximum=0
    for(let n=0;n<160;n++) {
      const snap=snapshot({tick:n*15,self:units,enemies:[enemy]})
      const ranges=units.map(unit=>({unitId:unit.id,targetId:99,canAttack:true,inRange:Math.hypot(unit.rx-80,unit.ry-5)<=6}))
      const result=coverCombat(policy,snap,[1,2],{targets:[enemy],threats:[enemy],destination:target,region:{name:'全图',x1:0,y1:0,x2:99,y2:99},waiting:false},state,ranges)
      state=result.state
      if(n===0) assert.ok(result.actions.some(action=>action.kind==='attack'&&action.unitIds.includes(1)), '远处已有敌人时主战立即攻击')
      for(const action of result.actions) {
        for(const id of 'unitIds' in action?action.unitIds:[])orders.set(id,action)
        recordCoverOrder(state,action,snap.tick,[{ok:true,submitted:1,session:1}])
      }
      for(const unit of units) {
        const order=orders.get(unit.id), point=order?.kind==='move'?order:order?.kind==='attack'?target:undefined
        const dx=(point?.x??unit.rx)-unit.rx,dy=(point?.y??unit.ry)-unit.ry,distance=Math.hypot(dx,dy)
        const travel=order?.kind==='attack'&&distance<=6?0:Math.min(distance,unit.speed!*15/256)
        unit.rx+=distance?dx/distance*travel:0;unit.ry+=distance?dy/distance*travel:0;unit.isIdle=!travel&&order?.kind!=='attack'
        unit.velocity={x:distance?dx/distance*travel:0,y:0,z:distance?dy/distance*travel:0}
      }
      maximum=Math.max(maximum,Math.hypot(units[0]!.rx-units[1]!.rx,units[0]!.ry-units[1]!.ry))
    }
    assert.ok(maximum<policy.gap*2, `接敌途中不能因直接攻击而脱队：${maximum}`)
    assert.ok(units.every(unit=>Math.hypot(unit.rx-80,unit.ry-5)<8),'双方均继续接近敌人')
  }
})

async function fixture(escortSpeed = 12, mainSpeed = 6, prepare = true) {
  const own: SnapshotUnit[] = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: i < 5 ? 'MTNK' : 'ADOG', type: i < 5 ? 7 : 3, rx: 5, ry: 5, isIdle: true, speed: i < 5 ? mainSpeed : escortSpeed, zone: 0 }))
  const env = await harness({ run: async () => outcome([]) }, { formations: new FormationRegistry() })
  await env.runtime.onSnapshot(snapshot({ seq: 2, self: own, enemies: [] }))
  const prompts = loadCommandPrompts()
  const catalog = new GameCatalog([
    { name: 'MTNK', label: '灰熊坦克', type: 7, power: 0, available: true, factions: [], roles: ['tank'], aliases: ['坦克'] },
    { name: 'ADOG', label: '警犬', type: 3, power: 0, available: true, factions: [], roles: ['scoutDog'], aliases: ['警犬'] },
    { name: 'FV', label: 'IFV', type: 7, power: 0, available: true, factions: [], roles: [], aliases: ['防空车'] },
  ], env.runtime.snapshot!, prompts.game)
  let generations = 0
  const ctx = { ...env, controller: new ProgramController({ runtime: env.runtime, executor: { run: async () => outcome([]) }, provider: () => ({ generate: async () => { generations++; throw new Error('不应生成脚本') } }) as never }), bridge: {} } as unknown as CommandContext
  const run = (capability: string, params: Record<string, unknown>, text = '现有单位掩护') => executeCapabilities([{ capability, params }], ctx, { text, prompts, catalog })
  const tick = (self = own) => env.runtime.onSnapshot(snapshot({ seq: env.runtime.snapshot!.seq + 1, tick: env.runtime.snapshot!.tick + 30, self, enemies: [] }))
  if (prepare) {
    await run('formation.cover', { formationId: '1队', protectedSelector: 'MTNK', protectedQuantity: 5, selector: 'ADOG', quantity: 5 })
    await tick(); await tick(); await tick()
  }
  return { ...env, own, ctx, run, tick, catalog, prompts, get generations() { return generations } }
}

test('同句先编入5辆坦克、再用5条狗掩护，只建立一个十人队且不生产', async () => {
  const f = await fixture(12, 6, false), executor = new StepExecutor()
  const source = 'function step(s,m){return {actions:s.control.goals.filter(g=>g.spec.kind==="formation").map(g=>({goalId:g.spec.id,request:g.spec.request})),memory:m}}'
  try {
    f.ctx.controller = new ProgramController({ runtime: f.runtime, executor, provider: () => ({ generate: async () => ({ text: source, model: 'fixture', durationMs: 0 }) }) as never })
    const result = await executeCapabilities([
      { capability: 'formation.assign', params: { formationId: '1队', selector: 'MTNK', quantity: 5 } },
      { capability: 'skill.run', params: { skillId: 'cover', formationId: '1队', selector: 'ADOG', quantity: 5 } },
    ], f.ctx, { text: '5辆坦克组成1队，5个警犬掩护', prompts: f.prompts, catalog: f.catalog })
    assert.deepEqual(result.skipped, [])
    assert.equal(f.runtime.programs.get('global')!.script, undefined, '编入和掩护本机执行，不等待生成脚本')
    // 恢复后继续真实本机提交与停车交接。
    const restored = await harness(executor, { formations: new FormationRegistry() })
    await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 1 })
    restoreState(restored.runtime, persistState(f.runtime))
    for (let n = 0; n < 4; n++) await restored.runtime.onSnapshot({ ...restored.runtime.snapshot!, seq: restored.runtime.snapshot!.seq + 1, tick: restored.runtime.snapshot!.tick + 30 })
    assert.equal(restored.formations.list().length, 1)
    assert.equal(restored.formations.membersOf('1队').length, 10)
    assert.deepEqual(restored.formations.coverOf('1队')!.escortIds, [6, 7, 8, 9, 10])
    assert.equal(restored.submitted.some(action => action.kind === 'produce'), false)
  } finally { await executor.dispose() }
})

test('复现新造IFV掩护被降为仅生产：保留未启用反馈，现有快IFV安排掩护后会等待坦克', async () => {
  const f = await fixture(39.38, 27.57, false), executor = new StepExecutor()
  try {
    await f.tick([])
    f.ctx.controller = new ProgramController({ runtime: f.runtime, executor, provider: () => ({ generate: async () => ({ text: 'function step(s,m){return {actions:[],memory:m}}', model: 'fixture', durationMs: 0 }) }) as never })
    const result = await executeCapabilities([
      { capability: 'production.produce', params: { target: 'MTNK', quantity: 5, formationId: '1队' } },
      { capability: 'formation.cover', params: { formationId: '1队', selector: 'FV', quantity: 2, protectedSelector: 'MTNK', protectedQuantity: 5 } },
    ], f.ctx, { text: '造5辆坦克，编入1队，2个IFV掩护1队', prompts: f.prompts, catalog: f.catalog,
      repairBindings: async failures => {
        assert.match(failures[0]!.error, /掩护未启用/)
        return [{ index: 0, operations: [{ capability: 'production.produce', params: { target: 'FV', quantity: 2, formationId: '1队' } }] }]
      },
    })
    assert.deepEqual(result.goals.map(goal => goal.kind === 'production' && goal.target), ['MTNK'], '保留原生产，不执行丢失掩护职责的兜底生产')
    assert.match(result.skipped.join(' '), /掩护未启用.*掩护绑定修正必须保留同队掩护/)
    assert.match(result.summary, /未执行/)
    assert.equal(f.runtime.skillRuns.size, 0)
    assert.equal(f.formations.coverOf('1队'), undefined)

    const ready: SnapshotUnit[] = [...f.own.slice(0, 5), ...[11, 12].map(id => ({ ...f.own[0]!, id, name: 'FV', speed: 39.38 }))]
    await f.tick(ready)
    f.formations.create('1队', ready.map(unit => unit.id))
    const covered = await f.run('formation.cover', { formationId: '1队', selector: 'FV', quantity: 2 }, '1队里的IFV负责掩护')
    assert.deepEqual(covered.skipped, [])
    assert.deepEqual(f.formations.coverOf('1队')!.escortIds, [11, 12])
    await f.run('combat.move', { formationId: '1队', x: 80, y: 5 }); await f.tick(ready)
    ready.forEach(unit => { unit.rx = unit.name === 'FV' ? 16 : 10; unit.isIdle = false })
    f.submitted.length = 0; await f.tick(ready)
    assert.equal(f.submitted.some(action => action.kind === 'stop'), false, '正常领先不再用停车控制节奏')
    ready.filter(unit => unit.name === 'MTNK').forEach(unit => { unit.rx = 18 })
    f.submitted.length = 0; await f.tick(ready)
    assert.ok(f.submitted.some(action => action.kind === 'move' && action.unitIds.includes(11) && action.unitIds.includes(12)), '坦克跟上后IFV恢复前进')
  } finally { await executor.dispose() }
})

test('掩护重决策保留双方成员、数量和编队，不能改为其他Skill或掩饰新造限制', () => {
  const prompts = loadCommandPrompts()
  const original = { capability: 'formation.cover', params: { formationId: '1队', selector: 'FV', quantity: 2, unitIds: [11, 12], protectedSelector: 'MTNK', protectedQuantity: 5, protectedUnitIds: [1, 2, 3, 4, 5] } }
  assert.deepEqual(retainBindingScope(original, { capability: 'formation.cover', params: { formationId: '别的队' } }, prompts), prompts.capabilities.parse(original))
  const skill = { capability: 'skill.run', params: { skillId: 'cover', formationId: '1队', selector: 'FV', quantity: 2, memberSource: 'new' } }
  assert.throws(() => retainBindingScope(skill, { capability: 'skill.run', params: { skillId: 'scout' } }, prompts), /必须保留同队掩护/)
  const corrected = retainBindingScope(skill, { capability: 'formation.cover', params: { formationId: '1队' } }, prompts)
  assert.equal(corrected.capability === 'formation.cover' && corrected.params.memberSource, 'new')
})

test('新造坦克与IFV掩护一条命令接通，角色只接收本次产物；边生产边入队与重启不重复生产', async () => {
  const f = await fixture(39, 27, false), executor = new StepExecutor()
  let runtime = f.runtime
  const tick = async (self: SnapshotUnit[]) => runtime.onSnapshot(snapshot({ seq: runtime.snapshot!.seq + 1, tick: runtime.snapshot!.tick + 30, self, enemies: [], production: { power: { drain: 0, total: 100, isLowPower: false }, queues: [], available: ['MTNK', 'FV'] } }))
  try {
    await tick([])
    // 同一执行器负责真实本机脚本运行，不仅检查生成阶段的空动作。
    const env = await harness(executor, { formations: new FormationRegistry() })
    await env.runtime.onSnapshot(runtime.snapshot!); runtime = env.runtime
    f.ctx.runtime = runtime; f.ctx.formations = env.formations
    f.ctx.controller = new ProgramController({ runtime, executor, provider: () => ({ generate: async () => ({ text: productionSource, model: 'fixture', durationMs: 0 }) }) as never })
    const text = '造5辆坦克，编入1队，2个IFV掩护1队'
    const calls = normalizeOperations(text, [
      { capability: 'production.produce', params: { target: 'MTNK', quantity: 5, formationId: '1队' } },
      { capability: 'formation.cover', params: { formationId: '1队', selector: 'FV', quantity: 2, protectedSelector: 'MTNK', protectedQuantity: 5 } },
      { capability: 'combat.move', params: { formationId: '1队', x: 80, y: 5 } },
    ], undefined, f.catalog)
    const result = await executeCapabilities(calls, f.ctx, { text, prompts: f.prompts, catalog: f.catalog })
    assert.deepEqual(result.skipped, [])
    assert.deepEqual(result.goals.filter(g => g.kind === 'production').map(g => [g.target, g.quantity]), [['MTNK', 5], ['FV', 2]])
    await tick([])
    assert.deepEqual(env.submitted.filter(a => a.kind === 'produce').map(a => [a.name, a.quantity]), [['MTNK', 5], ['FV', 2]])
    const tank = (id: number): SnapshotUnit => ({ ...f.own[0]!, id, primaryWeapon: { maxRange: 5, minRange: 0, aa: false, ag: true } })
    const ifv = (id: number): SnapshotUnit => ({ ...tank(id), name: 'FV', speed: 39, primaryWeapon: { maxRange: 6, minRange: 0, aa: true, ag: true } })
    let own = [tank(201)]
    await tick(own); await tick(own)
    assert.equal(runtime.hasCover('1队'), true)
    assert.deepEqual(runtime.formations.coverOf('1队')!.escortIds, [], '缺少首个掩护成员时保留等待配置')
    own = [tank(201), ifv(701)]
    await tick(own); await tick(own)
    assert.deepEqual(runtime.formations.coverOf('1队')!.escortIds, [701])
    assert.ok(env.submitted.some(a => a.kind === 'move' && a.unitIds.includes(201)), '首对成员完成交接即可行动，不等整批生产')
    const restored = await harness(executor, { formations: new FormationRegistry() })
    await restored.runtime.onSnapshot(runtime.snapshot!)
    restoreState(restored.runtime, JSON.parse(JSON.stringify(persistState(runtime))))
    runtime = restored.runtime
    own = [201, 202, 203, 204, 205].map(tank).concat([ifv(701), ifv(702)])
    await tick(own); await tick(own); await tick(own)
    own.push(ifv(999)); await tick(own)
    assert.equal(runtime.formations.membersOf('1队').length, 7)
    assert.deepEqual(runtime.formations.coverOf('1队')!.escortIds, [701, 702])
    assert.equal(restored.submitted.some(a => a.kind === 'produce'), false, '恢复和新增成员不重置已经提交的生产')
    runtime.formations.create('2队', []); runtime.formations.transfer([701], '2队')
    await tick(own)
    assert.deepEqual(runtime.formations.coverOf('1队')!.escortIds, [702], '已转出的实际产物不被来源记录重新拉回')
  } finally { await executor.dispose() }
})

test('掩护进攻使用同一协调器：主力打基地，IFV优先近处空军，狗不追建筑；目标消失后重新分工', async () => {
  const own: SnapshotUnit[] = [
    { ...snapshot().self[0]!, id: 1, rx: 10, ry: 10, speed: 27 },
    { ...snapshot().self[0]!, id: 2, name: 'FV', rx: 11, ry: 10, speed: 39 },
    { ...snapshot().self[0]!, id: 3, name: 'ADOG', type: 3, rx: 10, ry: 11, speed: 20 },
  ]
  const base: SnapshotUnit = { id: 90, name: 'GACNST', type: 2, rx: 14, ry: 10, isIdle: true }
  const air: SnapshotUnit = { id: 91, name: 'ORCA', type: 1, zone: 1, rx: 12, ry: 10, isIdle: true }
  const env = await harness({ run: async () => { throw new Error('不应运行云模型脚本') } }, { formations: new FormationRegistry(),
    coverRanges: async pairs => pairs.map(pair => ({ ...pair, canAttack: pair.unitId !== 3, inRange: pair.unitId !== 3 })),
  })
  const { runtime, formations, submitted } = env
  await runtime.onSnapshot(snapshot({ seq: 2, self: own, enemies: [base, air] }))
  formations.create('1队', [1, 2, 3]); runtime.setCover('1队', { ...policy, escortIds: [2, 3] })
  runtime.upsertGoal({ id: 'base-attack', kind: 'attack', rawText: '1队摧毁基地', executionMode: 'native', formationId: '1队', unitIds: [1, 2, 3], aircraftIds: [], ammoCapacity: {}, preparationGoalIds: [], targetKind: 'base', targetNames: ['GACNST'] })
  runtime.activateNativeGoals('formation:1队')
  const tick = async (enemies = [base, air]) => runtime.onSnapshot({ ...runtime.snapshot!, self: own, enemies, seq: runtime.snapshot!.seq + 1, tick: runtime.snapshot!.tick + 15 })
  await tick()
  assert.ok(submitted.some(a => a.kind === 'attack' && a.unitIds.includes(1) && a.targetId === 90))
  assert.ok(submitted.some(a => a.kind === 'attack' && a.unitIds.includes(2) && a.targetId === 91), '基地目标不妨碍近身防空自卫')
  assert.equal(submitted.some(a => a.kind === 'attack' && a.unitIds.includes(3)), false)
  assert.ok(submitted.filter(a => a.kind === 'attack').filter(a => a.unitIds.includes(2)).every(a => a.holdPosition), '掩护成员由桥复查当前射程，不远程追击')
  assert.ok(submitted.some(a => a.kind === 'attack' && a.unitIds.includes(1) && !a.holdPosition), '主战成员使用普通攻击，接近和开火交给游戏')
  submitted.length = 0; own.forEach(u => { u.isIdle = false }); await tick([base])
  assert.ok(submitted.some(a => a.kind === 'attack' && a.unitIds.includes(2) && a.targetId === 90), '空军消失后支援主力已经提交的攻击目标')
  submitted.length = 0; own[1]!.rx = 30; await tick([base])
  assert.ok(submitted.some(a => a.kind === 'move' && a.unitIds.includes(2) && a.x <= own[0]!.rx + policy.gap), '偏离掩护范围时优先回靠，即使目标仍可打也不能独自追击')
  assert.equal(runtime.goals.get('base-attack')!.facts.nativeError, undefined)

  const p = { ...policy, escortIds: [2] }, snap = snapshot({ self: own.slice(0, 2), enemies: [{ ...base, rx: 5 }] })
  snap.self[1]!.rx = 10
  const intent = { targets: [], threats: snap.enemies, region: { name: '全图', x1: 0, y1: 0, x2: 99, y2: 99 }, waiting: false }
  const plan = coverCombat(p, snap, [1, 2], intent, emptyCoverMotion(), [])
  assert.ok(plan.actions.some(a => a.kind === 'move' && a.unitIds.includes(2) && a.x < snap.self[0]!.rx), '敌人从后方出现时掩护站到受护成员与敌人之间')
  assert.ok(coverRangePairs(p, snap, [1, 2], intent, emptyCoverMotion()).length <= 64)
  own.shift(); submitted.length = 0; await tick([base])
  assert.ok(submitted.some(a => a.kind === 'attack' && a.unitIds.includes(2) && a.targetId === 90 && !a.holdPosition), '受护成员全灭后，原掩护成员按普通编队继续攻击原目标')
  assert.equal(await runtime.clearLostCover('1队'), false, '已经自动解除，无需等待玩家补发命令')
  assert.equal(formations.coverOf('1队'), undefined)
})

test('复现动员兵领行停在基地射程外：慢掩护继续带队接敌，进入射程后坦克攻击', () => {
  const tankPositions = [[45, 75], [44, 75], [44, 74], [42, 75], [42, 74]]
  const own: SnapshotUnit[] = tankPositions.map(([rx, ry], index) => ({ ...snapshot().self[0]!, id: index + 1, name: 'HTNK', rx: rx!, ry: ry!, elevation: 10, speed: 23.6, isIdle: true }))
  own.push(...Array.from({ length: 10 }, (_, index) => ({ ...own[0]!, id: 10 + index, name: 'E2', type: 3, rx: 42, ry: 76 + index % 2, speed: 10.24 })))
  const enemy = { ...snapshot().enemies[0]!, id: 90, name: 'NACNST', type: 2, rx: 38, ry: 81, elevation: 10 }
  const p = { ...policy, escortIds: own.filter(unit => unit.type === 3).map(unit => unit.id) }, ids = own.map(unit => unit.id)
  const state = emptyCoverMotion()
  for (const unit of own) state.orders[unit.id] = unit.type === 3 ? { kind: 'stop', tick: 22000 } : { kind: 'move', x: unit.rx, y: unit.ry, tick: 22000 }
  state.prediction = { guideId: 10, x: 38, y: 81, dx: -Math.SQRT1_2, dy: Math.SQRT1_2 }
  const intent = { targets: [enemy], threats: [enemy], region: { name: '全图', x1: 0, y1: 0, x2: 199, y2: 199 }, waiting: false }
  const snap = snapshot({ seq: 2, tick: 29642, self: own, enemies: [enemy], mapWidth: 200, mapHeight: 200 })
  const first = coverCombat(p, snap, ids, intent, state, ids.map(unitId => ({ unitId, targetId: 90, canAttack: true, inRange: false })))
  assert.ok(first.actions.some(action => action.kind === 'move' && action.unitIds.includes(10) && action.x === 38 && action.y === 81), '靠近敌人不能提前停掉最慢领行者')
  assert.ok(!first.actions.some(action => action.kind === 'stop' && action.unitIds.includes(10)))
  const second = coverCombat(p, { ...snap, tick: 29657 }, ids, intent, first.state, ids.map(unitId => ({ unitId, targetId: 90, canAttack: true, inRange: unitId <= 5 })))
  assert.ok(second.actions.some(action => action.kind === 'attack' && action.unitIds.includes(1) && !action.holdPosition))
  assert.ok(!second.actions.some(action => action.kind === 'attack' && action.unitIds.some(id => id >= 10)), '射程外掩护不抢着追击')
})

test('任一侧全灭后普通编队接续路线，保留进度与暂停状态，重启不恢复失效掩护', async () => {
  for (const lost of ['escort', 'protected'] as const) {
    const f = await fixture()
    await executeCapabilities([
      { capability: 'combat.move', params: { formationId: '1队', x: 40, y: 5 } },
      { capability: 'combat.move', params: { formationId: '1队', x: 80, y: 5 } },
    ], f.ctx, { text: '先去40再去80', prompts: f.prompts, catalog: f.catalog })
    f.own.forEach(unit => { unit.rx = 40 }); await f.tick()
    const goal = [...f.runtime.goals.values()].find(goal => goal.spec.kind === 'combat')!
    assert.equal(goal.facts.routeIndex, 1)
    await f.run('control.pause', { scope: 'formation', formationId: '1队' })
    const survivors = f.own.filter(unit => lost === 'escort' ? unit.id <= 5 : unit.id > 5)
    survivors.forEach(unit => { unit.rx = 45 })
    f.submitted.length = 0; await f.tick(survivors)
    assert.equal(f.formations.coverOf('1队'), undefined)
    assert.equal(f.runtime.goalExecution(goal.spec.id)!.state, 'paused')
    assert.equal(f.submitted.length, 0, '战损转换不能恢复玩家暂停的编队')
    assert.equal([...f.runtime.skillRuns.values()][0]!.status, 'partial')
    await f.run('control.resume', { scope: 'formation', formationId: '1队' })
    f.submitted.length = 0; await f.tick(survivors)
    assert.ok(f.submitted.some(action => action.kind === 'move' && action.x === 80 && action.unitIds.length === 5))
    assert.equal(f.submitted.some(action => action.kind === 'stop'), false)
    assert.match(f.runtime.goalExecution(goal.spec.id)!.detail!, /转为普通编队/)
    assert.equal(goal.facts.routeIndex, 1)
    const restored = await harness({ run: async () => outcome() }, { formations: new FormationRegistry() })
    await restored.runtime.onSnapshot(f.runtime.snapshot!)
    restoreState(restored.runtime, JSON.parse(JSON.stringify(persistState(f.runtime))))
    await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 1 })
    assert.equal(restored.formations.coverOf('1队'), undefined)
    assert.equal(restored.runtime.goals.get(goal.spec.id)!.facts.routeIndex, 1)
    assert.equal(restored.runtime.hasCover('1队'), false)
  }
})

test('受护全灭后接管原掩护成员继续限定区域攻击，搜索和重启保留本次成员范围', async () => {
  for (const prepared of [false, true]) {
    const own: SnapshotUnit[] = [
      { ...snapshot().self[0]!, id: 1, name: 'MTNK', speed: 27 },
      { ...snapshot().self[0]!, id: 2, name: 'FV', speed: 39 },
      { ...snapshot().self[0]!, id: 3, name: 'FV', speed: 39 },
    ]
    const env = await harness({ run: async () => outcome() }, { formations: new FormationRegistry() })
    await env.runtime.onSnapshot(snapshot({ seq: 2, self: own, enemies: [] }))
    env.formations.create('1队', [1, 2]); env.runtime.setCover('1队', { ...policy, escortIds: [2] })
    if (prepared) {
      const source = { ...production({ id: 'tank-source', formationId: '1队' }) }
      activate(env.runtime, source)
      env.runtime.production.push({ id: 'born', goalId: source.id, name: 'MTNK', quantity: 1, observedIds: [1], building: false, placed: false, state: 'submitted' })
    }
    env.runtime.upsertGoal({ id: 'attack', kind: 'attack', rawText: '1队坦克清理右侧基地', executionMode: 'native', formationId: '1队', unitIds: [1], aircraftIds: [], ammoCapacity: {},
      preparationGoalIds: prepared ? ['tank-source'] : [], ...(prepared ? { membership: { kind: 'prepared' as const, goalIds: ['tank-source'], names: ['MTNK'], limit: 1 } } : {}), targetKind: 'base', targetNames: ['GACNST'],
      objective: { target: { kind: 'base', names: ['GACNST'], region: { id: 'right', name: '右侧', polygons: [{ outer: [[60, 0], [99, 0], [99, 99], [60, 99], [60, 0]], holes: [] }] } }, search: { kind: 'region', destination: { x: 80, y: 5 } }, completion: { ground: 'continuous', aircraft: 'single-shot' } } })
    env.runtime.activateNativeGoals('formation:1队')
    const tick = async (self: SnapshotUnit[], enemies: SnapshotUnit[]) => env.runtime.onSnapshot({ ...env.runtime.snapshot!, seq: env.runtime.snapshot!.seq + 1, tick: env.runtime.snapshot!.tick + 30, self, enemies })
    await tick(own, [])
    const current = env.runtime.goals.get('attack')!.spec
    if (current.kind !== 'attack') throw new Error('fixture')
    env.runtime.upsertGoal({ ...current, id: 'next-attack', rawText: '下一条明确选择', unitIds: [1], membership: { kind: 'selected' }, preparationGoalIds: [] })
    env.submitted.length = 0
    await tick(own.slice(1), [])
    assert.equal(env.formations.coverOf('1队'), undefined)
    assert.ok(env.submitted.some(action => action.kind === 'move' && action.unitIds.includes(2) && action.x === 80), '没有可见敌人时继续原分区搜索')
    assert.equal(env.submitted.some(action => 'unitIds' in action && action.unitIds.includes(3)), false, '不吸收未编队同型成员')
    assert.equal(env.runtime.goals.get('attack')!.status, 'active')
    assert.equal(env.runtime.goals.get('next-attack')!.facts.coverReleasedIds, undefined, '未生效的新命令仍保留自己的明确选择')
    const restored = await harness({ run: async () => outcome() }, { formations: new FormationRegistry() })
    await restored.runtime.onSnapshot(env.runtime.snapshot!)
    restoreState(restored.runtime, JSON.parse(JSON.stringify(persistState(env.runtime))))
    const targets = [
      { ...own[0]!, id: 90, name: 'GACNST', type: 2, rx: 10 },
      { ...own[0]!, id: 91, name: 'GACNST', type: 2, rx: 70 },
      { ...own[0]!, id: 92, name: 'ORCA', type: 1, zone: 1, rx: 71 },
    ]
    await restored.runtime.onSnapshot({ ...env.runtime.snapshot!, seq: env.runtime.snapshot!.seq + 1, tick: env.runtime.snapshot!.tick + 30, self: own.slice(1), enemies: targets })
    assert.ok(restored.submitted.some(action => action.kind === 'attack' && action.targetId === 91 && action.unitIds.includes(2) && !action.holdPosition))
    assert.ok(restored.submitted.every(action => action.kind !== 'attack' || action.targetId === 91), '失去掩护后仍保留原目标类型和区域')
    assert.deepEqual(restored.runtime.goals.get('attack')!.facts.coverReleasedIds, [2])
  }
})

test('战损转普通编队后，迟到的停车交接不能重新安装旧掩护', async () => {
  const f = await fixture(), run = [...f.runtime.skillRuns.values()][0]!
  const incoming = { ...f.own[0]!, id: 100 }
  await f.tick([...f.own, incoming])
  activate(f.runtime, { id: 'late-handoff', kind: 'formation', rawText: '加入后保持掩护', cover: f.formations.coverOf('1队')!, request: { kind: 'transferUnits', formationId: '1队', unitIds: [100] } })
  f.formations.transfer([100], '1队')
  f.runtime.handoffs.push({ goalId: 'late-handoff', unitIds: [100], owners: [[100, '1队']] })
  await f.tick([...f.own.filter(unit => unit.id <= 5), incoming])
  assert.equal(f.formations.coverOf('1队'), undefined)
  assert.equal(run.status, 'partial')
  assert.equal(f.runtime.handoffs.length, 0)
  await f.tick([...f.own.filter(unit => unit.id <= 5), incoming])
  assert.equal(f.runtime.hasCover('1队'), false)
})

test('缺少一侧时等待明确的生产与停车交接，准备结束仍缺员才转普通编队', async () => {
  for (const lost of ['escort', 'protected'] as const) {
    const f = await fixture()
    const source = production({ id: 'incoming', formationId: '1队', target: lost === 'escort' ? 'ADOG' : 'MTNK', targetType: lost === 'escort' ? 3 : 7 })
    activate(f.runtime, source)
    const run = [...f.runtime.skillRuns.values()][0]!
    assert.equal(run.kind, 'cover')
    if (run.kind !== 'cover') throw new Error('fixture')
    const next = { ...f.formations.coverOf('1队')!, ...(lost === 'escort' ? { escortSources: [{ goalId: source.id, quantity: 1 }] } : { protectedSources: [source.id] }) }
    run.cover = next; run.preparationGoalIds.push(source.id); f.runtime.setCover('1队', next)
    await f.run('combat.move', { formationId: '1队', x: 80, y: 5 })
    const survivors = f.own.filter(unit => lost === 'escort' ? unit.id <= 5 : unit.id > 5)
    await f.tick(survivors)
    assert.ok(f.formations.coverOf('1队'), '本次还有明确待生产成员时不误判一侧全灭')
    const incoming = { ...f.own[lost === 'escort' ? 5 : 0]!, id: 100 }
    await f.tick([...survivors, incoming])
    activate(f.runtime, { id: 'handoff', kind: 'formation', rawText: '补入现有成员', request: { kind: 'transferUnits', formationId: '1队', unitIds: [100] } })
    await f.runtime.cancelGoal(source.id)
    // 来源已经取消，但现有成员正在交接，仍不能丢掉掩护关系。
    if (lost === 'escort') { run.escortIds.push(100); f.formations.coverOf('1队')!.escortIds.push(100) }
    await f.tick([...survivors, incoming])
    assert.ok(f.formations.coverOf('1队'))
    f.formations.transfer([100], '1队')
    await f.tick([...survivors, incoming])
    assert.ok(f.formations.coverOf('1队'))
    await f.tick(survivors)
    assert.equal(f.formations.coverOf('1队'), undefined, '准备与交接都结束后，一侧真正耗尽转为普通编队')
  }
})

test('同句已生产掩护成员且未重复指定数量时，关联整批来源而不额外再造一辆', async () => {
  const f = await fixture(39, 27, false), executor = new StepExecutor()
  try {
    await f.tick([])
    f.ctx.controller = new ProgramController({ runtime: f.runtime, executor, provider: () => ({ generate: async () => ({ text: productionSource, model: 'fixture', durationMs: 0 }) }) as never })
    const result = await executeCapabilities([
      { capability: 'production.produce', params: { target: 'MTNK', quantity: 5, formationId: '1队' } },
      { capability: 'production.produce', params: { target: 'FV', quantity: 2, formationId: '1队' } },
      { capability: 'skill.run', params: { skillId: 'cover', selector: 'FV', memberSource: 'new' } },
    ], f.ctx, { text: '造5辆坦克和2个IFV编入1队，IFV掩护', prompts: f.prompts, catalog: f.catalog })
    assert.deepEqual(result.skipped, [])
    assert.equal(result.goals.filter(goal => goal.kind === 'production').length, 2)
    const run = [...f.runtime.skillRuns.values()].find(run => run.kind === 'cover')!
    assert.equal(run.kind === 'cover' && run.cover?.escortSources?.length, 1)
    assert.equal(run.kind === 'cover' && run.cover?.escortSources?.[0]?.quantity, 2)
  } finally { await executor.dispose() }
})

test('取消只撤销掩护新增准备；解散后独立生产保留但不重建旧队，同局恢复保留边界', async () => {
  const f = await fixture(), executor = new StepExecutor()
  try {
    f.ctx.controller = new ProgramController({ runtime: f.runtime, executor, provider: () => ({ generate: async () => ({ text: productionSource, model: 'fixture', durationMs: 0 }) }) as never })
    f.runtime.upsertGoal(production({ id: 'independent', formationId: '1队', quantity: 5 }))
    const arranged = await f.run('formation.cover', { formationId: '1队', selector: 'FV', quantity: 2, memberSource: 'new' })
    const added = arranged.goals.find(goal => goal.kind === 'production')!
    assert.equal(added.kind === 'production' && added.quantity, 2)
    await f.run('formation.uncover', { formationId: '1队' })
    assert.equal(f.runtime.goals.get(added.id)!.status, 'cancelled')
    assert.equal(f.runtime.goals.get('independent')!.status, 'active')
    assert.equal(f.formations.membersOf('1队').length, 10)
    assert.equal(f.formations.coverOf('1队'), undefined)
    await f.run('formation.cover', { formationId: '1队', selector: 'ADOG', quantity: 5 })
    const restored = await harness({ run: async () => outcome([]) }, { formations: new FormationRegistry() })
    await restored.runtime.onSnapshot(f.runtime.snapshot!)
    restoreState(restored.runtime, JSON.parse(JSON.stringify(persistState(f.runtime))))
    restored.runtime.upsertGoal({ id: 'dissolve', kind: 'formation', rawText: '解散1队', executionMode: 'native', request: { kind: 'dissolveFormation', formationId: '1队' } })
    restored.runtime.activateNativeGoals('global')
    await restored.runtime.onSnapshot({ ...restored.runtime.snapshot!, seq: restored.runtime.snapshot!.seq + 1, tick: restored.runtime.snapshot!.tick + 30 })
    assert.equal(restored.formations.list().length, 0)
    const independent = restored.runtime.goals.get('independent')!
    assert.equal(independent.status, 'active')
    assert.equal(independent.spec.kind === 'production' && independent.spec.formationId, undefined)
    assert.equal(independent.activeSpec?.kind === 'production' && independent.activeSpec.formationId, undefined)
    assert.ok([...restored.runtime.skillRuns.values()].every(run => !['preparing', 'covering'].includes(run.status)))
  } finally { await executor.dispose() }
})

test('十个单位同属一队；角色保留、原生移动、暂停恢复和解除掩护均不额外编译', async () => {
  const f = await fixture()
  assert.deepEqual(f.formations.membersOf('1队'), Array.from({ length: 10 }, (_, i) => i + 1))
  assert.deepEqual(f.formations.coverOf('1队')!.escortIds, [6, 7, 8, 9, 10])
  assert.equal([...f.runtime.skillRuns.values()][0]!.status, 'covering')
  await f.run('combat.move', { formationId: '1队', x: 80, y: 5 }); await f.tick()
  assert.ok([...f.runtime.goals.values()].some(goal => goal.spec.kind === 'combat' && goal.activeSpec?.executionMode === 'native'))
  f.own.forEach(unit => { unit.rx = unit.id > 5 ? 16 : 10; unit.isIdle = false })
  f.submitted.length = 0; await f.tick()
  assert.equal(f.submitted.some(action => action.kind === 'stop'), false, '普通行军不反复停车')
  await f.run('control.pause', { scope: 'formation', formationId: '1队' })
  const pausedCount = f.submitted.length; await f.tick(); assert.equal(f.submitted.length, pausedCount)
  await f.run('control.resume', { scope: 'formation', formationId: '1队' }); await f.tick()
  await f.run('formation.uncover', { formationId: '1队' }); await f.tick()
  assert.equal(f.formations.coverOf('1队'), undefined)
  assert.equal(f.formations.membersOf('1队').length, 10)
  assert.ok([...f.runtime.goals.values()].some(goal => goal.spec.kind === 'combat' && goal.status === 'active'))
  assert.equal(f.generations, 0)
})

test('更慢的掩护成员落后时受护成员等待，80%到达不能提前推进路线，重启保留角色及进度', async () => {
  const f = await fixture(4, 10)
  await executeCapabilities([
    { capability: 'combat.move', params: { formationId: '1队', x: 60, y: 5 } },
    { capability: 'combat.move', params: { formationId: '1队', x: 80, y: 5 } },
  ], f.ctx, { text: '先去60再去80', prompts: loadCommandPrompts(), catalog: new GameCatalog([], f.runtime.snapshot!, loadCommandPrompts().game) })
  await f.tick()
  const goal = [...f.runtime.goals.values()].find(goal => goal.spec.kind === 'combat')!
  f.own.forEach(unit => { unit.rx = unit.id === 10 ? 40 : 60; unit.isIdle = false })
  f.submitted.length = 0; await f.tick()
  assert.equal(goal.facts.routeIndex ?? 0, 0)
  assert.ok(f.submitted.some(action => action.kind === 'stop' && action.unitIds.some(id => id < 6)))
  const state = persistState(f.runtime)
  const restored = await harness({ run: async () => outcome([]) }, { formations: new FormationRegistry() })
  await restored.runtime.onSnapshot({ ...f.runtime.snapshot!, seq: f.runtime.snapshot!.seq + 1 })
  restoreState(restored.runtime, state)
  assert.deepEqual(restored.formations.coverOf('1队')!.escortIds, [6, 7, 8, 9, 10])
  assert.equal(restored.runtime.goals.get(goal.spec.id)!.facts.routeIndex ?? 0, 0)
  f.own[9]!.rx = 58; await f.tick()
  assert.equal(goal.facts.routeIndex, 1)
  await f.run('combat.move', { formationId: '1队', x: 30, y: 5 })
  assert.ok(f.formations.coverOf('1队'))
  await f.run('control.stop', { scope: 'formation', formationId: '1队' })
  const count = f.submitted.length; await f.tick(); assert.equal(f.submitted.length, count)
})

test('解除掩护后后来普通移动恢复原入口，不被已完成的掩护准备历史改变执行方式', async () => {
  const f = await fixture()
  await f.run('formation.uncover', { formationId: '1队' })
  const result = await bindings['combat.move']({ formationId: '1队', x: 40, y: 5, patrol: false }, {
    ctx: f.ctx, movementGoals: new Map(), check: () => {}, catalog: async () => f.catalog,
  } as unknown as BindingContext)
  assert.equal(result.goals![0]!.goal.executionMode, undefined)
  assert.equal(f.formations.membersOf('1队').length, 10)
})

test('队内角色修改只撤销本队旧动作，不使无关全局生产编译失效', async () => {
  const f = await fixture()
  f.runtime.upsertGoal(production({ id: 'new-production' }))
  const lease = f.runtime.beginCompile('global')
  f.runtime.setCover('1队', { ...f.formations.coverOf('1队')! })
  assert.equal(f.runtime.isCompileCurrent(lease), true)
  f.runtime.releaseCommand(lease)
})
