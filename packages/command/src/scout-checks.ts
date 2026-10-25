import type { CompileInput, DryRunExecutor } from './compile.ts'

/** 探路生产需要覆盖“首名成员已建队，后续成员出生”的实际交接阶段。仅在隔离执行器内检查。 */
export async function checkScoutHandoffs(code: string, input: CompileInput, executor: DryRunExecutor): Promise<string | undefined> {
  for (const goal of input.snapshot.control?.goals ?? []) {
    if (goal.spec.kind !== 'production' || goal.spec.skill?.id !== 'scout' || !goal.spec.formationId) continue
    const formationId = goal.spec.formationId
    const snapshot = structuredClone(input.snapshot), constraints = structuredClone(input.constraints)
    const view = snapshot.control!.goals.find(item => item.spec.id === goal.spec.id)!
    const permissions = constraints.goals?.[goal.spec.id]
    if (!permissions?.management) return '探路生产缺少成员交接能力'
    const unitId = Math.max(0, ...snapshot.self.map(unit => unit.id), ...snapshot.enemies.map(unit => unit.id)) + 1
    snapshot.self.push({ id: unitId, name: goal.spec.target, type: goal.spec.targetType ?? 3, rx: 0, ry: 0, isIdle: true })
    if (!snapshot.control!.formations.some(formation => formation.id === formationId)) snapshot.control!.formations.push({ id: formationId, memberIds: [] })
    view.unitIds = [unitId]; view.maxUnits = 1
    view.produceRemaining[goal.spec.target] = 0
    view.observed[goal.spec.target] = [...(view.observed[goal.spec.target] ?? []), unitId]
    permissions.produceRemaining = { ...permissions.produceRemaining, [goal.spec.target]: 0 }
    permissions.management = { kind: 'transferUnits', formationId: formationId, allowedUnitIds: [unitId], maxUnits: 1 }
    snapshot.constraints = constraints
    const result = await executor.run(code, snapshot, {}, constraints, 200)
    if (!result.ok) return `探路后续入队检查失败：${result.error ?? '脚本执行失败'}`
    if (!result.actions.some(action => action.goalId === goal.spec.id && action.request.kind === 'transferUnits' && action.request.formationId === formationId && action.request.unitIds.includes(unitId))) return '探路后续入队检查失败：首名成员建队后，必须按 management.kind=transferUnits 将后续产出成员转入；脚本仅处理 createFormation 会让其余狗留在基地'
  }
}
