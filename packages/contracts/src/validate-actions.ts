import type { ActionRequest, Region, Snapshot, StepConstraints } from './index.ts'
import type { ScriptAction } from './control.ts'
import { inTargetRegion } from './spatial.ts'

/** 清理过期动作，并按共享队列空位安排本步生产；结构、额度与边界仍严格校验。 */
export function liveScriptActions(value: ScriptAction[], c: StepConstraints, snapshot?: Snapshot): ScriptAction[] {
  if (!Array.isArray(value) || value.length > (c.maxActions ?? 20)) return value
  if (!c.ignoreInactiveGoals) return scheduleProduction(value, c, snapshot)
  const live = value.flatMap(item => {
    if (!item || typeof item.goalId !== 'string' || !item.request || typeof item.request !== 'object') return [item]
    const goal = c.goals?.[item.goalId]
    if (!goal) return []
    const action = item.request
    if (action.kind === 'produce' && typeof action.name === 'string' && Number.isSafeInteger(action.quantity) && action.quantity > 0 && goal.produceRemaining?.[action.name] === 0) return []
    if (action.kind === 'attack' && Number.isSafeInteger(action.targetId) && !goal.enemyIds.includes(action.targetId)) return []
    if ('unitIds' in action && Array.isArray(action.unitIds) && action.unitIds.length && action.unitIds.every(id => Number.isSafeInteger(id))) {
      if (['createFormation', 'transferUnits'].includes(action.kind)) {
        const management = goal.management
        if (management?.exact && management.allowedUnitIds.length !== management.maxUnits) return []
        return action.unitIds.every(id => management?.allowedUnitIds.includes(id)) ? [item] : []
      }
      const unitIds = action.unitIds.filter(id => goal.allowedUnitIds.includes(id))
      if (!unitIds.length) return []
      if (action.kind === 'attackMove' && goal.targetRegion && snapshot && inTargetRegion(action.x, action.y, goal.targetRegion)
        && unitIds.some(id => { const unit = snapshot.self.find(unit => unit.id === id); return unit && !inTargetRegion(unit.rx, unit.ry, goal.targetRegion!) })) {
        return [{ ...item, request: { kind: 'move' as const, unitIds, x: action.x, y: action.y } }]
      }
      return [{ ...item, request: { ...action, unitIds } } as ScriptAction]
    }
    return [item]
  })
  return scheduleProduction(live, c, snapshot)
}

/** 同步脚本可能对多个目标重复使用同一个队列空位。延后冲突项，不扩大目标额度。 */
function scheduleProduction(actions: ScriptAction[], c: StepConstraints, snapshot?: Snapshot): ScriptAction[] {
  const requested = new Map<string, number>()
  for (const item of actions) {
    const goal = item && c.goals?.[item.goalId], action = item?.request
    if (!goal || action?.kind !== 'produce') continue
    // 先保留真正的输入/额度错误交给原校验，不用队列裁剪掩盖它们。
    if (validateActions([action], { ...goal, queueSpace: {} }, snapshot)) return actions
    const key = `${item.goalId}:${action.name}`, total = (requested.get(key) ?? 0) + action.quantity
    if (total > (goal.produceRemaining?.[action.name] ?? 0)) return actions
    requested.set(key, total)
  }
  const remaining = new Map<number, number>()
  for (const goal of Object.values(c.goals ?? {})) for (const [queue, space] of Object.entries(goal.queueSpace ?? {})) {
    remaining.set(Number(queue), Math.min(remaining.get(Number(queue)) ?? space, space))
  }
  return actions.flatMap(item => {
    const action = item?.request, goal = item && c.goals?.[item.goalId]
    if (!goal || action?.kind !== 'produce') return [item]
    const queue = goal.productionQueueTypes?.[action.name], space = queue === undefined ? undefined : remaining.get(queue)
    if (space === undefined) return [item]
    const quantity = Math.min(action.quantity, space)
    if (quantity <= 0) return []
    remaining.set(queue!, space - quantity)
    return [{ ...item, request: { ...action, quantity } }]
  })
}

/** 脚本统一使用目标包装；页面桥仍接收原有游戏动作。 */
export function validateScriptActions(value: unknown, c: StepConstraints, snapshot?: Snapshot): string | undefined {
  if (!Array.isArray(value) || value.length > (c.maxActions ?? 20)) return '动作数组非法或超过上限'
  const spent: Record<string, number> = Object.create(null)
  for (const item of value as ScriptAction[]) {
    if (!item || typeof item.goalId !== 'string' || !item.request || typeof item.request !== 'object') return '动作必须包含 goalId 和 request'
    const goal = c.goals?.[item.goalId]
    if (!goal) { if (c.ignoreInactiveGoals) continue; return '动作引用未生效目标' }
    const a = item.request
    if (a.kind === 'createFormation' || a.kind === 'transferUnits' || a.kind === 'dissolveFormation') {
      const m = goal.management
      if (!m || m.kind !== a.kind || m.formationId !== a.formationId) return '编队管理请求与目标不符'
      if (a.kind !== 'dissolveFormation') {
        if (!Array.isArray(a.unitIds) || !a.unitIds.length || new Set(a.unitIds).size !== a.unitIds.length || a.unitIds.some(id => !Number.isSafeInteger(id) || !m.allowedUnitIds.includes(id))) return '管理请求引用失效成员'
        const key = item.goalId + ':members'
        spent[key] = (spent[key] ?? 0) + a.unitIds.length
        if (spent[key]! > m.maxUnits) return '管理请求超过目标成员数量'
        if (m.exact && a.unitIds.length !== m.maxUnits) return '管理请求必须包含完整目标成员'
        if (a.kind === 'createFormation' && !!a.force !== !!m.force) return '建队归属条件不符'
      }
      continue
    }
    const error = validateActions([a], goal, snapshot)
    if (error) return error
    if (a.kind === 'produce') {
      const key = item.goalId + ':' + a.name
      spent[key] = (spent[key] ?? 0) + a.quantity
      if (spent[key]! > (goal.produceRemaining?.[a.name] ?? 0)) return '生产额度不足'
      const queue = goal.productionQueueTypes?.[a.name]
      if (queue !== undefined && goal.queueSpace?.[queue] !== undefined) {
        const queueKey = 'queue:' + queue
        spent[queueKey] = (spent[queueKey] ?? 0) + a.quantity
        if (spent[queueKey]! > goal.queueSpace[queue]!) return '同一批次超过生产队列空位'
      }
    }
    if (goal.destination && a.kind === 'move' && (a.x !== goal.destination.x || a.y !== goal.destination.y)) return '集结目标不符'
  }
}

export function inRegion(x: number, y: number, r: Region): boolean {
  return x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2
}

/** 只处理经 JSON 传输的数据；执行器返回后与最终提交前分别检查。 */
export function validateActions(value: unknown, c: StepConstraints, snapshot?: Snapshot): string | undefined {
  if (!Array.isArray(value) || value.length > (c.maxActions ?? 20)) return '动作数组非法或超过上限'
  const allowed = new Set(c.allowedUnitIds)
  const enemies = new Set(c.enemyIds)
  const quantities: Record<string, number> = Object.create(null)
  for (const a of value as ActionRequest[]) {
    if (!a || typeof a !== 'object') return '动作必须是对象'
    if (a.kind === 'produce' || a.kind === 'place' || a.kind === 'cancel') {
      if (a.kind === 'cancel') return '未授权取消已投入生产的项目'
      if (typeof a.name !== 'string' || !c.allowedProduce?.includes(a.name)) return '未授权生产项目'
      if (a.kind === 'produce') {
        if (snapshot && !snapshot.production?.available.includes(a.name)) return `项目尚未解锁或当前不可造: ${a.name}`
        if (!Number.isSafeInteger(a.quantity) || a.quantity < 1) return '生产数量非法'
        const queue = c.productionQueueTypes?.[a.name]
        if (queue !== undefined && c.queueSpace?.[queue] !== undefined && a.quantity > c.queueSpace[queue]!) return '生产队列空位不足'
        quantities[a.name] = (quantities[a.name] ?? 0) + a.quantity
        if (quantities[a.name]! > (Object.hasOwn(c.produceRemaining ?? {}, a.name) ? c.produceRemaining![a.name]! : 0)) return `生产额度不足: ${a.name}`
      } else {
        if (c.allowedPlace && !c.allowedPlace.includes(a.name)) return '没有该目标或共享前置的待落地建筑'
        if ((a.x !== undefined || a.y !== undefined) && !tile(a.x, a.y, c)) return '建筑坐标非法'
      }
      continue
    }
    if (a.kind === 'pauseQueue' || a.kind === 'resumeQueue') {
      if (!Number.isInteger(a.queueType) || a.queueType < 0 || a.queueType > 5 || !c.allowedQueueTypes?.includes(a.queueType)) return '未授权生产队列'
      if (a.kind === 'resumeQueue' && !c.resumableQueueTypes?.includes(a.queueType)) return '不能恢复其他任务或玩家暂停的队列'
      if (snapshot && !snapshot.production?.queues.some(q => q.type === a.queueType)) return '队列状态不可观测，无法安全操作'
      continue
    }
    if (!['move', 'attackMove', 'gather', 'attack', 'stop', 'deploy', 'scatter', 'guard'].includes(a.kind)) return '未知动作类型'
    if (a.kind !== 'stop' && !c.allowedActions?.includes(a.kind)) return `未授权动作: ${a.kind}`
    if (!Array.isArray(a.unitIds) || !a.unitIds.length || a.unitIds.some(id => !Number.isSafeInteger(id) || !allowed.has(id))) return '引用未授权或失效单位'
    if (a.kind === 'deploy') {
      if (snapshot && a.unitIds.some(id => !snapshot.self.find(u => u.id === id)?.canDeploy)) return '单位当前不能展开'
      continue
    }
    if (c.retreat?.active) {
      if (a.kind !== 'stop' && !(a.kind === 'move' && tile(a.x, a.y, c) && a.x === c.retreat.x && a.y === c.retreat.y)) return '回撤阶段只能停驻或前往授权回撤点'
      continue
    }
    if (a.kind === 'move' || a.kind === 'attackMove' || a.kind === 'gather') {
      if (!tile(a.x, a.y, c)) return '动作坐标非法'
      if (c.retreat && a.x === c.retreat.x && a.y === c.retreat.y) return '回撤条件尚未满足'
      if (!c.region || !inRegion(a.x, a.y, c.region)) return '移动超出授权地域'
      if (a.kind === 'attackMove' && c.targetRegion && !inTargetRegion(a.x, a.y, c.targetRegion)) return '攻击移动超出目标分区'
    } else if (a.kind === 'attack') {
      if (!enemies.has(a.targetId)) return '攻击目标已不可见'
      const target = snapshot?.enemies.find(u => u.id === a.targetId)
      if (c.targetRegion && target && !inTargetRegion(target.rx, target.ry, c.targetRegion)) return '攻击目标不在指定分区'
      for (const id of a.unitIds) {
        const unit = snapshot?.self.find(u => u.id === id)
        if (!unit || !target || !c.region || !inRegion(unit.rx, unit.ry, c.region)) return '攻击者不在授权守区'
      }
    } else if (a.kind !== 'stop') {
      // scatter/guard 的原生自主移动无法按地域约束，暂不授权。
      return `无法约束原生动作: ${a.kind}`
    }
  }
}

function tile(x: unknown, y: unknown, c: StepConstraints): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && (x as number) >= 0 && (y as number) >= 0 && (x as number) < c.mapWidth && (y as number) < c.mapHeight
}
