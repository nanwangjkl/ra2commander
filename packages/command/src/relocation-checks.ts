import type { ActionRequest } from '@ra2c/contracts'
import type { CompileInput, DryRunExecutor } from './compile.ts'

/** 验证生成代码能在变形换 ID 后移动、抵达后展开；不接触真实游戏。 */
export async function checkRelocationStages(code: string, input: CompileInput, executor: DryRunExecutor): Promise<string | undefined> {
  for (const original of input.snapshot.control!.goals) {
    if (original.spec.kind !== 'relocate') continue
    for (const stage of ['moving', 'deploying'] as const) {
      const frame = structuredClone(input)
      const snap = frame.snapshot, goal = snap.control!.goals.find(goal => goal.spec.id === original.spec.id)!
      if (goal.spec.kind !== 'relocate') continue
      const unitId = Math.max(0, ...snap.self.map(unit => unit.id)) + 100
      const point = goal.spec.candidates[0]!
      const action: ActionRequest = stage === 'moving' ? { kind: 'move', unitIds: [unitId], ...point } : { kind: 'deploy', unitIds: [unitId] }
      const oldId = goal.relocation?.unitId ?? goal.spec.unitId
      snap.self = snap.self.filter(unit => unit.id !== oldId)
      snap.self.push({ id: unitId, name: goal.spec.vehicleName, type: 7, rx: stage === 'moving' ? goal.spec.origin.x : point.x, ry: stage === 'moving' ? goal.spec.origin.y : point.y, canDeploy: true, isIdle: true })
      snap.tick += 60
      goal.unitIds = [unitId]
      goal.relocation = { phase: stage, unitId, destination: point, action, detail: '阶段检查' }
      const constraints = frame.constraints.goals![goal.spec.id]!
      constraints.allowedUnitIds = [unitId]; constraints.allowedActions = [action.kind]; constraints.relocationAction = action
      snap.constraints = frame.constraints
      const result = await executor.run(code, snap, {}, frame.constraints, 200)
      if (!result.ok) return `基地搬迁${stage}阶段检查失败：${result.error}`
      if (!result.actions.some(item => item.goalId === goal.spec.id && item.request.kind === action.kind && 'unitIds' in item.request && item.request.unitIds.includes(unitId))) return `基地搬迁代码未处理${stage}阶段的本步 relocation.action；不能缓存变形前 ID 或遗漏重新展开`
    }
  }
}
