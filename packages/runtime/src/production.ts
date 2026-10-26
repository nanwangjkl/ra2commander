import type { SnapshotUnit } from '@ra2c/contracts'

/** 规则查询的最小面（由桥实现；避免 runtime 直接依赖 Playwright）。 */
export interface RulesLookup {
  /** 返回 rules().prerequisite（不存在为 undefined）。 */
  prerequisites(name: string): Promise<string[] | undefined>
  /** 当前可造项目名（production.available()；目标在列即前置已被引擎确认满足）。 */
  available(): Promise<string[]>
  /** 当前游戏目录提供的类别候选，已按本局阵营排序。 */
  categories?: Record<string, string[]>
  restriction?: (name: string) => Promise<{ reason: string; requiresExisting?: boolean } | undefined>
}

export interface PrerequisiteClosure {
  /** 需要新建的项目，拓扑序（被依赖者在前）。 */
  toBuild: string[]
  /** 目标本身（最后一步）。 */
  target: string
  /** 无法查询到规则的项目（报告，不擅自处理）。 */
  unknown: string[]
  blocked: Array<{ name: string; reason: string; requiresExisting?: boolean }>
}

/**
 * 必要前置闭包（固定程序，模型不参与）：
 * 从目标出发递归取 rules().prerequisite，跳过战场上已有的同名建筑。
 * 只包含真正必需的项——"低电想补电厂提速"这类非必要项不在闭包内，
 * 越权生产由执行器按 allowedProduce 名单拒绝。
 */
export async function computePrerequisiteClosure(
  target: string,
  lookup: RulesLookup,
  ownBuildings: SnapshotUnit[],
): Promise<PrerequisiteClosure> {
  const existing = new Set(ownBuildings.filter((u) => u.type === 2).map((u) => u.name))
  const available = new Set(await lookup.available().catch(() => []))
  type Plan = { order: string[]; unknown: string[]; blocked: PrerequisiteClosure['blocked'] }
  const empty = (): Plan => ({ order: [], unknown: [], blocked: [] })
  const memo = new Map<string, Plan>()
  const visit = async (name: string, path: string[]): Promise<Plan> => {
    if (existing.has(name) && name !== target) return empty()
    if (path.includes(name)) return { ...empty(), blocked: [{ name, reason: `前置存在循环：${[...path, name].join(' → ')}` }] }
    if (available.has(name)) return { ...empty(), order: [name] }
    const cached = memo.get(name)
    if (cached) return cached
    const restriction = await lookup.restriction?.(name)
    if (restriction) return { ...empty(), blocked: [{ name, ...restriction }] }
    const deps = await lookup.prerequisites(name)
    if (deps === undefined) return { ...empty(), unknown: [name] }
    const plan = empty()
    for (const dep of deps.filter(Boolean)) {
      const candidates = lookup.categories?.[dep.toUpperCase()] ?? [dep]
      if (candidates.some(candidate => existing.has(candidate))) continue
      const buildable = candidates.find(candidate => available.has(candidate))
      let best: Plan | undefined
      for (const candidate of buildable ? [buildable] : candidates) {
        const trial = await visit(candidate, [...path, name])
        if (!best || trial.unknown.length + trial.blocked.length < best.unknown.length + best.blocked.length) best = trial
        if (!trial.unknown.length && !trial.blocked.length) break
      }
      if (!best) { plan.unknown.push(dep); continue }
      plan.order.push(...best.order); plan.unknown.push(...best.unknown); plan.blocked.push(...best.blocked)
    }
    plan.order = [...new Set([...plan.order, name])]
    if (!plan.unknown.length && !plan.blocked.length) memo.set(name, plan)
    return plan
  }
  const plan = await visit(target, [])
  return { toBuild: plan.order.filter(name => name !== target), target, unknown: [...new Set(plan.unknown)], blocked: [...new Map(plan.blocked.map(condition => [condition.name, condition])).values()] }
}
