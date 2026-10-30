import { attackObjective, crushCompatible, goalExecutionMode, inTargetRegion, validateScriptActions, type ActionContext, type ActionRequest, type ActionResult, type CrushingRules, type GoalSpec, type ScriptAction, type Snapshot, type StepConstraints } from '@ra2c/contracts'
import { emptyCoverMotion, coverMoves, type CoverMotion } from './cover.ts'
import { coverCombat, coverRangePairs, type CoverIntent, type CoverRange } from './cover-combat.ts'
import { emptyUnitOrders, recordUnitOrder, type UnitOrderState } from './unit-orders.ts'
import { emptyCrushing, planCrushing, type CrushPair } from './crushing.ts'
import type { FormationRegistry } from './formation.ts'
import type { GoalProjection } from './goals/types.ts'
import type { GoalState, ProgramState, StepBudget } from './state.ts'

interface CombatDeps {
  formations: FormationRegistry
  goals: ReadonlyMap<string, GoalState>
  programs: ReadonlyMap<string, ProgramState>
  snapshot(): Snapshot | undefined
  locked(id: number): boolean
  project(spec: GoalSpec, snap: Snapshot): GoalProjection
  frame(spec: GoalSpec, snap: Snapshot): { snapshot: Snapshot; constraints: StepConstraints }
  submit(actions: ActionRequest[], context: ActionContext, guard: () => boolean): Promise<ActionResult[]>
  coverRanges?: (pairs: Array<{ unitId: number; targetId: number }>, snap: Snapshot) => Promise<CoverRange[]>
  crushing?: CrushingRules
}

/** 掩护规划与攻击到碾压的转换；活动目标动作仍交回统一提交入口。 */
export class CombatCoordinator {
  private readonly idleOrders = new Map<string, { motion: CoverMotion; orders: UnitOrderState }>()
  constructor(private readonly deps: CombatDeps) {}
  clearIdle(formationId?: string): void { if (formationId === undefined) this.idleOrders.clear(); else this.idleOrders.delete(formationId) }
  async standby(program: ProgramState, snap: Snapshot): Promise<void> {
    if (program.owner.kind !== 'formation') return
    const formationId = program.owner.formationId, policy = this.deps.formations.coverOf(formationId), revision = this.deps.formations.revision, generation = program.generation
    if (!policy || this.deps.formations.membersOf(formationId).some(id => this.deps.locked(id))) return
    const ids = this.deps.formations.membersOf(formationId), previous = this.idleOrders.get(formationId) ?? { motion: emptyCoverMotion(), orders: emptyUnitOrders() }
    if (snap.self.some(unit => ids.includes(unit.id) && unit.isDeployed)) return
    const intent: CoverIntent = { targets: [], threats: snap.enemies, region: { name: '掩护待命', x1: 0, y1: 0, x2: snap.mapWidth - 1, y2: snap.mapHeight - 1 }, waiting: false }
    const ranges = await this.deps.coverRanges?.(coverRangePairs(policy, snap, ids, intent, previous.orders), snap).catch(() => []) ?? []
    const plan = coverCombat(policy, snap, ids, intent, previous.motion, ranges, previous.orders)
    const guard = () => this.deps.snapshot() === snap && this.deps.snapshot()?.sessionKey === snap.sessionKey && program.status === 'idle' && program.generation === generation && this.deps.formations.revision === revision && this.deps.formations.coverOf(formationId) === policy
    if (!guard()) return
    this.idleOrders.set(formationId, { motion: plan.state, orders: previous.orders })
    for (const request of plan.actions.slice(0, 20)) {
      const results = await this.deps.submit([request], snap, guard)
      if (!guard()) return
      recordUnitOrder(previous.orders, request, snap.tick, results)
    }
  }

  async coverActions(spec: GoalSpec, snap: Snapshot): Promise<ActionRequest[] | undefined> {
    if ((spec.kind !== 'combat' && spec.kind !== 'attack') || !spec.formationId) return undefined
    const policy = this.deps.formations.coverOf(spec.formationId)
    if (!policy) return undefined
    const goal = this.deps.goals.get(spec.id)!, projected = this.deps.project(spec, snap), ids = projected.constraints.allowedUnitIds
    // 持续守卫无匹配目标时全队原地待命，不由掩护流程追加站位移动。
    if (spec.kind === 'combat' && (spec.baseDefense || spec.objective && (spec.mode === 'hold' || spec.mode === 'assault')) && !projected.constraints.enemyIds.length) return undefined
    const previous = goal.facts.coverMotion ?? emptyCoverMotion(), orders = goal.facts.unitOrders ??= emptyUnitOrders()
    if (spec.kind === 'combat' && goal.facts.retreatTriggered && spec.retreat) {
      const plan = coverMoves(policy, snap, ids, spec.retreat, previous, orders, { directDestination: true })
      goal.facts.coverMotion = plan.state
      return plan.actions
    }
    const targetRegion = projected.constraints.targetRegion ?? attackObjective(spec)?.target.region
    const threats = snap.enemies.filter(unit => !targetRegion || inTargetRegion(unit.rx, unit.ry, targetRegion))
    let targets = snap.enemies.filter(unit => projected.constraints.enemyIds.includes(unit.id))
    if (spec.kind === 'combat' && !spec.allowedActions.includes('attack')) targets = []
    if (spec.kind === 'combat' && spec.patrol) targets = targets.filter(target => snap.self.some(unit => ids.includes(unit.id) && Math.hypot(unit.rx - target.rx, unit.ry - target.ry) <= Math.max(unit.primaryWeapon?.maxRange ?? 0, unit.secondaryWeapon?.maxRange ?? 0) + policy.gap))
    const intent: CoverIntent = {
      targets, threats, region: projected.constraints.region!,
      destination: spec.kind === 'combat' ? spec.route?.[goal.facts.routeIndex ?? 0] ?? spec.destination : attackObjective(spec)?.search.destination,
      waiting: !policy.escortIds.some(id => snap.self.some(unit => unit.id === id)) && (policy.escortSources ?? []).some(source => ['pending', 'active'].includes(this.deps.goals.get(source.goalId)?.status ?? '')),
    }
    const ranges = await this.deps.coverRanges?.(coverRangePairs(policy, snap, ids, intent, orders), snap).catch(() => []) ?? []
    const plan = coverCombat(policy, snap, ids, intent, previous, ranges, orders)
    if (this.deps.snapshot() === snap && this.deps.formations.coverOf(spec.formationId) === policy) goal.facts.coverMotion = plan.state
    return plan.actions
  }

  prepareCrushing(specs: GoalSpec[], snap: Snapshot, actions: ScriptAction[], mode: 'script' | 'native', budget: StepBudget, goalIds: string[]) {
    const derived = new Set<ActionRequest>(), replacements = new Map<string, ScriptAction[]>()
    if (!this.deps.crushing) return { actions, derived }
    for (const spec of specs) {
      if ((spec.kind !== 'combat' && spec.kind !== 'attack') || !goalIds.includes(spec.id) || goalExecutionMode(spec) !== mode || budget.crushingPrepared.has(spec.id)) continue
      const goal = this.deps.goals.get(spec.id)!, incoming = actions.filter(item => item.goalId === spec.id)
      if (goal.facts.nativeError || !incoming.length && !Object.keys(goal.facts.crushing?.pairs ?? {}).length) continue
      const frame = this.deps.frame(spec, snap), constraints = frame.constraints.goals![spec.id]!
      if (!constraints.allowedActions?.includes('attack') || goal.facts.retreatTriggered) continue
      budget.crushingPrepared.add(spec.id)
      // 非法原始请求留给既有错误处理，不能借转换绕过脚本校验。
      const valid = incoming.filter((item): item is ScriptAction & { request: ActionRequest } => !['createFormation', 'transferUnits', 'dissolveFormation'].includes(item.request.kind) && !validateScriptActions([item], frame.constraints, frame.snapshot))
      const state = goal.facts.crushing ??= emptyCrushing(), orders = goal.facts.unitOrders ??= emptyUnitOrders()
      const ids = constraints.allowedUnitIds, policy = spec.formationId ? this.deps.formations.coverOf(spec.formationId) : undefined
      const motion = policy ? goal.facts.coverMotion ??= emptyCoverMotion() : undefined
      const targets = snap.enemies.filter(target => constraints.enemyIds.includes(target.id) || constraints.coverFire?.enemyIds.includes(target.id))
      const members = snap.self.filter(unit => ids.includes(unit.id)), body = members.filter(unit => !policy?.escortIds.includes(unit.id))
      const guide = members.find(unit => unit.id === motion?.prediction?.guideId) ?? members.slice().sort((a, b) => (a.speed ?? 0) - (b.speed ?? 0) || a.id - b.id)[0]
      const distance = (a: { rx: number; ry: number }, b: { rx: number; ry: number }) => Math.hypot(a.rx - b.rx, a.ry - b.ry)
      let following: ActionRequest[] | undefined
      const claims: CrushPair[] = []
      for (const other of this.deps.goals.values()) {
        const owner = this.deps.programs.get(other.ownerId), active = other.activeSpec
        if (other === goal || !Object.keys(other.facts.crushing?.pairs ?? {}).length || other.status !== 'active' || !active || !owner || owner.status !== 'active' || !owner.activeGoalIds.includes(active.id) || other.facts.nativeError || other.facts.retreatTriggered) continue
        const scope = this.deps.project(active, snap).constraints
        for (const pair of Object.values(other.facts.crushing?.pairs ?? {})) {
          const enemy = snap.enemies.find(unit => unit.id === pair.targetId), attacker = snap.self.find(unit => unit.id === pair.unitId)
          if (pair.phase === 'crushing' && scope.allowedUnitIds.includes(pair.unitId) && attacker && enemy && crushCompatible(attacker, enemy, this.deps.crushing) && (scope.enemyIds.includes(enemy.id) || scope.coverFire?.enemyIds.includes(enemy.id))) claims.push({ ...pair, point: { x: enemy.rx, y: enemy.ry, onBridge: !!enemy.onBridge } })
        }
      }
      const requests = planCrushing({ snap, rules: this.deps.crushing, state, unitIds: ids, targets, requests: valid.map(item => item.request), orders: orders.orders, claims, focus: attackObjective(spec)?.coordination === 'focus',
        escort: id => !!policy?.escortIds.includes(id),
        canPursue: (unit, target) => {
          const escort = !!policy?.escortIds.includes(unit.id)
          if (!escort && !constraints.enemyIds.includes(target.id)) return false
          if (!policy) return true
          if (motion!.heldIds.includes(unit.id) || motion!.cohesion?.catchingUpIds.includes(unit.id)) return false
          if (!escort) return unit.id === guide?.id || !!guide && distance(target, guide) <= policy.gap && distance(unit, guide) <= policy.gap * 2
          const near = body.slice().sort((a, b) => distance(unit, a) - distance(unit, b))[0]
          const followed = body.some(member => state.pairs[member.id]?.targetId === target.id || valid.some(item => item.request.kind === 'attack' && item.request.unitIds.includes(member.id) && item.request.targetId === target.id) || ['attack', 'crush'].includes(orders.orders[member.id]?.kind ?? '') && orders.orders[member.id]?.targetId === target.id)
          return !!near && followed && distance(unit, near) <= policy.gap && body.some(member => distance(target, member) <= policy.gap)
        },
        follow: unit => {
          if (!policy) return
          const destination = targets.slice().sort((a, b) => guide ? distance(guide, a) - distance(guide, b) : a.id - b.id)[0]
          if (!destination) return
          following ??= coverMoves(policy, snap, ids, { x: destination.rx, y: destination.ry }, motion!, orders, { ...(constraints.region ? { region: constraints.region } : {}), threat: destination }).actions
          const request = following.find(request => 'unitIds' in request && request.unitIds.includes(unit.id))
          return request && 'unitIds' in request ? { ...request, unitIds: [unit.id] } : undefined
        },
      })
      for (const request of requests) if (request.kind === 'crush') derived.add(request)
      const accepted = new Set<ScriptAction>(valid)
      replacements.set(spec.id, [...requests.map(request => ({ goalId: spec.id, request })), ...incoming.filter(item => !accepted.has(item))])
    }
    const emitted = new Set<string>(), result: ScriptAction[] = []
    for (const item of actions) {
      const replacement = replacements.get(item.goalId)
      if (!replacement) result.push(item)
      else if (!emitted.has(item.goalId)) { result.push(...replacement); emitted.add(item.goalId) }
    }
    for (const [id, replacement] of replacements) if (!emitted.has(id)) result.push(...replacement)
    return { actions: result, derived }
  }

}
