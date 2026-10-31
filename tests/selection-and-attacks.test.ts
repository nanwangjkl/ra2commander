import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { StepExecutor } from '../packages/js-worker/src/index.ts'
import { checkAttackStages } from '../packages/command/src/attack-checks.ts'
import { compileCommand, loadPrompts } from '../packages/command/src/index.ts'
import { inTargetRegion, validateScriptActions, type Snapshot, type SnapshotUnit, type ScriptAction } from '../packages/contracts/src/index.ts'
import { FormationRegistry, persistState, restoreState } from '../packages/runtime/src/index.ts'
import { GameCatalog, type CatalogItem } from '../apps/companion/src/game-catalog.ts'
import { matchesFutureMember } from '../apps/companion/src/unit-selection.ts'
import { selectUnitSet } from '../apps/companion/src/capabilities/selectors.ts'
import { executeCapabilities } from '../apps/companion/src/capabilities/index.ts'
import { normalizeOperations } from '../apps/companion/src/transcript-plan.ts'
import { loadIceMap } from '../apps/companion/src/map-binding.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { activate, harness, production, snapshot } from './helpers.ts'

const profile = loadPrompts().game
const unit = (id: number, name: string, type = 1, ammo = 1): SnapshotUnit => ({ id, name, type, ammo, rx: 5, ry: 5, isIdle: true, primaryWeapon: { minRange: 0, maxRange: 4, aa: false, ag: true, cooldownTicks: 0 } })
function catalog(snap: Snapshot): GameCatalog {
  const items = [['ORCA', 1, '飞机'], ['BEAG', 1, '黑鹰战机'], ['TANKX', 7, '试验坦克'], ['CMIN', 7, '矿车'], ['DMTK', 2, '灰熊坦克'], ['DOG', 3, '狗'], ['GACNST', 2, '基地']].map(([name, type, label]) => ({ name: name as string, type: type as number, label: label as string, power: 0, available: true, factions: [], aliases: [label as string], roles: profile.rolesFor(name as string, type as number, { label: label as string, ...(name === 'CMIN' ? { harvester: true } : {}) }), ammo: 1 }))
  return new GameCatalog(items as CatalogItem[], snap, profile)
}
// 模拟本机脚本读取公开帧，不调用云模型或真实游戏。
const executor = { run: async (_code: string, value: unknown, memory: unknown) => {
  const snap = value as Snapshot, actions: ScriptAction[] = []
  for (const g of snap.control!.goals) {
    const management = snap.constraints!.goals![g.spec.id]!.management
    if (management?.allowedUnitIds.length) actions.push({ goalId: g.spec.id, request: { kind: management.kind as 'transferUnits', formationId: management.formationId, unitIds: management.allowedUnitIds } })
    if (!g.attack) continue
    if (g.attack.targets[0] && g.attack.readyIds.length) actions.push({ goalId: g.spec.id, request: { kind: 'attack', unitIds: g.attack.readyIds, targetId: g.attack.targets[0].id } })
    else if (g.spec.kind === 'attack' && g.spec.objective?.search.kind === 'region' && g.attack.groundIds.length) {
      const point = g.spec.objective.search.destination!
      actions.push({ goalId: g.spec.id, request: { kind: 'attackMove', unitIds: g.attack.groundIds, x: point.x, y: point.y } })
    }
  }
  return { ok: true, actions, memory }
} }
function context(runtime: Awaited<ReturnType<typeof harness>>['runtime']): CommandContext {
  return { runtime, formations: runtime.formations, controller: {
    activateNative(owner: string) { runtime.activateNativeGoals(owner); return '本机执行' },
    async prepareNative(owner: string) {
      for (const goal of runtime.goals.values()) if (goal.ownerId === owner && goal.spec.kind === 'production' && goal.spec.executionMode === 'native') {
        const lease = runtime.beginNativePreparation(goal.spec.id)
        runtime.commitNativePreparation(lease, goal.spec); runtime.releaseNativePreparation(lease)
      }
      runtime.activateNativeGoals(owner); return '本机执行'
    },
    async refresh(owner: string) { const lease = runtime.beginCompile(owner); assert.equal(runtime.commitCompile(lease, 'function step(s,m){return {actions:[],memory:m}}'), true); return 'ok' },
  } } as unknown as CommandContext
}

test('目录名称/角色同时用于生产、现有成员和待加入候选；先过滤归属再取数量', async () => {
  const { runtime, formations } = await harness(executor, { formations: new FormationRegistry() })
  const self = [unit(1, 'TANKX', 7), unit(2, 'TANKX', 7), unit(3, 'CMIN', 7), unit(4, 'DMTK', 2)]
  await runtime.onSnapshot(snapshot({ seq: 2, self }))
  formations.create('1队', [1])
  const known = catalog(runtime.snapshot!), ctx = context(runtime)
  for (const name of ['TANKX', '试验坦克', '所有坦克']) {
    assert.equal(known.resolve(name)?.name, 'TANKX')
    assert.deepEqual(selectUnitSet(ctx, { selector: name, quantity: 1 }, known, profile, { unassigned: true }).selected.map(unit => unit.id), [2])
    assert.equal(matchesFutureMember(known.all.find(item => item.name === 'TANKX')!, name, known), true)
  }
  assert.deepEqual(selectUnitSet(ctx, { selector: 'tanks' }, known).selected.map(unit => unit.id), [2, 1], '坦克类别排除矿车和部署成建筑的项目')
  assert.deepEqual(selectUnitSet(ctx, { selector: 'aircraft', unitIds: [2] }, known).selected.map(unit => unit.id), [2], '明确 ID 保留选择')
  const corrected = normalizeOperations('5辆试验坦克编入1队', [{ capability: 'production.produce', params: { target: 'TANKX', quantity: 5, formationId: '1队' } }], undefined, known)
  assert.deepEqual(corrected, [{ capability: 'formation.assign', params: { selector: 'tanks', quantity: 5, formationId: '1队' } }], '误解纠正不依赖固定单位 ID 列表')
})

test('已有首批飞机时继续接入本次生产成员，旧 v4 恢复不吸收无关同型飞机或重派已发射成员', async () => {
  let env = await harness(executor, { formations: new FormationRegistry() }), runtime = env.runtime
  let self = [unit(11, 'ORCA'), unit(31, 'ORCA'), unit(40, 'DOG', 3)]
  const enemies = [unit(90, 'GACNST', 2)]
  await runtime.onSnapshot(snapshot({ seq: 2, self, enemies }))
  runtime.formations.create('1队', [11]); runtime.formations.create('侦察', [40])
  const result = await executeCapabilities([
    { capability: 'production.produce', params: { target: 'ORCA', quantity: 2, formationId: '1队' } },
    { capability: 'combat.attack', params: { selector: 'aircraft', formationId: '1队', target: 'base' } },
  ], context(runtime), { text: '造两架飞机编入1队，1队飞机攻击基地', catalog: catalog(runtime.snapshot!) })
  assert.deepEqual(result.skipped, [])
  const production = result.goals.find(goal => goal.kind === 'production')!, attack = result.goals.find(goal => goal.kind === 'attack')!
  assert.equal(attack.kind === 'attack' && attack.membership?.kind, 'prepared')
  runtime.production.push({ id: 'planes', goalId: production.id, name: 'ORCA', quantity: 2, building: false, state: 'submitted', observedIds: [], placed: false })
  const tick = async () => runtime.onSnapshot(snapshot({ ...runtime.snapshot!, self, enemies, seq: runtime.snapshot!.seq + 1, tick: runtime.snapshot!.tick + 30 }))
  await tick()
  assert.deepEqual(env.submitted.flatMap(action => action.kind === 'attack' ? action.unitIds : []), [11])
  self = self.map(unit => unit.id === 11 ? { ...unit, ammo: 0 } : unit)
  await tick()
  const saved = JSON.parse(JSON.stringify(persistState(runtime)))
  for (const [, goal] of saved.goals) for (const spec of [goal.spec, goal.activeSpec]) if (spec?.kind === 'attack') { delete spec.objective; delete spec.membership; spec.dynamicNames = ['ORCA'] }
  env = await harness(executor, { formations: new FormationRegistry() })
  await env.runtime.onSnapshot(runtime.snapshot!)
  restoreState(env.runtime, saved); runtime = env.runtime
  runtime.formations.transfer([31], '1队')
  self = [...self, unit(21, 'ORCA')]
  await tick(); await tick()
  self = self.map(unit => unit.id === 21 ? { ...unit, ammo: 0 } : unit)
  self = [...self, unit(22, 'ORCA')]
  await tick(); await tick()
  const ids = env.submitted.flatMap(action => action.kind === 'attack' ? action.unitIds : [])
  assert.deepEqual(ids, [21, 22], '只接收本目标产物；11已发射，31不是本次来源')
  assert.equal(runtime.programs.has('formation:侦察'), false)
  self = self.map(unit => unit.id === 22 ? { ...unit, ammo: 0 } : unit)
  await tick()
  assert.equal(runtime.goals.get(attack.id)!.status, 'completed')
})

test('混编队区域清敌保留地面搜索，飞机装弹等待，目标类型和异形地域共同约束', async () => {
  const { runtime, formations, submitted } = await harness(executor, { formations: new FormationRegistry() })
  const self = [unit(11, 'ORCA', 1, 0), unit(12, 'TANKX', 7), unit(40, 'DOG', 3)]
  await runtime.onSnapshot(snapshot({ seq: 2, self, enemies: [unit(90, 'ENEMY', 7)], mapWidth: 200, mapHeight: 200 }))
  formations.create('1队', [11, 12]); formations.create('侦察', [40])
  const ctx = context(runtime), { regions } = await loadIceMap()
  ctx.mapRegions = regions; ctx.mapSessionKey = runtime.battleKey
  const result = await executeCapabilities([{ capability: 'combat.clear-region', params: { formationId: '1队', regionName: '三楼右下' } }], ctx, { text: '1队清理三楼右下', catalog: catalog(runtime.snapshot!) })
  assert.deepEqual(result.skipped, [])
  const goal = result.goals[0]!
  assert.equal(goal.kind === 'attack' && goal.objective?.search.kind, 'region')
  await runtime.onSnapshot({ ...runtime.snapshot!, seq: 3, tick: 45 })
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0]!.kind, 'move', '进入分区前将攻击移动转为普通行军')
  assert.deepEqual('unitIds' in submitted[0]! && submitted[0]!.unitIds, [12], '不对装弹飞机下移动命令')
  assert.equal(runtime.goals.get(goal.id)!.status, 'active')
  runtime.useScriptExecution(['attack']) // 继续验证旧脚本回退的搜索契约。
  const lease = runtime.beginCompile('formation:1队'), frame = runtime.compileFrame(lease), view = frame.snapshot.control!.goals[0]!
  assert.equal(view.attack!.targets.length, 0, '区外可见敌人不能成为攻击目标')
  if (view.spec.kind !== 'attack') throw new Error('没有统一攻击目标')
  const region = view.spec.objective!.target.region!, point = view.spec.objective!.search.destination!
  assert.equal(inTargetRegion(point.x, point.y, region), true)
  const invalid = [{ goalId: goal.id, request: { kind: 'attack' as const, unitIds: [12], targetId: 90 } }]
  assert.ok(validateScriptActions(invalid, frame.constraints, frame.snapshot))
  const isolated = new StepExecutor()
  try {
    const attackOnly = `function step(s,m){const a=[];for(const g of s.control.goals)if(g.attack&&g.attack.targets.length&&g.attack.readyIds.length)a.push({goalId:g.spec.id,request:{kind:'attack',unitIds:g.attack.readyIds,targetId:g.attack.targets[0].id}});return {actions:a,memory:m}}`
    const search = `function step(s,m){const a=[];for(const g of s.control.goals){if(!g.attack)continue;if(g.attack.targets.length&&g.attack.readyIds.length)a.push({goalId:g.spec.id,request:{kind:'attack',unitIds:g.attack.readyIds,targetId:g.attack.targets[0].id}});else if(!g.attack.targets.length&&g.attack.groundIds.length){const p=g.spec.objective.search.destination;a.push({goalId:g.spec.id,request:{kind:'move',unitIds:g.attack.groundIds,x:p.x,y:p.y}});}}return {actions:a,memory:m}}`
    assert.match((await checkAttackStages(attackOnly, frame, isolated))!, /地面成员仍须前往/)
    assert.equal(await checkAttackStages(search, frame, isolated), undefined)
  } finally { await isolated.dispose() }
  runtime.releaseCommand(lease)
})

test('回放坦克围住基地却不开火：拦截行军去重错误，反馈模型重试后直接攻击', async () => {
  const isolated = new StepExecutor()
  const { runtime, submitted } = await harness(isolated, { formations: new FormationRegistry() })
  try {
    const self = [1, 2, 3, 4, 5].map(id => ({ ...unit(id, 'TANKX', 7), rx: 146 + id % 2, ry: 80 }))
    const enemies = [{ ...unit(90, 'GACNST', 2), rx: 38, ry: 81, hitPoints: 1000 }]
    await runtime.onSnapshot(snapshot({ seq: 2, self, enemies, mapWidth: 200, mapHeight: 200 }))
    const result = await executeCapabilities([{ capability: 'combat.attack', params: { selector: 'tanks', quantity: 'all', target: 'base' } }], context(runtime), { text: '所有坦克摧毁敌方基地', catalog: catalog(runtime.snapshot!) })
    assert.deepEqual(result.skipped, [])
    runtime.useScriptExecution(['attack']) // 旧故障脚本仍须在回退入口被正确拦截。
    const lease = runtime.beginCompile('global'), frame = runtime.compileFrame(lease)
    const broken = readFileSync(new URL('./fixtures/ground-attack-move-dedup.js', import.meta.url), 'utf8')
    // 真实故障只改去重条件即可继续攻击，检查不应误拒绝正确的分阶段脚本。
    const staged = broken.replace('if (lastTarget === chosen.id && lastIds === idsKey)', "if (mem.mode === 'attack' && lastTarget === chosen.id && lastIds === idsKey)")
    assert.notEqual(staged, broken)
    assert.equal(await checkAttackStages(staged, frame, isolated), undefined)
    const direct = `function step(s,m){const actions=[];for(const g of s.control.goals){
      if(!g.attack||!g.attack.targets.length||!g.attack.readyIds.length)continue;
      const target=g.attack.targets[0],ids=g.attack.readyIds,key='attack:'+target.id+':'+ids.join(',');
      if(m[g.spec.id]===key)continue;
      actions.push({goalId:g.spec.id,request:{kind:'attack',unitIds:ids,targetId:target.id}});m[g.spec.id]=key;
    }return {actions,memory:m}}`
    const requests: Array<Array<{ role: string; content: string }>> = []
    const provider = { generate: async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
      requests.push(structuredClone(messages))
      return { text: requests.length === 1 ? broken : direct, model: 'fixture', durationMs: 0 }
    } }
    const compiled = await compileCommand(provider as never, frame, isolated, { maxAttempts: 2 })
    assert.equal(compiled.attempts, 2)
    assert.match(compiled.log[0]!.errors.join(' '), /抵达.*attack.*去重须区分动作类型/)
    assert.match(requests[1]!.at(-1)!.content, /不能把先前 move\/attackMove 的目标记忆当成已攻击/)
    assert.deepEqual(compiled.log[1]!.errors, [])
    assert.equal(runtime.commitCompile(lease, compiled.code), true)
    await runtime.onSnapshot({ ...runtime.snapshot!, seq: 3, tick: 45 })
    assert.deepEqual(submitted, [{ kind: 'attack', unitIds: [1, 2, 3, 4, 5], targetId: 90 }], '远处已有明确基地目标时直接下达攻击，不等待进入射程')
    await runtime.onSnapshot({ ...runtime.snapshot!, seq: 4, tick: 75 })
    assert.equal(submitted.length, 1, '正确的攻击去重仍有效，不逐步打断游戏接近和开火')
    assert.deepEqual(frame.snapshot.self, self, '阶段检查只改变隔离副本')
  } finally { await isolated.dispose() }
})

test('待准备攻击保留数量上限，成员损失和准备目标取消不触发自动补入同型成员', async () => {
  const { runtime, formations, submitted } = await harness(executor, { formations: new FormationRegistry() })
  let self = [unit(11, 'ORCA')]
  const enemies = [unit(90, 'GACNST', 2)]
  await runtime.onSnapshot(snapshot({ seq: 2, self, enemies }))
  formations.create('1队', [11])
  activate(runtime, production({ target: 'ORCA', targetType: 1, quantity: 3, formationId: '1队' }))
  const result = await executeCapabilities([{ capability: 'combat.attack', params: { selector: 'aircraft', formationId: '1队', quantity: 2, target: 'base' } }], context(runtime), { text: '让1队两架飞机出击', catalog: catalog(runtime.snapshot!) })
  assert.deepEqual(result.skipped, [])
  const goal = result.goals[0]!
  runtime.production.push({ id: 'planes', goalId: 'production', name: 'ORCA', quantity: 3, building: false, state: 'submitted', observedIds: [], placed: false })
  const tick = async () => runtime.onSnapshot({ ...runtime.snapshot!, self, enemies, seq: runtime.snapshot!.seq + 1, tick: runtime.snapshot!.tick + 30 })
  await tick()
  self = [{ ...self[0]!, ammo: 0 }, unit(21, 'ORCA', 1, 0)]
  await tick(); await tick()
  self = [...self, unit(22, 'ORCA')]
  await tick(); await tick()
  assert.deepEqual(submitted.flatMap(action => action.kind === 'attack' ? action.unitIds : []), [11], '21装弹占本次名额，不用后来满弹的22替换')
  self = self.filter(unit => unit.id !== 21)
  await runtime.cancelGoal('production')
  await tick()
  assert.equal(runtime.goals.get(goal.id)!.status, 'partial')
  assert.deepEqual(submitted.flatMap(action => action.kind === 'attack' ? action.unitIds : []), [11], '取消准备及损失成员不自动补员')
})
