import { randomUUID } from 'node:crypto'
import type { CapabilityId, GameProfile, ResolvedCapabilityParameters as CapabilityParameters } from '@ra2c/command'
import type { CombatGoal, FormationGoal, GoalSpec, ProductionGoal } from '@ra2c/contracts'
import type { CommandContext } from '../commands.ts'
import { checkPoint, destination, formationName, fullMap, rectangle, regionDestination, resolveOwner, selectUnits, type GameCatalog } from './selectors.ts'

export interface BindingContext {
  ctx: CommandContext
  text: string
  check: () => void
  catalog: () => Promise<GameCatalog>
  game: GameProfile
  knownCatalog?: GameCatalog | undefined
  cancelUnderstanding: () => void
  formationGoals: Map<string, FormationGoal>
  movementGoals: Map<string, CombatGoal>
}
export interface BoundCapability {
  goals?: Array<{ goal: GoalSpec; choice: string }>
  choices?: string[]
  skipped?: string[]
  refreshOwners?: string[]
  suppressOwners?: string[]
}
type Binders = { [Id in CapabilityId]: (params: CapabilityParameters[Id], context: BindingContext) => Promise<BoundCapability> }
const id = () => `command-${randomUUID().slice(0, 8)}`
const bound = (goal: GoalSpec, choice: string): BoundCapability => ({ goals: [{ goal, choice }] })
const done = (choice: string): BoundCapability => ({ choices: [choice] })

async function catalogTarget(target: string, context: BindingContext) {
  const rule = (await context.catalog()).resolve(target)
  if (!rule && /^[A-Z][A-Z0-9_]+$/.test(target)) return { name: target, label: target, type: undefined as number | undefined }
  if (!rule) throw new Error(`未找到可用生产项目：${target}`)
  return rule
}
async function control(params: CapabilityParameters['control.stop'], context: BindingContext, action: 'stop' | 'pause' | 'resume'): Promise<BoundCapability> {
  const { ctx } = context
  context.cancelUnderstanding()
  const scope = params.scope
  const units = scope === 'units' ? selectUnits(ctx, params, context.knownCatalog, context.game) : undefined
  const owners = scope === 'all' ? [...new Set([...ctx.runtime.programs.keys(), ...ctx.runtime.pendingCommandIds()])]
    : scope === 'global' ? ['global']
      : units ? [...new Set(units.map(unit => ctx.formations.ownerOf(unit.id)).map(formation => formation ? `formation:${formation}` : 'global'))]
        : [resolveOwner(ctx, params.formationId ?? '')]
  if (scope === 'units' && !units?.length) throw new Error('没有可控制的匹配单位')
  context.check()
  if (action === 'stop') {
    if (scope === 'units') await ctx.runtime.stopUnits(units!.map(unit => unit.id))
    else await Promise.all(owners.map(owner => ctx.runtime.stop(owner)))
    context.check()
    // 没有活动脚本的成员也应能停车；stop all 包含未编队单位。
    const ids = scope === 'all' ? selectUnits(ctx, {}, undefined, context.game).map(unit => unit.id) : units?.map(unit => unit.id)
      ?? owners.filter(owner => owner.startsWith('formation:')).flatMap(owner => ctx.formations.membersOf(owner.slice(10)))
    if (ids?.length) await ctx.bridge.submit({ kind: 'stop', unitIds: ids })
    return { choices: [`${scope === 'all' ? '全部脚本' : owners.join('、') || '所选单位'} 已停止`], suppressOwners: owners }
  }
  if (action === 'pause') {
    for (const owner of owners) ctx.runtime.pause(owner)
    return { choices: [`${owners.join('、') || '全部脚本'} 已暂停`], suppressOwners: owners }
  }
  const refreshOwners: string[] = []
  for (const owner of owners) {
    const program = ctx.runtime.programs.get(owner)
    if (!program) continue
    const goals = program.goalIds.map(id => ctx.runtime.goals.get(id)).filter(goal => goal && goal.status !== 'cancelled' && goal.status !== 'completed')
    if (!goals.length) continue
    if (!program.script || program.compileError || goals.some(goal => JSON.stringify(goal!.spec) !== JSON.stringify(goal!.activeSpec))) refreshOwners.push(owner)
    else ctx.runtime.resume(owner)
  }
  return { choices: [`${owners.join('、') || '全部脚本'} 已恢复保留的目标`], refreshOwners }
}
function findGoal(context: BindingContext, token: string) {
  const { ctx } = context
  const goals = [...ctx.runtime.goals.values()].reverse().filter(goal => goal.status !== 'cancelled')
  const found = goals.find(goal => goal.spec.id === token)
    ?? goals.find(goal => goal.spec.label === token || goal.spec.rawText.includes(token) || (goal.spec.kind === 'production' && goal.spec.target.toLowerCase() === token.toLowerCase()))
  if (!found) throw new Error(`目标不存在：${token}`)
  return found
}

export const bindings: Binders = {
  'base.deploy': async (_params, context) => {
    const catalog = await context.catalog()
    const vehicle = context.ctx.runtime.snapshot!.self.filter(unit => unit.canDeploy && catalog.all.some(rule => rule.name === unit.name && rule.deploysInto && catalog.isRole(rule.deploysInto, 'constructionYard')))
      .sort((a, b) => Number(b.isIdle) - Number(a.isIdle) || a.id - b.id)[0]
    if (!vehicle) throw new Error('没有可展开的基地车')
    return bound({ id: id(), kind: 'deploy', rawText: context.text, unitIds: [vehicle.id], target: catalog.all.find(rule => rule.name === vehicle.name)!.deploysInto! }, `展开基地车 #${vehicle.id}`)
  },
  'production.produce': async (params, context) => {
    const rule = await catalogTarget(params.target, context)
    if (params.formationId && rule.type === 2) throw new Error('建筑不能编入部队编队')
    const goal: ProductionGoal = { id: id(), kind: 'production', rawText: context.text, target: rule.name, quantity: params.quantity, prerequisites: [], queues: params.queues, ...(params.formationId ? { formationId: formationName(context.ctx, params.formationId, true) } : {}) }
    return bound(goal, `生产${goal.quantity}个 ${rule.label ?? rule.name}（${rule.name}）${goal.formationId ? `，编入${goal.formationId}` : ''}`)
  },
  'production.power': async (params, context) => {
    const rule = (await context.catalog()).powerPlant()
    if (!rule) throw new Error('未找到可用电厂')
    return bound({ id: id(), kind: 'production', rawText: context.text, target: rule.name, quantity: 1, prerequisites: [], queues: [], maintainPower: { reserve: params.reserve, output: rule.power } }, `持续补电 ${rule.label ?? rule.name}（${rule.name}），保留${params.reserve}电量`)
  },
  'formation.create': async (params, context) => {
    const { ctx } = context
    const formationId = formationName(ctx, params.formationId, true)
    const matched = selectUnits(ctx, params, await context.catalog())
    const selected = params.unitIds || params.force ? matched : matched.filter(unit => !ctx.formations.ownerOf(unit.id))
    if (!selected.length) throw new Error('没有匹配的可编队单位')
    return bound({ id: id(), kind: 'formation', rawText: context.text, request: { kind: 'createFormation', formationId, unitIds: selected.map(unit => unit.id), force: !!params.force } }, `建立编队 ${formationId}，编入${selected.length}个现有单位`)
  },
  'formation.assign': async (params, context) => {
    const { ctx } = context
    const formationId = formationName(ctx, params.formationId, true)
    const matched = selectUnits(ctx, params, await context.catalog())
    const available = matched.filter(unit => ctx.formations.ownerOf(unit.id) !== formationId && (params.quantity === 'all' || !ctx.formations.ownerOf(unit.id)))
    const selected = params.quantity === 'all' ? available : available.slice(0, params.quantity)
    if (!selected.length) {
      if (matched.length && matched.every(unit => ctx.formations.ownerOf(unit.id) === formationId)) return done(`现有${matched.length}个匹配单位已在${formationId}`)
      throw new Error('没有可编入的现有单位，未追加生产')
    }
    const existing = context.formationGoals.get(formationId)
    const members = [...new Set([...(existing && existing.request.kind !== 'dissolveFormation' ? existing.request.unitIds : []), ...selected.map(unit => unit.id)])]
    const exists = ctx.formations.list().some(formation => formation.id === formationId)
    const goal: FormationGoal = { id: existing?.id ?? id(), kind: 'formation', rawText: context.text, request: exists
      ? { kind: 'transferUnits', formationId, unitIds: members }
      : { kind: 'createFormation', formationId, unitIds: members, force: members.some(unit => !!ctx.formations.ownerOf(unit)) } }
    const result = bound(goal, `将现有${members.length}个${!existing && params.selector === 'tanks' ? '坦克' : params.selector === 'combat' ? '战斗单位' : '匹配单位'}编入${formationId}（不新增生产）`)
    if (params.quantity !== 'all' && selected.length < params.quantity) result.skipped = [`现有未编队单位仅${selected.length}个，仍缺${params.quantity - selected.length}个；未追加生产`]
    return result
  },
  'formation.transfer': async (params, context) => {
    const formationId = formationName(context.ctx, params.formationId)
    const matched = selectUnits(context.ctx, params, await context.catalog()).filter(unit => context.ctx.formations.ownerOf(unit.id) !== formationId)
    const selected = params.quantity === 'all' ? matched : matched.slice(0, params.quantity)
    if (!selected.length) return done(`没有需要转入${formationId}的匹配单位`)
    const result = bound({ id: id(), kind: 'formation', rawText: context.text, request: { kind: 'transferUnits', formationId, unitIds: selected.map(unit => unit.id) } }, `将${selected.length}个现有单位转入${formationId}`)
    if (params.quantity !== 'all' && selected.length < params.quantity) result.skipped = [`来源单位仅${selected.length}个，未追加生产`]
    return result
  },
  'formation.dissolve': async (params, context) => {
    const formationId = formationName(context.ctx, params.formationId)
    return bound({ id: id(), kind: 'formation', rawText: context.text, request: { kind: 'dissolveFormation', formationId } }, `解散编队 ${formationId}`)
  },
  'combat.move': async (params, context) => {
    const formationId = formationName(context.ctx, params.formationId, false, true)
    const region = params.bounds ? rectangle(context.ctx.runtime.snapshot!, params.bounds) : fullMap(context.ctx.runtime.snapshot!)
    const point = params.regionName || params.x !== undefined || params.y !== undefined ? await destination(context.ctx, params, context.check, context.catalog) : undefined
    if (!point && !params.bounds) throw new Error('移动缺少目的地')
    const previous = point ? context.movementGoals.get(formationId) : undefined
    const route = previous?.destination && point ? [...(previous.route ?? [previous.destination]), point] : undefined
    const patrol = !!(params.patrol || previous?.patrol)
    const goal: CombatGoal = { id: previous?.id ?? id(), kind: 'combat', rawText: context.text, formationId, region,
      allowedActions: patrol ? ['move', 'gather', 'stop', 'attack', 'attackMove'] : ['move', 'gather', 'stop'],
      ...(point ? { destination: route?.[0] ?? point } : {}), ...(route ? { route } : {}), ...(patrol ? { patrol: true } : {}), ...(params.label ? { label: params.label } : {}) }
    const places = route ?? (point ? [point] : [])
    return bound(goal, `${formationId} ${patrol ? '沿路线巡逻' : route ? '按顺序前往' : '前往'}${places.length ? places.map(point => 'name' in point ? point.name : `(${point.x}, ${point.y})`).join(' → ') : '指定活动区'}`)
  },
  'combat.hold': async (params, context) => {
    const { ctx } = context
    const snap = ctx.runtime.snapshot!
    const formationId = formationName(ctx, params.formationId, false, true)
    let region = params.bounds ? rectangle(snap, params.bounds) : undefined
    let point: Awaited<ReturnType<typeof regionDestination>>['destination'] | undefined
    if (params.regionName) {
      const selected = await regionDestination(ctx, params.regionName, context.check)
      point = selected.destination
      const vertices = selected.region.polygons.flatMap(polygon => polygon.outer)
      region ??= rectangle(snap, [Math.max(0, Math.floor(Math.min(...vertices.map(p => p[0])))), Math.max(0, Math.floor(Math.min(...vertices.map(p => p[1])))), Math.min(snap.mapWidth - 1, Math.ceil(Math.max(...vertices.map(p => p[0])))), Math.min(snap.mapHeight - 1, Math.ceil(Math.max(...vertices.map(p => p[1]))))])
      region.name = selected.region.name
    }
    if (!region) {
      const members = snap.self.filter(unit => ctx.formations.membersOf(formationId).includes(unit.id))
      const x = members[0]?.rx ?? 0, y = members[0]?.ry ?? 0
      region = rectangle(snap, [Math.max(0, Math.floor(x - 8)), Math.max(0, Math.floor(y - 8)), Math.min(snap.mapWidth - 1, Math.ceil(x + 8)), Math.min(snap.mapHeight - 1, Math.ceil(y + 8))])
    }
    const goal: CombatGoal = { id: id(), kind: 'combat', rawText: context.text, formationId, region, mode: params.mode, allowedActions: params.mode === 'move' ? ['move', 'gather', 'stop'] : params.mode === 'assault' ? ['move', 'attack', 'attackMove', 'gather', 'stop'] : ['move', 'attack', 'stop'], ...(params.label ? { label: params.label } : {}), ...(point ? { destination: point } : {}) }
    if (params.retreatLoss !== undefined) {
      if (params.retreatX === undefined || params.retreatY === undefined) throw new Error('战损回撤缺少完整回撤点')
      checkPoint(snap, params.retreatX, params.retreatY)
      goal.retreat = { lossAbove: params.retreatLoss, x: params.retreatX, y: params.retreatY }
    } else if (params.retreatX !== undefined || params.retreatY !== undefined) throw new Error('回撤点缺少战损阈值')
    return bound(goal, `${formationId} ${params.mode === 'move' ? '赶路' : '守卫'}${region.name}`)
  },
  'combat.clear-region': async (params, context) => {
    const formationId = formationName(context.ctx, params.formationId, false, true)
    const { region, destination } = await regionDestination(context.ctx, params.regionName, context.check)
    return bound({ id: id(), kind: 'combat', rawText: context.text, formationId, region: fullMap(context.ctx.runtime.snapshot!), destination, attackRegion: { id: region.id, name: region.name, polygons: region.polygons }, allowedActions: ['move', 'attackMove', 'attack', 'stop'] }, `${formationId} 前往并清理${region.name}区域内的敌人`)
  },
  'combat.attack-all': async (params, context) => {
    const { ctx } = context
    const formationId = params.formationId ? formationName(ctx, params.formationId) : undefined
    const formations = ctx.formations.list().filter(formation => (!formationId || formation.id === formationId) && ctx.runtime.snapshot!.self.some(unit => formation.memberIds.includes(unit.id) && (unit.primaryWeapon || unit.secondaryWeapon)))
    if (!formations.length) throw new Error('没有可用作战编队')
    return { goals: formations.map(formation => ({ goal: { id: id(), kind: 'combat', rawText: context.text, formationId: formation.id, region: fullMap(ctx.runtime.snapshot!), allowedActions: ['move', 'attackMove', 'attack', 'stop'] }, choice: `编队 ${formation.id} 全图进攻` })) }
  },
  'management.reinforce': async (params, context) => {
    const target = await catalogTarget(params.target, context)
    const formationId = formationName(context.ctx, params.formationId)
    const source = params.sourceFormationId ? formationName(context.ctx, params.sourceFormationId) : null
    return bound({ id: id(), kind: 'reinforce', rawText: context.text, formationId, name: target.name, targetSize: params.targetSize, source }, `${formationId} 持续补充 ${target.label ?? target.name} 至${params.targetSize}个，来源${source ?? '未编队单位'}`)
  },
  'management.rally': async (params, context) => {
    const point = await destination(context.ctx, params, context.check, context.catalog)
    const matched = selectUnits(context.ctx, params, await context.catalog())
    const members = matched.filter(unit => !context.ctx.formations.ownerOf(unit.id))
    if (!members.length) throw new Error('没有可集结的未编队单位')
    return { ...bound({ id: id(), kind: 'rally', rawText: context.text, unitIds: members.map(unit => unit.id), x: point.x, y: point.y }, `将${members.length}个未编队单位集结到${'name' in point ? point.name : `(${point.x}, ${point.y})`}`), ...(members.length < matched.length ? { skipped: ['已编队成员继续原任务，仅集结未编队部分'] } : {}) }
  },
  'control.stop': (params, context) => control(params, context, 'stop'),
  'control.pause': (params, context) => control(params, context, 'pause'),
  'control.resume': (params, context) => control(params, context, 'resume'),
  'goal.cancel': async (params, context) => {
    const goal = findGoal(context, params.goalId)
    if (goal.status === 'completed') return done(`目标 ${goal.spec.id} 已完成，无需取消`)
    await context.ctx.runtime.cancelGoal(goal.spec.id)
    return { choices: [`目标 ${goal.spec.id} 已取消，其余目标继续`], refreshOwners: [goal.ownerId] }
  },
  'goal.edit': async (params, context) => {
    const goal = findGoal(context, params.goalId)
    if (goal.spec.kind !== 'production' || goal.spec.maintainPower) throw new Error('只支持修改固定数量的生产目标')
    return bound({ ...goal.spec, quantity: params.quantity, rawText: context.text }, `将目标 ${goal.spec.id} 的 ${goal.spec.target} 总量改为${params.quantity}，保留已提交进度`)
  },
}
