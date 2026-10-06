import type { SnapshotUnit } from '@ra2c/contracts'

/** 规则查询的最小面（由桥实现；避免 runtime 直接依赖 Playwright）。 */
export interface RulesLookup {
  /** 返回 rules().prerequisite（不存在为 undefined）。 */
  prerequisites(name: string): Promise<string[] | undefined>
}

export interface PrerequisiteClosure {
  /** 需要新建的项目，拓扑序（被依赖者在前）。 */
  toBuild: string[]
  /** 目标本身（最后一步）。 */
  target: string
  /** 无法查询到规则的项目（报告，不擅自处理）。 */
  unknown: string[]
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
  const unknown: string[] = []
  const visited = new Set<string>()
  // 拓扑序输出：依赖先于依赖者。
  const order: string[] = []

  const visit = async (name: string, path: string[]): Promise<void> => {
    if (visited.has(name) || existing.has(name)) return
    if (path.includes(name)) return // 循环前置保护
    const prereqs = await lookup.prerequisites(name)
    if (prereqs === undefined) {
      unknown.push(name)
      return
    }
    visited.add(name)
    for (const dep of prereqs) {
      if (dep && !existing.has(dep)) await visit(dep, [...path, name])
    }
    if (!order.includes(name)) order.push(name)
  }

  await visit(target, [])
  return { toBuild: order.filter((n) => n !== target), target, unknown }
}
