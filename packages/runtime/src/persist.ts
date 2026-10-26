import { closeSync, constants, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ownerId, goalOwner, validBuildingPlacement, validTargetRegion, inTargetRegion } from '@ra2c/contracts'
import type { TaskRuntime } from './index.ts'
import type { Formation } from './formation.ts'
import { skillGoalIds, type ExplorationMap, type ExplorationProgress, type SkillRun } from './exploration.ts'
import type { GoalState, ProgramState, ProductionRecord, Handoff } from './state.ts'

export interface PersistedState {
  version: 3 | 4
  session: number
  sessionKey: string
  savedAt: number
  formations: Formation[]
  programs: ProgramState[]
  goals: Array<[string, GoalState]>
  production: ProductionRecord[]
  seenUnitIds: number[]
  pausedQueues: Array<[number, string]>
  handoffs: Handoff[]
  exploration?: { maps: ExplorationMap[]; progress: ExplorationProgress[] }
  skillRuns?: SkillRun[]
}
export function persistState(runtime: TaskRuntime): PersistedState {
  return structuredClone({ version: 4, exploration: { maps: [...runtime.exploration.maps.values()], progress: [...runtime.exploration.progress.values()] }, skillRuns: [...runtime.skillRuns.values()], session: runtime.session, sessionKey: runtime.battleKey, savedAt: Date.now(), formations: runtime.formations.list(), programs: [...runtime.programs.values()], goals: [...runtime.goals], production: runtime.production, seenUnitIds: [...runtime.seenUnitIds], pausedQueues: [...runtime.pausedQueues], handoffs: runtime.handoffs })
}

/** 恢复前先观察页面；持久化文件不能替代当前对局身份证明。 */
export function restoreState(runtime: TaskRuntime, state: PersistedState): number {
  if (![3, 4].includes(state.version)) throw new Error('旧 v1/v2 任务不能合并到新脚本协议，请核对游戏队列后重新下令')
  if (!state.sessionKey || runtime.snapshot?.sessionKey !== state.sessionKey) throw new Error('保存状态与当前对局不符，未恢复')
  if (runtime.programs.size || runtime.goals.size) throw new Error('当前已有目标，不能覆盖恢复')
  if (!Array.isArray(state.programs) || !Array.isArray(state.goals) || !Array.isArray(state.formations) || !Array.isArray(state.production) || !Array.isArray(state.handoffs) || !Array.isArray(state.seenUnitIds) || !Array.isArray(state.pausedQueues)) throw new Error('状态结构不完整')
  const ids = new Set(state.goals.map(([id]) => id))
  if (ids.size !== state.goals.length) throw new Error('重复目标 ID')
  const programIds = new Set(state.programs.map(p => p.id))
  if (programIds.size !== state.programs.length) throw new Error('重复控制对象')
  for (const p of state.programs) {
    if (p.id !== ownerId(p.owner) || !['idle', 'active', 'paused', 'stopped'].includes(p.status) || !Number.isSafeInteger(p.revision) || !Number.isSafeInteger(p.generation) || !Array.isArray(p.goalIds) || !Array.isArray(p.activeGoalIds) || [...p.goalIds, ...p.activeGoalIds].some(id => !ids.has(id))) throw new Error('控制对象状态非法')
  }
  for (const [id, goal] of state.goals) {
    if (id !== goal.spec.id || !programIds.has(goal.ownerId) || goal.ownerId !== ownerId(goalOwner(goal.spec)) || (goal.activeSpec && (goal.activeSpec.id !== id || ownerId(goalOwner(goal.activeSpec)) !== goal.ownerId)) || !goal.facts || !Array.isArray(goal.facts.members) || !['pending', 'active', 'completed', 'partial', 'failed', 'cancelled'].includes(goal.status)) throw new Error('目标状态非法')
    for (const spec of [goal.spec, goal.activeSpec]) if (spec?.kind === 'production' && spec.placement && !validBuildingPlacement(spec.placement, runtime.snapshot.mapWidth, runtime.snapshot.mapHeight)) throw new Error('建筑方位数据非法')
    for (const spec of [goal.spec, goal.activeSpec]) {
      if (spec?.kind === 'building' && (!['repair', 'sell'].includes(spec.operation) || !Array.isArray(spec.unitIds) || !spec.unitIds.length || new Set(spec.unitIds).size !== spec.unitIds.length || spec.unitIds.some(id => !Number.isSafeInteger(id)))) throw new Error('建筑操作目标非法')
      if (spec?.kind === 'attack' && (!Array.isArray(spec.unitIds) || !Array.isArray(spec.aircraftIds) || !spec.unitIds.length && !spec.dynamicNames?.length || spec.unitIds.some(id => !Number.isSafeInteger(id)) || spec.aircraftIds.some(id => !spec.unitIds.includes(id)) || !Array.isArray(spec.preparationGoalIds) || !Array.isArray(spec.targetNames) || !['enemies', 'base', 'units', 'buildings'].includes(spec.targetKind) || !spec.ammoCapacity || Object.values(spec.ammoCapacity).some(value => !Number.isFinite(value)) || spec.targetRegion && !validTargetRegion(spec.targetRegion))) throw new Error('攻击对象或目标范围数据非法')
      if (spec?.kind === 'mining' && (!Array.isArray(spec.unitIds) || !spec.unitIds.length || new Set(spec.unitIds).size !== spec.unitIds.length || spec.unitIds.some(id => !Number.isSafeInteger(id)) || !validTargetRegion(spec.targetRegion) || !Number.isSafeInteger(spec.destination?.x) || !Number.isSafeInteger(spec.destination?.y) || !inTargetRegion(spec.destination.x, spec.destination.y, spec.targetRegion))) throw new Error('采矿目标数据非法')
      if (spec?.kind === 'production' && spec.placementRegion && !validTargetRegion(spec.placementRegion)) throw new Error('建筑分区数据非法')
      if (spec?.kind === 'production' && spec.afterGoalId && (spec.afterGoalId === spec.id || state.goals.some(([id, goal]) => id === spec.afterGoalId && goal.spec.kind !== 'relocate'))) throw new Error('建筑搬迁依赖非法')
      if (spec?.kind === 'relocate' && (!Number.isSafeInteger(spec.unitId) || !spec.vehicleName || !spec.yardName || !Array.isArray(spec.candidates) || !spec.candidates.length || spec.candidates.some(point => !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y) || point.x < 0 || point.y < 0 || point.x >= runtime.snapshot!.mapWidth || point.y >= runtime.snapshot!.mapHeight) || spec.targetRegion && (!validTargetRegion(spec.targetRegion) || spec.candidates.some(point => !inTargetRegion(point.x, point.y, spec.targetRegion!))))) throw new Error('基地搬迁目标非法')
    }
    const relocation = goal.facts.relocation
    const building = goal.facts.building
    if (building && (goal.spec.kind !== 'building' || !Array.isArray(building.jobs) || new Set(building.jobs.map(job => job.unitId)).size !== building.jobs.length || building.jobs.some(job => !Number.isSafeInteger(job.unitId) || !Number.isSafeInteger(job.attempts) || job.attempts < 0 || job.sentAt !== undefined && !Number.isFinite(job.sentAt) || job.completed !== undefined && typeof job.completed !== 'boolean' || job.failed !== undefined && typeof job.failed !== 'string'))) throw new Error('建筑操作进度非法')
    if (goal.activeSpec?.kind === 'building' && !building) throw new Error('建筑操作缺少实际进度')
    if (relocation && (goal.spec.kind !== 'relocate' || !Number.isSafeInteger(relocation.unitId) || !['yard', 'vehicle'].includes(relocation.form) || !['packing', 'moving', 'deploying', 'confirming', 'completed', 'failed'].includes(relocation.phase) || !Array.isArray(relocation.knownIds) || relocation.knownIds.some(id => !Number.isSafeInteger(id)) || !Number.isFinite(relocation.position?.x) || !Number.isFinite(relocation.position?.y) || !Number.isSafeInteger(relocation.candidate) || relocation.candidate < 0 || relocation.candidate >= goal.spec.candidates.length || !Number.isFinite(relocation.progressTick))) throw new Error('基地搬迁进度非法')
    if (goal.activeSpec?.kind === 'relocate' && !relocation) throw new Error('基地搬迁缺少实际进度')
    const mining = goal.facts.mining
    const validCell = (cell: number) => Number.isSafeInteger(cell) && cell >= 0 && cell < runtime.snapshot!.mapWidth * runtime.snapshot!.mapHeight
    if (mining) {
      if (goal.spec.kind !== 'mining') throw new Error('采矿进度与目标不符')
      const region = goal.spec.targetRegion
      if (!Number.isSafeInteger(mining.cursor) || mining.cursor < 0 || !Number.isSafeInteger(mining.passes) || mining.passes < 0 || !Array.isArray(mining.oreCells)
        || mining.oreCells.some(cell => !validCell(cell) || !inTargetRegion(cell % runtime.snapshot!.mapWidth, Math.floor(cell / runtime.snapshot!.mapWidth), region))
        || !Array.isArray(mining.jobs) || mining.jobs.some(job => !Number.isSafeInteger(job.unitId) || job.target !== undefined && !validCell(job.target)
          || job.lastSentTick !== undefined && !Number.isFinite(job.lastSentTick) || job.idleSince !== undefined && !Number.isFinite(job.idleSince)
          || job.lastKind !== undefined && !['move', 'gather'].includes(job.lastKind))) throw new Error('采矿观察或发令进度非法')
    }
    if (goal.activeSpec?.kind === 'mining' && !mining) throw new Error('采矿缺少观察与发令进度')
    const attack = goal.facts.attack
    if (attack && (goal.spec.kind !== 'attack' || !Array.isArray(attack.members) || new Set(attack.members.map(member => member.unitId)).size !== attack.members.length || attack.members.some(member => !Number.isSafeInteger(member.unitId) || typeof member.aircraft !== 'boolean' || !['pending', 'ready', 'attacking', 'fired', 'lost', 'released'].includes(member.phase) || [member.lastAmmo, member.lastCooldown, member.acceptedAt, member.firedAt].some(value => value !== undefined && !Number.isFinite(value))))) throw new Error('攻击与投弹进度非法')
    if (goal.activeSpec?.kind === 'attack' && !attack) throw new Error('攻击缺少执行进度')
    for (const spec of [goal.spec, goal.activeSpec]) if (spec?.kind === 'explore' && spec.policy.coverageRatio !== undefined && (!Number.isFinite(spec.policy.coverageRatio) || spec.policy.coverageRatio <= 0 || spec.policy.coverageRatio > 1)) throw new Error('探索分区覆盖阈值非法')
    for (const spec of [goal.spec, goal.activeSpec]) if (spec?.kind === 'explore' && [spec.policy.interiorMargin, spec.policy.retryPasses].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) throw new Error('探索内缩与重试参数非法')
    for (const spec of [goal.spec, goal.activeSpec]) if (spec?.kind === 'explore' && spec.policy.centerFirst !== undefined && typeof spec.policy.centerFirst !== 'boolean') throw new Error('探索中心优先参数非法')
  }
  for (const p of state.programs) if ([...p.goalIds, ...p.activeGoalIds].some(id => state.goals.find(([key]) => key === id)![1].ownerId !== p.id)) throw new Error('目标归属非法')
  for (const r of state.production) if (!ids.has(r.goalId) || !Number.isSafeInteger(r.quantity) || r.quantity < 1 || !Array.isArray(r.observedIds) || !['reserved', 'submitted', 'unknown', 'rejected'].includes(r.state)) throw new Error('生产记录非法')
  for (const record of state.production) if (record.placement && (!record.building || !validBuildingPlacement(record.placement, runtime.snapshot.mapWidth, runtime.snapshot.mapHeight) || record.placement.directions.length !== record.quantity || record.placementResults?.some(result => !record.observedIds.includes(result.unitId) || !Number.isFinite(result.x) || !Number.isFinite(result.y) || typeof result.matched !== 'boolean'))) throw new Error('建筑放置记录非法')
  for (const record of state.production) if (record.placementRegion && (!record.building || !validTargetRegion(record.placementRegion) || record.placementResults?.some(result => !record.observedIds.includes(result.unitId) || !Number.isFinite(result.x) || !Number.isFinite(result.y) || typeof result.matched !== 'boolean'))) throw new Error('建筑分区记录非法')
  const unitOwners = new Set<number>()
  const formationIds = new Set<string>()
  for (const f of state.formations) {
    if (formationIds.has(f.id) || !Array.isArray(f.memberIds) || !Array.isArray(f.originalMemberIds) || f.memberIds.some(id => !Number.isSafeInteger(id) || unitOwners.has(id))) throw new Error('编队归属非法')
    formationIds.add(f.id)
    for (const id of f.memberIds) unitOwners.add(id)
  }
  for (const h of state.handoffs) if (!ids.has(h.goalId) || !Array.isArray(h.unitIds) || !Array.isArray(h.owners) || h.unitIds.some(id => !h.owners.some(([unit]) => unit === id))) throw new Error('交接记录非法')
  if (state.version === 3 && state.goals.some(([, goal]) => goal.spec.kind === 'explore')) throw new Error('v3 不包含探索目标')
  if (state.version === 4) {
    if (!state.exploration || !Array.isArray(state.exploration.maps) || !Array.isArray(state.exploration.progress) || !Array.isArray(state.skillRuns)) throw new Error('探索状态结构不完整')
    const maps = new Set<string>(), runs = new Set<string>()
    for (const map of state.exploration.maps) {
      if (!map.id || maps.has(map.id) || !Number.isSafeInteger(map.width) || !Number.isSafeInteger(map.height) || map.width < 1 || map.height < 1 || map.width !== runtime.snapshot.mapWidth || map.height !== runtime.snapshot.mapHeight || !Number.isSafeInteger(map.cursor) || map.cursor < 0 || !Array.isArray(map.regions) || !Array.isArray(map.seen) || !Array.isArray(map.impassable)) throw new Error('探索地图数据非法')
      maps.add(map.id)
      const valid = (cell: number) => Number.isSafeInteger(cell) && cell >= 0 && cell < map.width * map.height
      if ([...map.seen, ...map.impassable, ...map.regions.flatMap(region => region.cells)].some(cell => !valid(cell))) throw new Error('探索格子数据非法')
    }
    for (const progress of state.exploration.progress) {
      if (!ids.has(progress.goalId) || runs.has(progress.goalId) || !maps.has(progress.mapId) || !Array.isArray(progress.targets) || !Array.isArray(progress.rejected) || !Array.isArray(progress.regionIds) || !progress.stalls) throw new Error('探索进度非法')
      const map = state.exploration.maps.find(map => map.id === progress.mapId)!
      const valid = (cell: number) => Number.isSafeInteger(cell) && cell >= 0 && cell < map.width * map.height
      if (!progress.regionIds.length || progress.regionIds.some(id => !map.regions.some(region => region.id === id)) || progress.targets.some(target => !Number.isSafeInteger(target.unitId) || !valid(target.cell) || !progress.regionIds.includes(target.regionId) || !Number.isFinite(target.bestDistance) || !Number.isSafeInteger(target.lastProgressTick)) || progress.rejected.some(cell => !valid(cell)) || Object.entries(progress.stalls).some(([id, count]) => !progress.regionIds.includes(id) || !Number.isSafeInteger(count) || count < 0)) throw new Error('探索落点或停滞记录非法')
      for (const counts of [progress.failureStreak, progress.retryRounds, progress.lastRegionSeen, progress.lastFailedUnit]) if (counts && Object.entries(counts).some(([id, count]) => !progress.regionIds.includes(id) || !Number.isSafeInteger(count) || count < 0)) throw new Error('探索重试记录非法')
      if (progress.targets.some(target => [target.lastX, target.lastY].some(value => value !== undefined && !Number.isFinite(value)) || (target.lastMotionTick !== undefined && !Number.isSafeInteger(target.lastMotionTick)))) throw new Error('探索位置记录非法')
      if (progress.result && (!['completed', 'partial', 'failed'].includes(progress.result.state) || !progress.result.coverage || !Number.isSafeInteger(progress.result.coverage.seen) || !Number.isSafeInteger(progress.result.coverage.total) || progress.result.coverage.seen < 0 || progress.result.coverage.seen > progress.result.coverage.total || !Array.isArray(progress.result.coverage.regions))) throw new Error('探索结果非法')
      runs.add(progress.goalId)
    }
    for (const [id, goal] of state.goals) if (goal.spec.kind === 'explore' && (goal.spec.explorationId !== id || !runs.has(id))) throw new Error('探索目标缺少进度')
    const skillIds = new Set<string>()
    for (const run of state.skillRuns) {
      if (!run.id || skillIds.has(run.id) || run.sessionKey !== state.sessionKey || skillGoalIds(run).some(id => !ids.has(id)) || !['preparing', 'exploring', 'repairing', 'completed', 'partial', 'failed', 'cancelled', 'superseded'].includes(run.status)) throw new Error('Skill 运行记录非法')
      if (run.kind === 'repair-vehicle') {
        const goal = state.goals.find(([id]) => id === run.repairGoalId)![1].spec
        if (goal.kind !== 'repair' || goal.skill?.runId !== run.id || goal.skill.hash !== run.hash || goal.formationId !== run.formationId || JSON.stringify(goal.preparationGoalIds) !== JSON.stringify(run.preparationGoalIds)) throw new Error('维修 Skill 来源关联非法')
        skillIds.add(run.id); continue
      }
      const goal = state.goals.find(([id]) => id === run.exploreGoalId)![1].spec
      if (goal.kind !== 'explore' || goal.skill?.runId !== run.id || goal.skill.hash !== run.hash || goal.formationId !== run.formationId || !run.map || state.exploration.progress.find(progress => progress.goalId === run.exploreGoalId)?.mapId !== run.map.geometryHash) throw new Error('Skill 来源或地图关联非法')
      skillIds.add(run.id)
    }
  }
  // 验证通过后一次导入；不恢复编译中的候选或旧请求令牌。
  for (const f of state.formations) {
    runtime.formations.create(f.id, f.memberIds)
    Object.assign(runtime.formations.list().find(item => item.id === f.id)!, structuredClone(f))
  }
  for (const p of state.programs) runtime.programs.set(p.id, structuredClone(p))
  for (const [id, goal] of state.goals) runtime.goals.set(id, structuredClone(goal))
  runtime.production.push(...structuredClone(state.production).map(r => ({ ...r, state: r.state === 'reserved' ? 'unknown' as const : r.state })))
  runtime.seenUnitIds.clear()
  for (const id of state.seenUnitIds) runtime.seenUnitIds.add(id)
  for (const [queue, id] of state.pausedQueues) if (ids.has(id) && Number.isInteger(queue) && queue >= 0 && queue <= 5) runtime.pausedQueues.set(queue, id)
  runtime.handoffs.push(...structuredClone(state.handoffs))
  if (state.version === 4) {
    for (const map of state.exploration!.maps) runtime.exploration.maps.set(map.id, structuredClone(map))
    for (const progress of state.exploration!.progress) runtime.exploration.progress.set(progress.goalId, structuredClone(progress))
    for (const run of state.skillRuns!) runtime.skillRuns.set(run.id, structuredClone(run))
  }
  return state.programs.filter(p => p.script).length
}

export function readStateFile(path: string): PersistedState {
  const state = JSON.parse(readFileSync(path, 'utf8')) as PersistedState
  if (![3, 4].includes(state.version)) throw new Error('发现旧 v1/v2 状态；文件保留，请先核对游戏中已有生产，再重新下令')
  return state
}

/** JSON 检查点先 fsync 再替换。保留旧格式备份，不修改浏览器资源。 */
export function saveStateFile(path: string, state: PersistedState): void {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    const previous = JSON.parse(readFileSync(path, 'utf8')) as { version?: number }
    if (previous.version !== state.version) {
      try { copyFileSync(path, `${path}.v${previous.version ?? 'unknown'}.bak`, constants.COPYFILE_EXCL) }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err }
    }
  }
  const temp = `${path}.${process.pid}.tmp`
  try {
    const fd = openSync(temp, 'w', 0o600)
    try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, path)
  } finally { if (existsSync(temp)) unlinkSync(temp) }
}
