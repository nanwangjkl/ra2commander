import { inTargetRegion, type ActionRequest, type ActionResult, type GoalView, type MiningGoal, type Snapshot } from '@ra2c/contracts'

interface MiningJob {
  unitId: number
  target?: number
  lastSentTick?: number
  lastKind?: 'move' | 'gather'
  idleSince?: number
}
export interface MiningState {
  cursor: number
  passes: number
  oreCells: number[]
  observedAt?: number
  jobs: MiningJob[]
}
export const initialMining = (): MiningState => ({ cursor: 0, passes: 0, oreCells: [], jobs: [] })

/** 目标点都来自公开矿格；不根据位移或收入猜测单车货量，不干扰忙碌矿车返厂和卸货。 */
export function planMining(spec: MiningGoal, snap: Snapshot, ids: number[], previous: MiningState) {
  const state = structuredClone(previous)
  const members = snap.self.filter(unit => ids.includes(unit.id))
  state.jobs = state.jobs.filter(job => ids.includes(job.unitId))
  const actions: ActionRequest[] = []
  const claimed = new Map<number, number>()
  for (const job of state.jobs) if (job.target !== undefined) claimed.set(job.target, (claimed.get(job.target) ?? 0) + 1)
  for (const unit of members) {
    let job = state.jobs.find(job => job.unitId === unit.id)
    if (!job) { job = { unitId: unit.id }; state.jobs.push(job) }
    if (job.lastSentTick !== undefined) {
      if (!unit.isIdle) { delete job.idleSince; continue }
      job.idleSince ??= snap.tick
      if (snap.tick - job.lastSentTick < 60 || snap.tick - job.idleSince < 30) continue
    }
    const ore = state.oreCells.slice().sort((a, b) => {
      const score = (cell: number) => Math.hypot(cell % snap.mapWidth - unit.rx, Math.floor(cell / snap.mapWidth) - unit.ry) + (claimed.get(cell) ?? 0) * 20 + (job!.target === cell && state.oreCells.length > 1 ? 15 : 0)
      return score(a) - score(b) || a - b
    })[0]
    if (ore !== undefined) {
      actions.push({ kind: 'gather', unitIds: [unit.id], x: ore % snap.mapWidth, y: Math.floor(ore / snap.mapWidth) })
      claimed.set(ore, (claimed.get(ore) ?? 0) + 1)
    } else if (job.lastSentTick === undefined && !inTargetRegion(unit.rx, unit.ry, spec.targetRegion)) {
      actions.push({ kind: 'move', unitIds: [unit.id], x: spec.destination.x, y: spec.destination.y })
    }
  }
  const assigned = state.jobs.filter(job => job.lastKind === 'gather').length
  const detail = state.oreCells.length ? `${spec.targetRegion.name}已知矿格${state.oreCells.length}个；已向${assigned}/${members.length}辆下达采矿，忙碌成员由游戏继续采集、返厂和卸货`
    : `${spec.targetRegion.name}暂未发现公开可读的矿格，${state.passes ? '继续观察' : '正在分批搜索'}${actions.length ? '；矿车先前往该区寻找矿格' : ''}`
  const view: NonNullable<GoalView['mining']> = { actions, knownOre: state.oreCells.length, assigned, total: members.length, detail }
  return { state, view }
}

/** 每次优先复核已分配矿点和矿车周围，再继续区域扫描；不遍历全图或读取黑幕。 */
export function miningBatch(spec: MiningGoal, snap: Snapshot, state: MiningState, ids: number[], limit = 256) {
  const points = spec.targetRegion.polygons.flatMap(polygon => polygon.outer)
  const minX = Math.max(0, Math.floor(Math.min(...points.map(point => point[0])))), maxX = Math.min(snap.mapWidth - 1, Math.ceil(Math.max(...points.map(point => point[0]))))
  const minY = Math.max(0, Math.floor(Math.min(...points.map(point => point[1])))), maxY = Math.min(snap.mapHeight - 1, Math.ceil(Math.max(...points.map(point => point[1]))))
  const width = maxX - minX + 1, total = width * (maxY - minY + 1)
  const cells = new Set<number>()
  const add = (cell: number) => {
    const x = cell % snap.mapWidth, y = Math.floor(cell / snap.mapWidth)
    if (cells.size < limit && x >= minX && x <= maxX && y >= minY && y <= maxY && inTargetRegion(x, y, spec.targetRegion)) cells.add(cell)
  }
  for (const job of state.jobs) if (job.target !== undefined && cells.size < 32) add(job.target)
  for (const unit of snap.self.filter(unit => ids.includes(unit.id))) {
    if (cells.size >= 128) break
    const center = inTargetRegion(unit.rx, unit.ry, spec.targetRegion) ? { x: Math.round(unit.rx), y: Math.round(unit.ry) } : spec.destination
    for (let dx = -3; dx <= 3 && cells.size < 128; dx++) for (let dy = -3; dy <= 3 && cells.size < 128; dy++) {
      const x = center.x + dx, y = center.y + dy
      if (x >= 0 && y >= 0 && x < snap.mapWidth && y < snap.mapHeight) add(y * snap.mapWidth + x)
    }
  }
  let cursor = state.cursor % total, passes = state.passes
  for (let n = 0; n < Math.min(total, 4096) && cells.size < limit; n++) {
    add((minY + Math.floor(cursor / width)) * snap.mapWidth + minX + cursor % width)
    cursor++
    if (cursor >= total) { cursor = 0; passes++ }
  }
  return { cells: [...cells], cursor, passes }
}

export function observeOre(state: MiningState, spec: MiningGoal, width: number, observation: { seen: number[]; ore: number[] }, batch: { cursor: number; passes: number }, tick: number): void {
  const ore = new Set(observation.ore), known = new Set(state.oreCells)
  for (const cell of observation.seen) {
    if (!inTargetRegion(cell % width, Math.floor(cell / width), spec.targetRegion)) continue
    if (ore.has(cell)) known.add(cell); else known.delete(cell)
  }
  state.oreCells = [...known]; state.cursor = batch.cursor; state.passes = batch.passes; state.observedAt = tick
}

export function recordMiningResult(state: MiningState, request: ActionRequest, results: ActionResult[], snap: Snapshot): void {
  if ((request.kind !== 'gather' && request.kind !== 'move') || !results.some(result => result.ok)) return
  for (const id of request.unitIds) {
    let job = state.jobs.find(job => job.unitId === id)
    if (!job) { job = { unitId: id }; state.jobs.push(job) }
    job.lastSentTick = snap.tick; job.lastKind = request.kind; delete job.idleSince
    if (request.kind === 'gather') job.target = request.y * snap.mapWidth + request.x
  }
}
