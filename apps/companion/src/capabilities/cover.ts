import { randomUUID } from 'node:crypto'
import type { ResolvedCapabilityParameters } from '@ra2c/command'
import type { CoverPolicy, FormationGoal, ProductionGoal, SnapshotUnit } from '@ra2c/contracts'
import type { BindingContext, BoundCapability } from './bindings.ts'
import { formationName, selectUnitSet } from './selectors.ts'
import { matchesFutureMember } from '../unit-selection.ts'

export async function bindCover(params: ResolvedCapabilityParameters['formation.cover'], context: BindingContext): Promise<BoundCapability> {
  const { ctx } = context, catalog = await context.catalog(); context.check()
  const formationId = formationName(ctx, params.formationId, true), existing = ctx.formations.membersOf(formationId)
  const exists = ctx.formations.list().some(formation => formation.id === formationId)
  const planned = context.formationGoals.get(formationId)
  const plannedIds = planned && planned.request.kind !== 'dissolveFormation' ? planned.request.unitIds : []
  const priorRun = [...ctx.runtime.skillRuns.values()].reverse().find(run => run.kind === 'cover' && run.formationId === formationId && ['preparing', 'covering'].includes(run.status))
  const previous = ctx.formations.coverOf(formationId) ?? (priorRun?.kind === 'cover' ? priorRun.cover : undefined)
  const ground = (unit: SnapshotUnit) => [3, 7].includes(unit.type) && unit.zone !== 1 && unit.zone !== 2 && (!ctx.formations.ownerOf(unit.id) || ctx.formations.ownerOf(unit.id) === formationId)
  const matches = (name: string, selector: string) => catalog.all.some(item => item.name === name && [3, 7].includes(item.type) && matchesFutureMember(item, selector, catalog))
  const current = context.productionGoals?.get(formationId) ?? []
  const pending = [...new Map([...current, ...[...ctx.runtime.goals.values()].flatMap(goal => goal.spec.kind === 'production' && goal.spec.formationId === formationId && ['pending', 'active'].includes(goal.status) ? [goal.spec] : [])].map(goal => [goal.id, goal])).values()]
  const protectedSelection = params.protectedSelector || params.protectedUnitIds ? selectUnitSet(ctx, {
    selector: params.protectedSelector ?? 'all', quantity: params.protectedQuantity ?? 'all', ...(params.protectedUnitIds ? { unitIds: params.protectedUnitIds } : {}),
  }, catalog, context.game, { eligible: ground }).selected : []
  const protectedSet = new Set(protectedSelection.map(unit => unit.id))
  const selected = params.memberSource === 'new' && !params.unitIds ? [] : selectUnitSet(ctx, { selector: params.selector, quantity: params.quantity, ...(params.unitIds ? { unitIds: params.unitIds } : {}) }, catalog, context.game,
    { eligible: unit => ground(unit) && !protectedSet.has(unit.id) }).selected
  const escorts = selected.filter(unit => !previous?.escortIds.includes(unit.id))
  const skill = context.prompts.skills.get('cover')!, runId = `skill-${randomUUID()}`
  const reference = { runId, id: 'cover', version: skill.definition.version, hash: skill.hash, instructions: skill.instructions }
  const goals: NonNullable<BoundCapability['goals']> = [], owned = new Set(priorRun?.kind === 'cover' ? priorRun.ownedPreparationGoalIds ?? [] : [])
  const escortSources = [...(previous?.escortSources ?? [])]
  let remaining = params.quantity === 'all' ? Infinity : Math.max(0, params.quantity - selected.length)
  const observed = (goalId: string) => [...new Set(ctx.runtime.production.filter(record => record.goalId === goalId).flatMap(record => record.observedIds))]
  if (params.memberSource !== 'new') for (const source of escortSources) remaining = Math.max(0, remaining - Math.max(0, source.quantity - observed(source.goalId).length))
  for (const source of params.unitIds ? [] : (params.memberSource === 'new' ? current : pending)) {
    if (!matches(source.target, params.selector) || escortSources.some(item => item.goalId === source.id) || remaining <= 0) continue
    const alreadySelected = selected.filter(unit => observed(source.id).includes(unit.id)).length
    const quantity = Math.min(source.quantity, remaining + alreadySelected)
    escortSources.push({ goalId: source.id, quantity }); remaining -= quantity - alreadySelected
  }
  const unboundedReady = params.memberSource === 'new' ? escortSources.some(source => current.some(goal => goal.id === source.goalId)) : selected.length > 0 || escortSources.length > 0
  if (remaining > 0 && !params.unitIds && ['new', 'auto'].includes(params.memberSource) && (params.quantity !== 'all' || !unboundedReady)) {
    const rule = catalog.resolve(params.selector, { mobile: true })
    if (!rule || ![3, 7].includes(rule.type)) throw new Error('未找到可生产的地面掩护单位')
    const quantity = Number.isFinite(remaining) ? remaining : 1
    const goal: ProductionGoal = { id: `command-${randomUUID().slice(0, 8)}`, kind: 'production', rawText: context.text, skill: reference, target: rule.name, quantity, targetType: rule.type, prerequisites: [], queues: [], formationId }
    goals.push({ goal, choice: `新造${quantity}个${rule.label ?? rule.name}（${rule.name}），编入${formationId}并承担掩护` })
    escortSources.push({ goalId: goal.id, quantity }); owned.add(goal.id); remaining = 0
  }
  const escortIds = [...new Set([...(previous?.escortIds ?? []), ...escorts.map(unit => unit.id)])]
  if (!escortIds.length && !escortSources.length) throw new Error('掩护未启用：没有匹配的现有或明确待生产地面掩护成员；未追加生产')
  const protectedSources = pending.filter(source => source.quantity > (escortSources.find(item => item.goalId === source.id)?.quantity ?? 0) && (!params.protectedSelector || matches(source.target, params.protectedSelector)))
  const all = [...new Set([...existing, ...plannedIds, ...protectedSet, ...escortIds])]
  if (!all.some(id => !escortIds.includes(id)) && !protectedSources.length) throw new Error('请指定被掩护成员，或先建立需要掩护的编队')
  const policy: CoverPolicy = { ...skill.definition.cover, runId, version: skill.definition.version, escortIds, ...(escortSources.length ? { escortSources } : {}), protectedSources: [...new Set([...(previous?.protectedSources ?? []), ...protectedSources.map(goal => goal.id)])] }
  const preparationIds = new Set([...escortSources.map(item => item.goalId), ...(policy.protectedSources ?? []), ...owned])
  const added = all.filter(id => !existing.includes(id))
  if (added.length || planned) {
    const goal: FormationGoal = { id: planned?.id ?? `command-${randomUUID().slice(0, 8)}`, kind: 'formation', rawText: context.text,
      executionMode: planned ? planned.executionMode ?? 'script' : 'native', skill: reference, cover: policy,
      request: exists ? { kind: 'transferUnits', formationId, unitIds: [...new Set([...plannedIds, ...added])] } : { kind: 'createFormation', formationId, unitIds: all } }
    preparationIds.add(goal.id); owned.add(goal.id)
    goals.push({ goal, choice: `${all.length}个现有单位同属${formationId}，安排${escortIds.length}个现有成员掩护；后续本次产物交接后按角色加入` })
  } else if (exists) ctx.runtime.setCover(formationId, policy)
  const choices = [`${formationId}：掩护要求已保存，现有掩护${escortIds.length}、待产掩护${escortSources.reduce((n, item) => n + item.quantity, 0)}；按全队最慢成员协同行动`]
  const skipped = params.quantity !== 'all' && remaining > 0 ? [`掩护成员仍缺${remaining}个，先使用可用成员，未追加生产`] : []
  const quantity = escortIds.length + escortSources.reduce((n, item) => n + item.quantity - observed(item.goalId).slice(0, item.quantity).filter(id => escortIds.includes(id)).length, 0)
  return { goals, choices, skipped, skillRun: { kind: 'cover', id: runId, skillId: 'cover', version: skill.definition.version, hash: skill.hash, source: skill.source,
    promptVersion: context.prompts.version, gameId: context.prompts.game.id, commandId: context.commandId, rawText: context.text, sessionKey: ctx.runtime.battleKey,
    createdAt: Date.now(), quantity, useExisting: !goals.some(item => item.goal.kind === 'production'), memberSource: params.memberSource,
    formationId, preparationGoalIds: [...preparationIds], ownedPreparationGoalIds: [...owned], escortIds, cover: policy, status: exists ? 'covering' : 'preparing' } }
}
