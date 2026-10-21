import type { GoalSpec, Snapshot } from '@ra2c/contracts'
import { computePrerequisiteClosure } from '@ra2c/runtime'

interface Rule { prerequisite?: string[]; deploysInto?: string; undeploysInto?: string; buildCat?: number; naval?: boolean; power?: number }
/** 查询固定公共规则；所有异步步骤均绑定当前编译请求的取消信号。 */
export async function prepareGoals(goals: GoalSpec[], snap: Snapshot, rules: (name: string, type: number) => Promise<unknown>, signal: AbortSignal): Promise<GoalSpec[]> {
  const lookup = async (name: string): Promise<{ rule: Rule; type: number } | undefined> => {
    for (const type of [2, 7, 3, 1]) {
      signal.throwIfAborted()
      let result: Rule | undefined
      try { result = await rules(name, type) as Rule | undefined } catch { continue }
      signal.throwIfAborted()
      if (result && Array.isArray(result.prerequisite)) return { rule: result, type }
    }
    return undefined
  }
  const result: GoalSpec[] = []
  for (const goal of goals) {
    signal.throwIfAborted()
    if (goal.kind === 'production') {
      const closure = await computePrerequisiteClosure(goal.target, { prerequisites: async name => (await lookup(name))?.rule.prerequisite, available: async () => snap.production?.available ?? [] }, snap.self)
      if (closure.unknown.length) throw new Error(`规则查询失败：${closure.unknown.join(',')}`)
      const target = await lookup(goal.target)
      if (!target) throw new Error(`目标规则不可读取：${goal.target}`)
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
