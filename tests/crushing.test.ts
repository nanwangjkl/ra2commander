import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPrompts } from '../packages/command/src/index.ts'
import { crushCompatible, type ActionRequest, type CombatGoal, type Snapshot, type SnapshotUnit, type TargetRegion } from '../packages/contracts/src/index.ts'
import { FormationRegistry, persistState, restoreState, type RuntimeDeps } from '../packages/runtime/src/index.ts'
import { emptyCrushing, planCrushing, recordCrushing } from '../packages/runtime/src/crushing.ts'
import { emptyUnitOrders, recordUnitOrder } from '../packages/runtime/src/unit-orders.ts'
import { activate, deferred, harness, outcome, snapshot, spec } from './helpers.ts'

const rules = loadPrompts().game.crushing()!
const unit = (id: number, name = 'MTNK', x = 5, y = 5, type = 7): SnapshotUnit => ({ id, name, type, rx: x, ry: y, isIdle: false, zone: 0, onBridge: false, speed: name === 'HTK' ? 72 : 48, primaryWeapon: { minRange: 0, maxRange: 6, ag: true, aa: false }, ...(name === 'HTK' ? { secondaryWeapon: { minRange: 0, maxRange: 6, ag: false, aa: true } } : {}) })
const enemy = (id = 101, x = 10, y = 5, name = 'E1') => unit(id, name, x, y, 3)
const objective: NonNullable<CombatGoal['objective']> = { target: { kind: 'enemies', names: [] }, search: { kind: 'visible' }, completion: { ground: 'continuous', aircraft: 'single-shot' }, coordination: 'focus' }
async function battle(own = [unit(1)], enemies = [enemy()], extra: Partial<RuntimeDeps> = {}, goal: Partial<CombatGoal> = {}) {
  const formations = new FormationRegistry(); formations.create('A', own.map(u => u.id))
  const h = await harness({ run: async () => outcome([]) }, { formations, crushing: rules, ...extra })
  await h.runtime.onSnapshot(snapshot({ seq: 2, self: own, enemies }))
  h.runtime.activateNativeGoals(h.runtime.upsertGoal(spec({ executionMode: 'native', region: { name: '全图', x1: 0, y1: 0, x2: 99, y2: 99 }, mode: 'assault', objective, ...goal })))
  const tick = (patch: Partial<Snapshot> = {}) => h.runtime.onSnapshot({ ...h.runtime.snapshot!, seq: h.runtime.snapshot!.seq + 1, tick: h.runtime.snapshot!.tick + 30, time: h.runtime.snapshot!.time + 1, ...patch })
  return { ...h, tick }
}

test('规则缺省从目录导入，执行车型和狗的排除名单独立于原生碾压能力', () => {
  const profile = loadPrompts().game
  assert.equal(profile.entry('APOC')!.crusher, true)
  assert.equal(profile.entry('FV')!.crusher, false)
  assert.equal(profile.entry('E1')!.crushable, true)
  assert.equal(profile.entry('SHK')!.crushable, false)
  assert.equal(profile.entry('DOG')!.crushable, true)
  for (const name of ['MTNK', 'HTNK', 'HTK']) assert.equal(crushCompatible(unit(1, name), enemy(), rules), true)
  for (const name of ['APOC', 'FV']) assert.equal(crushCompatible(unit(1, name), enemy(), rules), false)
  for (const name of ['DOG', 'ADOG', 'SHK', 'TANY']) assert.equal(crushCompatible(unit(1), enemy(101, 10, 5, name), rules), false)
  assert.equal(crushCompatible(unit(1), { ...enemy(), zone: 1 }, rules), false)
  assert.equal(crushCompatible(unit(1), { ...enemy(), onBridge: true }, rules), false)
  assert.equal(crushCompatible(unit(1), enemy(), undefined), false)
})

test('本机普通编队和直接攻击均分头碾压；同格目标只派一车，其他车型保留开火', async () => {
  const h = await battle([unit(1), unit(2, 'HTNK'), unit(3, 'HTK'), unit(4, 'APOC'), unit(5, 'FV')], [enemy(), enemy(102, 12), enemy(103, 14)])
  await h.tick()
  const crush = h.submitted.filter(a => a.kind === 'crush')
  assert.equal(crush.length, 3)
  assert.equal(new Set(crush.map(a => a.targetId)).size, 3)
  assert.deepEqual(h.submitted.filter(a => a.kind === 'attack').flatMap(a => a.unitIds).sort(), [4, 5])
  assert.match(h.runtime.goalExecution('alpha')!.detail!, /分头碾压/)

  const direct = await battle([unit(1), unit(2)], [enemy(), enemy(102)])
  await direct.runtime.cancelGoal('alpha'); direct.submitted.length = 0
  direct.formations.dissolve('A')
  direct.runtime.activateNativeGoals(direct.runtime.upsertGoal({ id: 'direct', kind: 'attack', rawText: '所有坦克进攻', executionMode: 'native', unitIds: [1, 2], aircraftIds: [], preparationGoalIds: [], ammoCapacity: {}, objective, targetKind: 'enemies', targetNames: [] }))
  await direct.tick()
  assert.equal(direct.submitted.filter(a => a.kind === 'crush').length, 1, '同一接触点不挤两辆车')
  assert.equal(direct.submitted.filter(a => a.kind === 'attack').length, 0)
})

test('多个编队共享目标占用；暂停释放占用，恢复重新分配，不恢复旧强移', async () => {
  const h = await battle([unit(1), unit(2)], [enemy(), enemy(102, 13)])
  h.formations.create('B', [2], { force: true })
  h.runtime.activateNativeGoals(h.runtime.upsertGoal(spec({ id: 'bravo', formationId: 'B', executionMode: 'native', objective })))
  await h.tick()
  const crush = h.submitted.filter(a => a.kind === 'crush')
  assert.equal(crush.length, 2); assert.notEqual(crush[0]!.targetId, crush[1]!.targetId)
  h.runtime.pause('formation:A'); h.submitted.length = 0
  await h.tick({ time: 100 })
  assert.equal(h.submitted.some(a => a.kind === 'crush' && a.unitIds.includes(1)), false)
  h.runtime.resume('formation:A')
  await h.tick()
  assert.equal(h.runtime.goals.get('alpha')!.facts.crushing!.pairs[1]!.attempts, 0, '暂停时间不计为受阻')
})

test('回放八辆坦克追一个步兵：一车碾压，其余继续集火车辆，不因攻击去重再停车', async () => {
  const own = [[8, 10], [6, 14], [7, 12], [9, 9], [9, 12], [10, 7], [11, 7], [8, 8]].map(([x, y], i) => unit(i + 1, 'HTNK', x!, y!))
  const enemies = [enemy(101, 10, 12), unit(102, 'MGTK', 13, 10), unit(103, 'FV', 14, 11), { ...enemy(104, 12, 10, 'JUMPJET'), zone: 1 }]
  const h = await battle(own, enemies)
  h.runtime.activateNativeGoals(h.runtime.upsertGoal({ id: 'selected-spare-fire', kind: 'attack', rawText: '1队攻击敌方部队', executionMode: 'native', formationId: 'A', unitIds: own.map(unit => unit.id), aircraftIds: [], preparationGoalIds: [], ammoCapacity: {}, objective, targetKind: 'units', targetNames: [] }))
  await h.tick()
  const crushing = h.submitted.filter(a => a.kind === 'crush'), fire = h.submitted.filter(a => a.kind === 'attack')
  assert.equal(crushing.length, 1)
  assert.equal(fire.flatMap(a => a.unitIds).length, 7)
  assert.equal(new Set(fire.map(a => a.targetId)).size, 1, '剩余成员保持普通编队集火')
  assert.ok(fire.every(a => [102, 103].includes(a.targetId)))
  assert.equal(h.submitted.some(a => a.kind === 'stop'), false)
  const backup = fire[0]!.targetId
  h.submitted.length = 0; await h.tick()
  assert.equal(h.submitted.length, 0, '有效的火力令和强移令都保持，不因本步未重发而停车')
  await h.tick({ enemies: enemies.filter(enemy => enemy.id !== backup) })
  assert.equal(h.submitted.filter(a => a.kind === 'attack').flatMap(a => a.unitIds).length, 7)
  assert.ok(h.submitted.every(a => a.kind !== 'attack' || [102, 103].includes(a.targetId) && a.targetId !== backup))

  const limited = await battle(own.slice(0, 2), enemies, {}, { objective: { ...objective, target: { ...objective.target, unitNames: ['E1'] } } })
  await limited.tick()
  assert.equal(limited.submitted.filter(a => a.kind === 'crush').length, 1)
  assert.equal(limited.submitted.some(a => a.kind === 'attack'), false, '明确只攻步兵时不为填补空闲而扩大到车辆或空军')
})

test('目标位置变化节流追踪，失去观察和离区结束旧强移；限定兵种不被改成追其他步兵', async () => {
  const region: TargetRegion = { id: 'defense', name: '防区', polygons: [{ outer: [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]], holes: [] }] }
  const h = await battle(undefined, undefined, {}, { objective: { ...objective, target: { ...objective.target, region } } })
  await h.tick(); h.submitted.length = 0
  await h.tick(); assert.equal(h.submitted.length, 0, '固定目标不反复重发')
  await h.tick({ enemies: [enemy(101, 12)] })
  assert.equal(h.submitted.at(-1)!.kind, 'crush')
  h.submitted.length = 0
  await h.tick({ enemies: [enemy(101, 25)] })
  assert.ok(h.submitted.some(a => a.kind === 'stop'))
  assert.deepEqual(h.runtime.goals.get('alpha')!.facts.crushing!.pairs, {})
  await h.tick({ enemies: [enemy()] }); h.submitted.length = 0
  await h.tick({ enemies: [] })
  assert.ok(h.submitted.some(a => a.kind === 'stop'))
  const specific = await battle(undefined, [enemy(), unit(102, 'NACNST', 20, 5, 2)], {}, { objective: { ...objective, target: { kind: 'buildings', names: [] } } })
  await specific.tick()
  assert.ok(specific.submitted.every(a => a.kind !== 'crush'))
  assert.ok(specific.submitted.some(a => a.kind === 'attack' && a.targetId === 102))
})

test('碾压受阻有限重试，回退火力跨同局恢复保留；目标确实移开后重新尝试', async () => {
  const submitted: ActionRequest[] = []
  const h = await battle(undefined, undefined, { submit: async (actions, context, guard) => { if (!guard()) return []; submitted.push(...actions); return actions.map(action => ({ ok: action.kind !== 'crush', submitted: action.kind === 'crush' ? 0 : 1, session: context.session })) } })
  for (let n = 0; n < 12; n++) await h.tick()
  assert.equal(submitted.filter(a => a.kind === 'crush').length, 3)
  assert.ok(submitted.some(a => a.kind === 'attack'))
  assert.match(h.runtime.goalExecution('alpha')!.detail!, /受阻，改用火力/)
  const saved = JSON.parse(JSON.stringify(persistState(h.runtime)))
  const restored = await harness({ run: async () => outcome([]) }, { crushing: rules, formations: new FormationRegistry() })
  await restored.runtime.onSnapshot(h.runtime.snapshot!); restoreState(restored.runtime, saved)
  let current = h.runtime.snapshot!
  const tick = async (enemies = current.enemies) => { current = { ...current, seq: current.seq + 1, tick: current.tick + 30, time: current.time + 1, enemies }; await restored.runtime.onSnapshot(current) }
  await tick(); await tick()
  assert.equal(restored.submitted.some(a => a.kind === 'crush'), false)
  assert.equal(restored.runtime.goals.get('alpha')!.facts.crushing!.pairs[1]!.attempts, 3)
  await tick([enemy(101, 14)])
  assert.ok(restored.submitted.some(a => a.kind === 'crush'))
})

test('正常移动不误判受阻；停滞才有限重试，脚本空动作仍持续追踪已确认目标', () => {
  const state = emptyCrushing(), orders = emptyUnitOrders()
  let snap = snapshot({ self: [unit(1)], enemies: [enemy()] })
  const next = (requests: ActionRequest[] = []) => {
    const actions = planCrushing({ snap, rules, state, unitIds: [1], targets: snap.enemies, requests, orders: orders.orders, claims: [], escort: () => false, canPursue: () => true, follow: () => undefined })
    for (const request of actions) { const result = [{ ok: true, submitted: 1, session: snap.session }]; recordCrushing(state, request, result, snap); recordUnitOrder(orders, request, snap.tick, result) }
    return actions
  }
  next([{ kind: 'attack', unitIds: [1], targetId: 101 }])
  for (let n = 0; n < 5; n++) { snap = { ...snap, tick: snap.tick + 90, time: snap.time + 3, self: [unit(1, 'MTNK', 6 + n)] }; next() }
  assert.equal(state.pairs[1]!.attempts, 0)
  for (let n = 0; n < 3; n++) { snap = { ...snap, tick: snap.tick + 90, time: snap.time + 3 }; next() }
  assert.equal(state.pairs[1]!.phase, 'fire')
})

test('掩护 HTK 不离开坦克追步兵，有空中威胁仍优先对空；近身目标可碾压', async () => {
  const body = unit(1, 'APOC'), escort = unit(2, 'HTK')
  const air = { ...enemy(102, 8, 5, 'JUMPJET'), zone: 1 }
  const h = await battle([body, escort], [enemy(101, 8), air], { coverRanges: async pairs => pairs.map(pair => ({ ...pair, canAttack: true, inRange: true })) })
  h.runtime.setCover('A', { runId: 'cover', version: '0.2.5', escortIds: [2], gap: 4, resumeGap: 2, retryTicks: 90 })
  await h.tick()
  assert.ok(h.submitted.some(a => a.kind === 'attack' && a.unitIds.includes(2) && a.targetId === 102), '空中威胁优先')
  h.submitted.length = 0
  await h.tick({ enemies: [enemy(101, 8)] })
  assert.ok(h.submitted.some(a => a.kind === 'crush' && a.unitIds.includes(2)))
  h.submitted.length = 0
  await h.tick({ enemies: [enemy(101, 30)] })
  assert.equal(h.submitted.some(a => a.kind === 'crush' && a.unitIds.includes(2)), false)
  assert.ok(h.submitted.some(a => (a.kind === 'move' || a.kind === 'stop') && a.unitIds.includes(2)))
  h.submitted.length = 0
  h.runtime.activateNativeGoals(h.runtime.upsertGoal({ id: 'selected-cover', kind: 'attack', rawText: '1队攻击', executionMode: 'native', formationId: 'A', unitIds: [1, 2], aircraftIds: [], preparationGoalIds: [], ammoCapacity: {}, objective, targetKind: 'enemies', targetNames: [] }))
  await h.tick()
  assert.equal(h.submitted.some(a => a.kind === 'crush' && a.unitIds.includes(2)), false, '选中编队的 attack 入口也保留掩护约束')
})

test('脚本兼容攻击接入碾压，取消后迟到回执不续发其余车辆；出厂未就绪不参与', async () => {
  const entered = deferred<void>(), receipt = deferred<void>(), submitted: ActionRequest[] = []
  const h = await battle([unit(1), unit(2)], [enemy(), enemy(102, 12)], { submit: async (actions, context, guard) => { if (!guard()) return []; submitted.push(...actions); if (actions.some(a => a.kind === 'crush')) { entered.resolve(); await receipt.promise }; return actions.map(() => ({ ok: true, submitted: 1, session: context.session })) } })
  const running = h.tick(); await entered.promise
  await h.runtime.cancelGoal('alpha'); receipt.resolve(); await running
  assert.equal(submitted.filter(a => a.kind === 'crush').length, 1)
  await h.tick(); assert.equal(submitted.filter(a => a.kind === 'crush').length, 1)

  const script = await harness({ run: async () => outcome([{ kind: 'attack', unitIds: [1], targetId: 101 }]) }, { crushing: rules })
  await script.runtime.onSnapshot(snapshot({ seq: 2, self: [unit(1)], enemies: [enemy()] }))
  activate(script.runtime, spec({ objective }))
  await script.runtime.onSnapshot({ ...script.runtime.snapshot!, seq: 3, tick: 45 })
  assert.ok(script.submitted.some(a => a.kind === 'crush'))

  const exiting = await battle([unit(1), unit(2)], [enemy(), enemy(102, 12)])
  exiting.runtime.productionExits.state.units.push({ unitId: 2, name: 'MTNK', type: 7, born: { x: 5, y: 5 }, position: { x: 5, y: 5 }, point: { x: 25, y: 5 }, phase: 'rallying', progressAt: 1, attempts: 0 })
  await exiting.tick()
  assert.ok(exiting.submitted.some(a => a.kind === 'crush' && a.unitIds.includes(1)))
  assert.ok(exiting.submitted.every(a => !('unitIds' in a) || !a.unitIds.includes(2)), '出厂未到集结点的成员不能被碾压调度抢走')
  exiting.runtime.productionExits.state.units[0]!.phase = 'ready'
  await exiting.tick()
  assert.ok(exiting.submitted.some(a => a.kind === 'crush' && a.unitIds.includes(2)), '交接就绪后再参与作战')
})
