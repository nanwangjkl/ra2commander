import { randomUUID } from 'node:crypto'
import type { RepairGoal, GoalSpec } from '@ra2c/contracts'
import type { ResolvedCapabilityParameters, SkillDocument, RepairSkillDefinition } from '@ra2c/command'
import type { BindingContext, BoundCapability } from './bindings.ts'
import { formationName, isRepairVehicle, type GameCatalog } from './selectors.ts'
import { fixedGoalExecutionMode } from '../execution-modes.ts'

const id = () => `command-${randomUUID().slice(0, 8)}`
export function repairGoal(context: BindingContext, catalog: GameCatalog, formationId: string, preparationGoalIds: string[], options: { quantity?: number; targetId?: number; followFormationId?: string } = {}): RepairGoal {
  const names = (role: string) => [...new Set([...catalog.all.filter(item => catalog.isRole(item.name, role, item.type)).map(item => item.name), ...context.game.roles().filter(item => item.id === role).flatMap(item => item.members.map(member => member.name))])]
  return { id: id(), kind: 'repair', executionMode: fixedGoalExecutionMode('repair'), rawText: context.text, formationId, preparationGoalIds,
    vehicleNames: names('infantryFightingVehicle'), engineerNames: names('engineer'), tankNames: names('tank'),
    policy: context.prompts.skills.get('repair-vehicle')!.definition.repair, ...options }
}

export async function bindRepairSkill(params: ResolvedCapabilityParameters['skill.run'], context: BindingContext, skill: SkillDocument<RepairSkillDefinition>): Promise<BoundCapability> {
  const { ctx, prompts } = context, values = prompts.skills.parameters(skill.definition.id, params)
  const runId = `skill-${randomUUID()}`
  const formationId = params.formationId ? formationName(ctx, params.formationId, true) : `维修-${runId.slice(6, 12)}`
  const followFormationId = params.followFormationId ? formationName(ctx, params.followFormationId) : undefined
  if (followFormationId === formationId) throw new Error('维修队与被支援队不能相同')
  const catalog = await context.catalog(); context.check()
  const [vehicleRole, engineerRole] = skill.definition.steps
  const vehicle = catalog.resolve(vehicleRole.role), engineer = catalog.resolve(engineerRole.role)
  if (!vehicle || !engineer) throw new Error('当前规则未找到维修车所需的 IFV 或工程师')
  const available = ctx.runtime.snapshot!.self.filter(unit => !ctx.formations.ownerOf(unit.id) || ctx.formations.ownerOf(unit.id) === formationId)
  const loadedIds = new Set(ctx.runtime.snapshot!.self.flatMap(unit => unit.transport?.unitIds ?? []))
  let vehicles = values.memberSource === 'new' ? [] : available.filter(unit => catalog.isRole(unit.name, vehicleRole.role, unit.type) && unit.transport && (unit.transport.occupied === 0 || isRepairVehicle(unit, ctx, catalog))).sort((a, b) => b.transport!.occupied - a.transport!.occupied || a.id - b.id).slice(0, values.quantity)
  let loaded = vehicles.filter(unit => unit.transport!.occupied > 0).length
  const engineers = values.memberSource === 'new' ? [] : available.filter(unit => catalog.isRole(unit.name, engineerRole.role, unit.type) && !loadedIds.has(unit.id)).slice(0, values.quantity - loaded)
  const quantity = values.memberSource === 'existing' ? Math.min(vehicles.length, loaded + engineers.length) : values.quantity
  if (!quantity) throw new Error('没有可组装的现有组件，未追加生产')
  vehicles = vehicles.slice(0, quantity); loaded = vehicles.filter(unit => unit.transport!.occupied > 0).length
  const selected = [...vehicles, ...engineers.slice(0, quantity - loaded)].filter(unit => ctx.formations.ownerOf(unit.id) !== formationId)
  const reference = { runId, id: skill.definition.id, version: skill.definition.version, hash: skill.hash, instructions: skill.instructions }
  const goals: NonNullable<BoundCapability['goals']> = []
  if (selected.length) {
    const exists = ctx.formations.list().some(formation => formation.id === formationId)
    const request = { kind: exists ? 'transferUnits' as const : 'createFormation' as const, formationId, unitIds: selected.map(unit => unit.id) }
    goals.push({ goal: { id: id(), kind: 'formation', executionMode: fixedGoalExecutionMode('repair'), rawText: context.text, skill: reference, request }, choice: `将${selected.length}个现有组件编入${formationId}` })
  }
  const addProduction = (target: string, count: number, label: string) => {
    if (count <= 0) return
    const goal: GoalSpec = { id: id(), kind: 'production', rawText: context.text, skill: reference, target, quantity: count, prerequisites: [], queues: [], formationId }
    goals.push({ goal, choice: `新造${count}${label}（${target}），编入${formationId}` })
  }
  if (values.memberSource !== 'existing') {
    addProduction(vehicle.name, quantity - vehicles.length, '辆IFV')
    addProduction(engineer.name, quantity - loaded - engineers.length, '名工程师')
  }
  const preparationGoalIds = goals.map(item => item.goal.id)
  const repair = { ...repairGoal(context, catalog, formationId, preparationGoalIds, { quantity, ...(followFormationId ? { followFormationId } : {}) }), skill: reference, policy: structuredClone(skill.definition.repair) }
  goals.push({ goal: repair, choice: `${formationId} 组装${quantity}辆维修车并持续维修${followFormationId ? `${followFormationId}的` : '己方全部'}受损坦克，多车分头并行` })
  return { goals, ...(quantity < values.quantity ? { skipped: [`现有组件仅能组装${quantity}辆，未追加生产`] } : {}),
    skillRun: { kind: 'repair-vehicle', id: runId, skillId: skill.definition.id, version: skill.definition.version, hash: skill.hash, source: skill.source, promptVersion: prompts.version, gameId: prompts.game.id, commandId: context.commandId, rawText: context.text, sessionKey: ctx.runtime.battleKey, createdAt: Date.now(), ...values, quantity, useExisting: values.memberSource !== 'new', formationId, preparationGoalIds, repairGoalId: repair.id, status: 'preparing' } }
}
