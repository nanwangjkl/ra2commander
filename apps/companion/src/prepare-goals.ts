import type { GoalSpec, Snapshot } from '@ra2c/contracts'
import { computePrerequisiteClosure } from '@ra2c/runtime'
import { loadPrompts, type GameProfile } from '@ra2c/command'
import { createRuleLookup, type RuleQuery } from './game-rules.ts'

/** 查询当前对局的真实规则；目录只提供角色、类别与类型提示。 */
export async function prepareGoals(goals: GoalSpec[], snap: Snapshot, rules: RuleQuery, signal: AbortSignal, profile: GameProfile = loadPrompts().game): Promise<GoalSpec[]> {
  const lookup = createRuleLookup(rules, () => signal.throwIfAborted(), profile, new Map(snap.self.map(unit => [unit.name, unit.type])))
  const result: GoalSpec[] = []
  for (const goal of goals) {
    signal.throwIfAborted()
    if (goal.kind === 'production') {
      const closure = await computePrerequisiteClosure(goal.target, { prerequisites: async name => (await lookup(name))?.rule.prerequisite, available: async () => snap.production?.available ?? [], categories: profile.categories(snap.self) }, snap.self)
      if (closure.unknown.length) throw new Error(`规则查询失败：${closure.unknown.join(',')}`)
      const target = await lookup(goal.target)
      if (!target || !Array.isArray(target.rule.prerequisite)) throw new Error(`目标规则不可读取：${goal.target}`)
      const queueTypes: Record<string, number> = {}
      const powerCosts: Record<string, number> = {}
      for (const name of [...closure.toBuild, goal.target]) {
        const found = name === goal.target ? target : await lookup(name)
        if (!found) throw new Error(`前置规则不可读取：${name}`)
        queueTypes[name] = found.type === 2 ? found.rule.buildCat === 0 ? 1 : 0 : found.type === 3 ? 2 : found.type === 1 ? 4 : found.rule.naval ? 5 : 3
        powerCosts[name] = found.rule.power ?? 0
      }
      result.push({ ...goal, prerequisites: closure.toBuild, targetType: target.type, queueTypes, powerCosts,
        ...(goal.maintainPower ? { maintainPower: { reserve: goal.maintainPower.reserve, output: target.rule.power ?? 0 } } : {}) })
    } else if (goal.kind === 'combat') {
      const transforms = { ...goal.transforms }
      for (const name of new Set(snap.self.filter(u => u.type !== 2).map(u => u.name))) {
        const found = await lookup(name)
        const into = found?.rule.deploysInto ?? found?.rule.undeploysInto
        if (into) { transforms[name] = into; transforms[into] = name }
      }
      result.push({ ...goal, transforms })
    } else result.push(goal)
  }
  const powerCosts = Object.assign({}, ...result.filter(g => g.kind === 'production').map(g => g.powerCosts)) as Record<string, number>
  return result.map(goal => goal.kind === 'production' && goal.maintainPower ? { ...goal, powerCosts } : goal)
}
