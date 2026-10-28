import { attackMembership, attackObjective } from '@ra2c/contracts'
import type { CompileInput, DryRunExecutor } from './compile.ts'

/** 连续快照带入脚本记忆：地面行军不能吞掉攻击，飞机等待不能永久结束。 */
export async function checkAttackStages(code: string, input: CompileInput, executor: DryRunExecutor): Promise<string | undefined> {
  const groundError = await checkGroundAttackStages(code, input, executor)
  if (groundError) return groundError
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

/** 只在隔离帧改变位置，不在实战增加射程判断或代发游戏动作。 */
async function checkGroundAttackStages(code: string, input: CompileInput, executor: DryRunExecutor): Promise<string | undefined> {
  for (const original of input.snapshot.control!.goals) {
    if (original.spec.kind !== 'attack' || !original.attack?.groundIds.length || !original.attack.targets.length) continue
    const frame = structuredClone(input), snap = frame.snapshot
    const goal = snap.control!.goals.find(goal => goal.spec.id === original.spec.id)!
    const units = snap.self.filter(unit => original.attack!.groundIds.includes(unit.id))
    if (!units.length) continue
    const ids = units.map(unit => unit.id), target = goal.attack!.targets[0]!
    const constraints = frame.constraints.goals![goal.spec.id]!
    goal.unitIds = ids; delete goal.blocked; delete constraints.blocked
    Object.assign(goal.attack!, { readyIds: ids, groundIds: ids, targets: [target] })
    constraints.allowedUnitIds = ids; constraints.enemyIds = [target.id]
    snap.constraints = frame.constraints
    // 先在远处发令，再携带相同记忆抵达。不能把 move 的目标记忆当成已经 attack。
    for (const unit of units) {
      unit.rx = target.rx < snap.mapWidth / 2 ? snap.mapWidth - 1 : 0
      unit.ry = target.ry < snap.mapHeight / 2 ? snap.mapHeight - 1 : 0
      unit.isIdle = true
    }
    const approaching = await executor.run(code, snap, {}, frame.constraints, 200)
    if (!approaching.ok) return `地面攻击行军阶段检查失败：${approaching.error}`
    const advanced = approaching.actions.some(item => item.goalId === goal.spec.id && ['attack', 'move', 'attackMove'].includes(item.request.kind) && 'unitIds' in item.request && item.request.unitIds.some(id => ids.includes(id)))
    if (!advanced) return '地面成员已就绪且有匹配敌人时必须攻击或接近目标，不能因距离较远而原地等待；优先直接 attack，让游戏处理接近'
    const attacked = new Set(approaching.actions.flatMap(item => item.goalId === goal.spec.id && item.request.kind === 'attack' && item.request.targetId === target.id ? item.request.unitIds : []))
    for (const unit of units) {
      unit.rx = Math.max(0, target.rx - 1); unit.ry = target.ry
      unit.isIdle = !attacked.has(unit.id)
    }
    snap.tick += 120
    const arrived = await executor.run(code, snap, approaching.memory, frame.constraints, 200)
    if (!arrived.ok) return `地面攻击抵达阶段检查失败：${arrived.error}`
    if (!attacked.size && !arrived.actions.some(item => item.goalId === goal.spec.id && item.request.kind === 'attack' && item.request.targetId === target.id && item.request.unitIds.some(id => ids.includes(id)))) return '地面成员抵达匹配敌人附近后必须下达 attack，不能把先前 move/attackMove 的目标记忆当成已攻击；去重须区分动作类型、目标和成员'
  }
}
