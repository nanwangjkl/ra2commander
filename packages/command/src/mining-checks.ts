import type { CompileInput, DryRunExecutor } from './compile.ts'

/** 拦截“只到中心就算采矿”和每步重复 gather 打断返厂的候选代码。 */
export async function checkMiningStages(code: string, input: CompileInput, executor: DryRunExecutor): Promise<string | undefined> {
  for (const original of input.snapshot.control!.goals) {
    if (original.spec.kind !== 'mining' || !original.unitIds.length) continue
    const frame = structuredClone(input), snap = frame.snapshot
    const goal = snap.control!.goals.find(goal => goal.spec.id === original.spec.id)!
    if (goal.spec.kind !== 'mining') continue
    const unitId = goal.unitIds[0]!, point = goal.spec.destination
    const action = { kind: 'gather' as const, unitIds: [unitId], x: point.x, y: point.y }
    const unit = snap.self.find(unit => unit.id === unitId)
    if (unit) unit.isIdle = true
    delete goal.blocked
    goal.mining = { actions: [action], knownOre: 1, assigned: 0, total: goal.unitIds.length, detail: '阶段检查' }
    const constraints = frame.constraints.goals![goal.spec.id]!
    delete constraints.blocked
    constraints.miningActions = [action]
    snap.constraints = frame.constraints
    const gathering = await executor.run(code, snap, {}, frame.constraints, 200)
    if (!gathering.ok) return `分区采矿阶段检查失败：${gathering.error}`
    if (!gathering.actions.some(item => item.goalId === goal.spec.id && item.request.kind === 'gather' && item.request.unitIds.includes(unitId))) return '已有公开矿格分配时必须执行 g.mining.actions 的 gather，不能只移动到分区中心'
    if (unit) unit.isIdle = false
    snap.tick += 90
    goal.mining.actions = []; goal.mining.assigned = 1
    constraints.miningActions = []
    const busy = await executor.run(code, snap, gathering.memory, frame.constraints, 200)
    if (!busy.ok || busy.actions.some(item => item.goalId === goal.spec.id)) return `矿车忙碌时必须等待，不能重复发令打断采集、返厂或卸货：${busy.error ?? '重复采矿动作'}`
  }
}
