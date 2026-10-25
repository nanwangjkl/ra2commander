import type { ExploreGoal, GoalView, Snapshot } from '@ra2c/contracts'

export interface ExplorationMap {
  id: string
  mapId: string
  schemeId: string
  schemeVersion: string
  width: number
  height: number
  regions: Array<{ id: string; name: string; cells: number[] }>
  seen: number[]
  impassable: number[]
  cursor: number
}
interface Target { unitId: number; cell: number; regionId: string; bestDistance: number; lastProgressTick: number; lastX?: number; lastY?: number; lastMotionTick?: number }
export interface ExplorationProgress {
  goalId: string
  mapId: string
  regionIds: string[]
  targets: Target[]
  stalls: Record<string, number>
  failureStreak?: Record<string, number>
  retryRounds?: Record<string, number>
  lastRegionSeen?: Record<string, number>
  lastFailedUnit?: Record<string, number>
  rejected: number[]
  everHadMembers: boolean
  pausedAtTick?: number
  result?: { state: 'completed' | 'partial' | 'failed'; detail: string; coverage: Omit<View, 'targets'> }
}
export interface ExplorationObservation { seen: number[]; impassable: number[] }
type View = NonNullable<GoalView['exploration']>

/** 只依据页面实际揭开的格子累计覆盖；位置、走过路点、未知地形均不能增加 seen。 */
export class ExplorationStore {
  readonly maps = new Map<string, ExplorationMap>()
  readonly progress = new Map<string, ExplorationProgress>()
  private cache = new Map<string, { seen: Set<number>; impassable: Set<number>; cells: number[]; valid: Set<number>; interiors: Map<string, number[]>; centers: Map<string, number> }>()
  private summaries = new Map<string, { key: string; view: Omit<View, 'targets'> }>()
  clear(): void { this.maps.clear(); this.progress.clear(); this.cache.clear(); this.summaries.clear() }
  private data(map: ExplorationMap) {
    let data = this.cache.get(map.id)
    if (!data) {
      const cells = [...new Set(map.regions.flatMap(region => region.cells))]
      data = { seen: new Set(map.seen), impassable: new Set(map.impassable), cells, valid: new Set(cells), interiors: new Map(), centers: new Map() }
      this.cache.set(map.id, data)
    }
    return data
  }
  private interior(map: ExplorationMap, region: ExplorationMap['regions'][number], margin: number): number[] {
    if (!margin) return region.cells
    const data = this.data(map), key = `${region.id}:${margin}`
    let cells = data.interiors.get(key)
    if (!cells) {
      const regionCells = new Set(region.cells)
      cells = region.cells.filter(cell => [-margin, 0, margin].every(dx => [-margin, 0, margin].every(dy => {
        const x = cell % map.width + dx, y = Math.floor(cell / map.width) + dy
        return x >= 0 && x < map.width && y >= 0 && y < map.height && regionCells.has(y * map.width + x)
      })))
      data.interiors.set(key, cells)
    }
    return cells
  }
  private center(map: ExplorationMap, region: ExplorationMap['regions'][number], margin: number): number {
    const data = this.data(map), key = `${region.id}:${margin}`
    let cell = data.centers.get(key)
    if (cell === undefined) {
      const x = region.cells.reduce((sum, cell) => sum + cell % map.width, 0) / region.cells.length
      const y = region.cells.reduce((sum, cell) => sum + Math.floor(cell / map.width), 0) / region.cells.length
      const interior = this.interior(map, region, margin), candidates = interior.length ? interior : region.cells
      cell = candidates.reduce((best, next) => Math.hypot(next % map.width - x, Math.floor(next / map.width) - y) < Math.hypot(best % map.width - x, Math.floor(best / map.width) - y) ? next : best)
      data.centers.set(key, cell)
    }
    return cell
  }
  add(map: ExplorationMap, goalId: string, regionIds: string[]): void {
    if (!this.maps.has(map.id)) this.maps.set(map.id, structuredClone(map))
    if (this.progress.has(goalId)) throw new Error('探索目标 ID 已存在')
    const stored = this.maps.get(map.id)!
    if (!regionIds.length || regionIds.some(id => !stored.regions.some(region => region.id === id))) throw new Error('探索区域不存在')
    this.progress.set(goalId, { goalId, mapId: map.id, regionIds: [...regionIds], targets: [], stalls: {}, rejected: [], everHadMembers: false })
  }
  /** 每次最多读取 limit 格，优先当前目标与成员附近；其余循环扫描，绝不逐帧扫全图。 */
  batch(mapId: string, limit: number, members: Snapshot['self'], goalIds: string[]): number[] {
    const map = this.maps.get(mapId)!, { cells, valid } = this.data(map)
    const batch = new Set<number>()
    const add = (x: number, y: number) => { const cell = y * map.width + x; if (x >= 0 && x < map.width && y >= 0 && y < map.height && valid.has(cell) && batch.size < Math.floor(limit / 2)) batch.add(cell) }
    for (const run of this.progress.values()) if (run.mapId === mapId && goalIds.includes(run.goalId)) for (const target of run.targets) add(target.cell % map.width, Math.floor(target.cell / map.width))
    for (const member of members) for (let dy = -4; dy <= 4; dy += 2) for (let dx = -4; dx <= 4; dx += 2) add(Math.round(member.rx) + dx, Math.round(member.ry) + dy)
    for (let n = 0; n < cells.length && batch.size < limit; n++) {
      batch.add(cells[map.cursor % cells.length]!)
      map.cursor = (map.cursor + 1) % cells.length
    }
    return [...batch]
  }
  observe(mapId: string, observation: ExplorationObservation): void {
    const map = this.maps.get(mapId)
    if (!map) return
    const data = this.data(map), blocked = new Set(observation.impassable)
    for (const cell of observation.seen) {
      if (!Number.isSafeInteger(cell) || !data.valid.has(cell)) continue
      if (!data.seen.has(cell)) { data.seen.add(cell); map.seen.push(cell) }
      if (blocked.has(cell)) data.impassable.add(cell)
      else data.impassable.delete(cell)
    }
    map.impassable = [...data.impassable]
  }
  suspend(goalId: string, tick: number): void {
    const run = this.progress.get(goalId)
    if (run && run.pausedAtTick === undefined) run.pausedAtTick = tick
  }
  view(goal: ExploreGoal): View {
    const run = this.progress.get(goal.explorationId)!, map = this.maps.get(run.mapId)!, data = this.data(map)
    // 旧版本运行未捕获阈值时保留原来的全部揭开口径。
    const coverageRatio = goal.policy.coverageRatio ?? 1
    const satisfied = (seen: number, total: number) => total > 0 && seen / total >= coverageRatio
    if (run.result) return { ...run.result.coverage, coverageRatio, regions: run.result.coverage.regions.map(region => ({ ...region, satisfied: satisfied(region.seen, region.total), deferred: !satisfied(region.seen, region.total) && region.deferred })), targets: [] }
    const key = `${coverageRatio}:${data.seen.size}:${JSON.stringify(run.failureStreak ?? run.stalls)}`
    let summary = this.summaries.get(run.goalId)
    if (!summary || summary.key !== key) {
      const regions = map.regions.filter(region => run.regionIds.includes(region.id)).map(region => {
        const seen = region.cells.reduce((n, cell) => n + Number(data.seen.has(cell)), 0), reached = satisfied(seen, region.cells.length)
        return { id: region.id, name: region.name, total: region.cells.length, seen, satisfied: reached, deferred: !reached && ((run.failureStreak ?? run.stalls)[region.id] ?? 0) >= goal.policy.maxStallsPerRegion }
      })
      const cells = [...new Set(map.regions.filter(region => run.regionIds.includes(region.id)).flatMap(region => region.cells))]
      summary = { key, view: { regions, coverageRatio, seen: cells.reduce((n, cell) => n + Number(data.seen.has(cell)), 0), total: cells.length } }
      this.summaries.set(run.goalId, summary)
    }
    return { ...summary.view, targets: run.targets.map(target => ({ unitId: target.unitId, x: target.cell % map.width, y: Math.floor(target.cell / map.width), regionId: target.regionId })) }
  }
  advance(goal: ExploreGoal, snap: Snapshot, memberIds: number[], waiting: boolean): { state: 'completed' | 'partial' | 'failed'; detail: string } | undefined {
    const run = this.progress.get(goal.explorationId), map = run && this.maps.get(run.mapId)
    if (!run || !map) return { state: 'failed', detail: '探索范围数据缺失，请重新下令' }
    if (run.result) return run.result
    if (run.pausedAtTick !== undefined) {
      for (const target of run.targets) target.lastProgressTick += Math.max(0, snap.tick - run.pausedAtTick)
      for (const target of run.targets) if (target.lastMotionTick !== undefined) target.lastMotionTick += Math.max(0, snap.tick - run.pausedAtTick)
      delete run.pausedAtTick
    }
    run.failureStreak ??= { ...run.stalls }
    run.retryRounds ??= {}
    run.lastRegionSeen ??= {}
    run.lastFailedUnit ??= {}
    // 累计失败仅供复盘；区域继续产生真实覆盖时，重新开放其尝试额度。
    for (const region of this.view(goal).regions) {
      const previous = run.lastRegionSeen[region.id]
      if (previous !== undefined && region.seen > previous) { run.failureStreak[region.id] = 0; run.retryRounds[region.id] = 0 }
      run.lastRegionSeen[region.id] = region.seen
    }
    const finish = (state: 'completed' | 'partial' | 'failed', detail: string) => {
      const { targets, ...coverage } = this.view(goal)
      run.result = { state, detail, coverage }; run.targets = []
      return { state, detail }
    }
    const data = this.data(map), members = snap.self.filter(unit => memberIds.includes(unit.id))
    run.everHadMembers ||= members.length > 0
    const before = this.view(goal)
    if (before.regions.length > 0 && before.regions.every(region => region.satisfied)) return finish('completed', `全部目标分区覆盖均已达到${Math.round(before.coverageRatio * 100)}%`)
    const satisfied = new Set(before.regions.filter(region => region.satisfied).map(region => region.id))
    if (!members.length) {
      run.targets = []
      if (waiting) return
      return finish(run.everHadMembers ? 'partial' : 'failed', run.everHadMembers ? '侦察成员已全部损失，仍有未揭开区域' : '没有可用侦察成员')
    }
    run.targets = run.targets.filter(target => {
      const unit = members.find(unit => unit.id === target.unitId)
      if (!unit || satisfied.has(target.regionId) || data.seen.has(target.cell)) return false
      const distance = Math.hypot(unit.rx - target.cell % map.width, unit.ry - Math.floor(target.cell / map.width))
      if (distance < target.bestDistance - 0.5) { target.bestDistance = distance; target.lastProgressTick = snap.tick }
      // 绕坡道时可能暂时离终点更远；只在成员实际长时间不移动时换点。
      if (target.lastX === undefined || target.lastY === undefined || Math.hypot(unit.rx - target.lastX, unit.ry - target.lastY) >= 0.5) {
        target.lastX = unit.rx; target.lastY = unit.ry; target.lastMotionTick = snap.tick
      }
      if (snap.tick - (target.lastMotionTick ?? target.lastProgressTick) < goal.policy.stallTicks) return true
      run.stalls[target.regionId] = (run.stalls[target.regionId] ?? 0) + 1
      run.failureStreak![target.regionId] = (run.failureStreak![target.regionId] ?? 0) + 1
      run.lastFailedUnit![target.regionId] = target.unitId
      run.rejected.push(target.cell)
      return false
    })
    const distanceBetween = (a: number, b: number) => Math.hypot(a % map.width - b % map.width, Math.floor(a / map.width) - Math.floor(b / map.width))
    const rejected = new Set<number>()
    // 单点失败扩大为小范围避让，避免紧邻同一障碍连续消耗全部尝试。
    const margin = goal.policy.interiorMargin ?? 0
    for (const cell of run.rejected) for (let dy = -margin; dy <= margin; dy++) for (let dx = -margin; dx <= margin; dx++) {
      const x = cell % map.width + dx, y = Math.floor(cell / map.width) + dy
      if (x >= 0 && x < map.width && y >= 0 && y < map.height) rejected.add(y * map.width + x)
    }
    const assign = () => {
      const eligible = map.regions.filter(region => run.regionIds.includes(region.id) && !satisfied.has(region.id) && (run.failureStreak![region.id] ?? 0) < goal.policy.maxStallsPerRegion)
      const ordered = [...members].sort((a, b) => eligible.filter(region => run.lastFailedUnit![region.id] === a.id).length - eligible.filter(region => run.lastFailedUnit![region.id] === b.id).length || a.id - b.id)
      // 同一轮使用同一份候选表；优先分区内部的未知格子，窄区或内部已探索后再回退。
      const candidates = new Map(eligible.map(region => {
        const unknown = (cells: number[]) => cells.filter(cell => !data.seen.has(cell) && !data.impassable.has(cell) && !rejected.has(cell))
        const core = unknown(this.interior(map, region, margin)), pool = core.length ? core : unknown(region.cells)
        const coarse = pool.filter(cell => cell % map.width % goal.policy.pointSpacing === 0 && Math.floor(cell / map.width) % goal.policy.pointSpacing === 0)
        return [region.id, { coarse, pool }] as const
      }))
      for (const unit of ordered) {
        if (run.targets.some(target => target.unitId === unit.id)) continue
        const choices: Array<{ cell: number; regionId: string; score: number; distance: number; centerDistance: number }> = []
        for (const region of eligible) {
          let best: typeof choices[number] | undefined
          const points = candidates.get(region.id)!
          for (const pool of goal.policy.centerFirst ? [points.pool] : [points.coarse, points.pool]) {
            for (const cell of pool) {
              if (run.targets.some(target => distanceBetween(target.cell, cell) < goal.policy.pointSpacing)) continue
              const distance = Math.hypot(unit.rx - cell % map.width, unit.ry - Math.floor(cell / map.width))
              const score = distance + (run.lastFailedUnit![region.id] === unit.id ? map.width + map.height : 0)
              const centerDistance = goal.policy.centerFirst ? distanceBetween(cell, this.center(map, region, margin)) : 0
              if (!best || centerDistance < best.centerDistance || (centerDistance === best.centerDistance && score < best.score)) best = { cell, regionId: region.id, score, distance, centerDistance }
            }
            if (best) break
          }
          if (best) choices.push(best)
        }
        const free = choices.filter(choice => !run.targets.some(target => target.regionId === choice.regionId))
        const best = (free.length ? free : choices).sort((a, b) => a.score - b.score)[0]
        if (best) run.targets.push({ unitId: unit.id, cell: best.cell, regionId: best.regionId, bestDistance: best.distance, lastProgressTick: snap.tick, lastX: unit.rx, lastY: unit.ry, lastMotionTick: snap.tick })
      }
    }
    assign()
    if (!run.targets.length) {
      const deferred = this.view(goal).regions.filter(region => !region.satisfied && region.deferred && (run.retryRounds![region.id] ?? 0) < (goal.policy.retryPasses ?? 0))
      for (const region of deferred) { run.failureStreak[region.id] = 0; run.retryRounds[region.id] = (run.retryRounds[region.id] ?? 0) + 1 }
      if (deferred.length) assign()
    }
    if (!run.targets.length) return finish('partial', Object.values(run.retryRounds).some(round => round > 0) ? '换点重试后仍无法推进，保留未达标分区记录' : '剩余区域多次停滞或暂无可用落点，保留未探索记录')
  }
}

export interface SkillRun {
  id: string; skillId: string; version: string; hash: string; source: string; promptVersion: string; gameId: string
  commandId: string; rawText: string; sessionKey: string; createdAt: number
  quantity: number; useExisting: boolean; formationId: string; preparationGoalId: string; exploreGoalId: string
  memberSource?: 'auto' | 'existing' | 'new'
  map: { id: string; schemeId: string; schemeVersion: string; geometryHash: string }
  status: 'preparing' | 'exploring' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'superseded'
  detail?: string
}
