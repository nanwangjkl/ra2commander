import type { ActionRequest, Region, Snapshot, StepConstraints } from './index.ts'

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
        if (!Number.isSafeInteger(a.quantity) || a.quantity < 1) return '生产数量非法'
        quantities[a.name] = (quantities[a.name] ?? 0) + a.quantity
        if (quantities[a.name]! > (Object.hasOwn(c.produceRemaining ?? {}, a.name) ? c.produceRemaining![a.name]! : 0)) return `生产额度不足: ${a.name}`
      } else if (a.x !== undefined || a.y !== undefined) {
        if (!tile(a.x, a.y, c)) return '建筑坐标非法'
      }
      continue
    }
    if (a.kind === 'pauseQueue' || a.kind === 'resumeQueue') {
      if (!Number.isInteger(a.queueType) || a.queueType < 0 || a.queueType > 5 || !c.allowedQueueTypes?.includes(a.queueType)) return '未授权生产队列'
      if (a.kind === 'resumeQueue' && !c.resumableQueueTypes?.includes(a.queueType)) return '不能恢复其他任务或玩家暂停的队列'
      if (snapshot && !snapshot.production?.queues.some(q => q.type === a.queueType)) return '队列状态不可观测，无法安全操作'
      continue
    }
    if (!['move', 'attackMove', 'gather', 'attack', 'stop', 'scatter', 'guard'].includes(a.kind)) return '未知动作类型'
    if (a.kind !== 'stop' && !c.allowedActions?.includes(a.kind)) return `未授权动作: ${a.kind}`
    if (!Array.isArray(a.unitIds) || !a.unitIds.length || a.unitIds.some(id => !Number.isSafeInteger(id) || !allowed.has(id))) return '引用未授权或失效单位'
    if (c.retreat?.active) {
      if (a.kind !== 'stop' && !(a.kind === 'move' && tile(a.x, a.y, c) && a.x === c.retreat.x && a.y === c.retreat.y)) return '回撤阶段只能停驻或前往授权回撤点'
      continue
    }
    if (a.kind === 'move' || a.kind === 'attackMove' || a.kind === 'gather') {
      if (!tile(a.x, a.y, c)) return '动作坐标非法'
      if (c.retreat && a.x === c.retreat.x && a.y === c.retreat.y) return '回撤条件尚未满足'
      if (!c.region || !inRegion(a.x, a.y, c.region)) return '移动超出授权地域'
    } else if (a.kind === 'attack') {
      if (!enemies.has(a.targetId)) return '攻击目标已不可见'
      // 显式 Attack 会触发引擎追击；只授权当前射程内的目标，再由后续快照监控偏移。
      const target = snapshot?.enemies.find(u => u.id === a.targetId)
      for (const id of a.unitIds) {
        const unit = snapshot?.self.find(u => u.id === id)
        if (!unit || !target || !c.region || !inRegion(unit.rx, unit.ry, c.region)) return '攻击者不在授权守区'
        const distance = Math.hypot(unit.rx - target.rx, unit.ry - target.ry)
        if (![unit.primaryWeapon, unit.secondaryWeapon].some(w => w && (target.type === 1 ? w.aa : w.ag) && distance <= w.maxRange && distance >= w.minRange)) return '目标不在已知合法射程内'
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
