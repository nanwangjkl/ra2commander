import { attackMembership, attackObjective } from '@ra2c/contracts'
import type { CompileInput, DryRunExecutor } from './compile.ts'

/** 初次装弹等待不能让代码永久结束；满弹要出击，pending/已投弹时不得重发。 */
export async function checkAttackStages(code: string, input: CompileInput, executor: DryRunExecutor): Promise<string | undefined> {
  for (const original of input.snapshot.control!.goals) {
    if (original.spec.kind !== 'attack') continue
    const membership = attackMembership(original.spec)
    const names = membership.kind === 'prepared' ? membership.names : []
    const aircraft = input.snapshot.self.find(unit => unit.type === 1 && original.spec.kind === 'attack' && (original.spec.aircraftIds.includes(unit.id) || names.includes(unit.name)))
    const name = aircraft?.name ?? names.find(name => original.spec.kind === 'attack' && name in original.spec.ammoCapacity)
    if (!name) continue
    const frame = structuredClone(input), snap = frame.snapshot
    const goal = snap.control!.goals.find(goal => goal.spec.id === original.spec.id)!
    if (goal.spec.kind !== 'attack' || !goal.attack) continue
    const unitId = aircraft?.id ?? Math.max(0, ...snap.self.map(unit => unit.id)) + 10
    const capacity = Math.max(1, goal.spec.ammoCapacity[name] ?? 1)
    let unit = snap.self.find(unit => unit.id === unitId)
    if (!unit) { unit = { id: unitId, name, type: 1, rx: 5, ry: 5, isIdle: true }; snap.self.push(unit) }
    unit.ammo = capacity
    const objective = attackObjective(goal.spec), position = objective?.search.destination ?? { x: objective?.target.region?.polygons[0]?.outer[0]?.[0] ?? 10, y: objective?.target.region?.polygons[0]?.outer[0]?.[1] ?? 10 }
    const target = goal.attack.targets[0] ?? { id: 999999, name: goal.spec.targetNames[0] ?? 'TARGET', type: 2, rx: position.x, ry: position.y, isIdle: true }
    snap.enemies = [...snap.enemies.filter(enemy => enemy.id !== target.id), target]
    Object.assign(goal.attack, { readyIds: [unitId], pendingIds: [], attackingIds: [], firedIds: [], targets: [target] })
    goal.unitIds = [unitId]; delete goal.blocked
    const constraints = frame.constraints.goals![goal.spec.id]!
    constraints.allowedUnitIds = [unitId]; constraints.aircraftIds = [unitId]; constraints.enemyIds = [target.id]
    snap.constraints = frame.constraints
    // 从首次 pending 带入脚本记忆，防止模型在没弹时写入永久 done。
    unit.ammo = capacity - 1
    goal.unitIds = []; goal.attack.readyIds = []; goal.attack.pendingIds = [unitId]; constraints.allowedUnitIds = []
    const pending = await executor.run(code, snap, {}, frame.constraints, 200)
    if (!pending.ok || pending.actions.some(item => item.goalId === goal.spec.id)) return `飞机装弹未满时必须等待：${pending.error ?? '提前发令'}`
    unit.ammo = capacity; snap.tick += 60
    goal.unitIds = [unitId]; goal.attack.readyIds = [unitId]; goal.attack.pendingIds = []; constraints.allowedUnitIds = [unitId]
    const ready = await executor.run(code, snap, pending.memory, frame.constraints, 200)
    if (!ready.ok) return `飞机满弹出击检查失败：${ready.error}`
    if (!ready.actions.some(item => item.goalId === goal.spec.id && item.request.kind === 'attack' && item.request.unitIds.includes(unitId))) return '满弹且有匹配敌人时必须向本步 readyIds 下达攻击，不能把首次 pending 写成永久结束'
    for (const phase of ['pending', 'fired'] as const) {
      unit.ammo = phase === 'pending' ? capacity - 1 : capacity
      snap.tick += 60; goal.unitIds = []; goal.attack.readyIds = []; constraints.allowedUnitIds = []
      goal.attack.pendingIds = phase === 'pending' ? [unitId] : []; goal.attack.firedIds = phase === 'fired' ? [unitId] : []
      const waited = await executor.run(code, snap, ready.memory, frame.constraints, 200)
      if (!waited.ok || waited.actions.some(item => item.goalId === goal.spec.id)) return `飞机${phase === 'pending' ? '装弹未满' : '本次已投弹'}时不能再次发令：${waited.error ?? '重复飞机动作'}`
    }
  }
  for (const original of input.snapshot.control!.goals) {
    if (original.spec.kind !== 'attack' || attackObjective(original.spec)?.search.kind !== 'region' || !original.attack?.groundIds.length) continue
    const destination = attackObjective(original.spec)?.search.destination
    if (!destination) continue
    const frame = structuredClone(input), snap = frame.snapshot, goal = snap.control!.goals.find(goal => goal.spec.id === original.spec.id)!
    const ids = original.attack.groundIds, constraints = frame.constraints.goals![goal.spec.id]!
    snap.enemies = []
    for (const unit of snap.self.filter(unit => ids.includes(unit.id))) { unit.rx = destination.x > snap.mapWidth / 2 ? 0 : snap.mapWidth - 1; unit.ry = destination.y > snap.mapHeight / 2 ? 0 : snap.mapHeight - 1; unit.isIdle = true }
    goal.unitIds = [...ids]; delete goal.blocked
    Object.assign(goal.attack!, { readyIds: ids, groundIds: ids, targets: [] })
    constraints.allowedUnitIds = [...ids]; constraints.enemyIds = []
    snap.constraints = frame.constraints
    const searched = await executor.run(code, snap, {}, frame.constraints, 200)
    if (!searched.ok || !searched.actions.some(item => item.goalId === goal.spec.id && (item.request.kind === 'move' || item.request.kind === 'attackMove') && item.request.unitIds.some(id => ids.includes(id)))) return `区域清敌暂时没有可见敌人时，地面成员仍须前往指定分区搜索，不能随飞机一起等待：${searched.error ?? '没有地面行军动作'}`
  }

}
