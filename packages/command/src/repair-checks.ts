import type { CompileInput, DryRunExecutor } from './compile.ts'

/** 初次编译时通常还没生产。离线补查上车与双车维修阶段，避免空准备态掩盖缺失分支。 */
export async function checkRepairStages(code: string, input: CompileInput, executor: DryRunExecutor): Promise<string | undefined> {
  for (const original of input.snapshot.control?.goals ?? []) {
    if (original.spec.kind !== 'repair') continue
    const spec = original.spec
    let nextId = Math.max(0, ...input.snapshot.self.map(unit => unit.id), ...input.snapshot.enemies.map(unit => unit.id)) + 1
    const [v1, v2, e1, e2, t1, t2] = Array.from({ length: 6 }, () => nextId++) as [number, number, number, number, number, number]
    for (const stage of ['assemble', 'repair'] as const) {
      const snapshot = structuredClone(input.snapshot), constraints = structuredClone(input.constraints)
      const view = snapshot.control!.goals.find(goal => goal.spec.id === spec.id)!, permissions = constraints.goals?.[spec.id]
      if (!permissions || !view.repair) return '维修目标缺少动态组装与维修事实'
      const fake = (id: number, name: string, type: number) => ({ id, name, type, rx: 0, ry: 0, hitPoints: 50, maxHitPoints: 100, isIdle: true })
      snapshot.self.push(...[v1, v2].map((id, n) => ({ ...fake(id, spec.vehicleNames[0]!, 7), transport: { capacity: 1, occupied: stage === 'repair' ? 1 : 0, unitIds: stage === 'repair' ? [n === 0 ? e1 : e2] : [] } })), fake(e1, spec.engineerNames[0]!, 3), fake(e2, spec.engineerNames[0]!, 3), fake(t1, spec.tankNames[0]!, 7), fake(t2, spec.tankNames[0]!, 7))
      view.unitIds = [v1, v2, e1, e2]; delete view.blocked
      view.repair = { waiting: false, readyIds: stage === 'repair' ? [v1, v2] : [], assembling: stage === 'assemble' ? [{ engineerId: e1, vehicleId: v1 }, { engineerId: e2, vehicleId: v2 }] : [], targets: stage === 'repair' ? [{ unitId: v1, targetId: t1 }, { unitId: v2, targetId: t2 }] : [], damaged: [t1, t2].map(id => ({ id, hitPoints: 50, maxHitPoints: 100 })) }
      permissions.allowedUnitIds = view.unitIds; permissions.friendlyTargetIds = [v1, v2, t1, t2]
      snapshot.constraints = constraints
      const result = await executor.run(code, snapshot, {}, constraints, 200)
      if (!result.ok) return `维修${stage === 'assemble' ? '组装' : '并行'}阶段检查失败：${result.error}`
      const pairs = stage === 'assemble' ? [[e1, v1], [e2, v2]] : [[v1, t1], [v2, t2]]
      if (!pairs.every(([unitId, targetId]) => result.actions.some(item => item.goalId === spec.id && item.request.kind === (stage === 'assemble' ? 'enterTransport' : 'repair') && item.request.targetId === targetId && item.request.unitIds.includes(unitId!)))) return `维修${stage === 'assemble' ? '组装' : '并行'}阶段检查失败：同一步须遍历两组动态${stage === 'assemble' ? 'assembling，分别上车' : 'targets，分别对准受损坦克'}，不能串行等待或省略后续阶段`
    }
  }
}
