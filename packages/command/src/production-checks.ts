import type { CompileInput, DryRunExecutor } from './compile.ts'

/** 实际已经就绪时，候选脚本须能放置；空动作通过语法检查不代表修复成功。 */
export async function checkReadyBuildings(code: string, input: CompileInput, executor: DryRunExecutor): Promise<string | undefined> {
  const ready = new Map((input.snapshot.control?.goals ?? []).filter(goal => goal.spec.kind === 'production' && !goal.blocked).map(goal => [goal.spec.id, goal.productionPlan?.readyToPlace ?? []]))
  if (![...ready.values()].some(names => names.length)) return
  const result = await executor.run(code, input.snapshot, {}, input.constraints, 200)
  if (!result.ok) return `就绪建筑放置检查失败：${result.error}`
  if (!result.actions.some(item => item.request.kind === 'place' && ready.get(item.goalId)?.includes(item.request.name))) return '建筑已就绪但候选脚本没有提出 place 动作：请逐目标读取 goal.productionPlan.readyToPlace，即使 produceRemaining 为 0 也要放置；不能用空动作通过修复'
}
