import { closeSync, constants, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ownerId, goalOwner, goalExecutionMode, normalizeAttackGoal, validBuildingPlacement, validTargetRegion } from '@ra2c/contracts'
import { validateCancellation } from './production-cancellation.ts'
import { validateCover } from './cover.ts'
import { validateAttackSources } from './attack-selection.ts'
import { validateFactoryRallies, type FactoryRallyState } from './factory-rally.ts'
import { validateProductionExits, type ProductionExitState } from './production-exit.ts'
import { validateGoalSpec, validateGoalFacts } from './goals/index.ts'
import type { TaskRuntime } from './index.ts'
import type { Formation } from './formation.ts'
import { skillGoalIds, type ExplorationMap, type ExplorationProgress, type SkillRun } from './exploration.ts'
import type { GoalState, ProgramState, ProductionRecord, Handoff } from './state.ts'
import type { Snapshot } from '@ra2c/contracts'

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
  factoryRallies?: FactoryRallyState
  battleResult?: NonNullable<Snapshot['battle']>
  productionExits?: ProductionExitState
}
export function persistState(runtime: TaskRuntime): PersistedState {
  return structuredClone({ version: 4, ...(runtime.battleResult ? { battleResult: runtime.battleResult } : {}), productionExits: runtime.productionExits.state, factoryRallies: runtime.factoryRallies.state, exploration: { maps: [...runtime.exploration.maps.values()], progress: [...runtime.exploration.progress.values()] }, skillRuns: [...runtime.skillRuns.values()], session: runtime.session, sessionKey: runtime.battleKey, savedAt: Date.now(), formations: runtime.formations.list(), programs: [...runtime.programs.values()], goals: [...runtime.goals], production: runtime.production, seenUnitIds: [...runtime.seenUnitIds], pausedQueues: [...runtime.pausedQueues], handoffs: runtime.handoffs })
}

/** 恢复前先观察页面；持久化文件不能替代当前对局身份证明。 */
export function restoreState(runtime: TaskRuntime, state: PersistedState): number {
  if (![3, 4].includes(state.version)) throw new Error('旧 v1/v2 任务不能合并到新脚本协议，请核对游戏队列后重新下令')
  if (!state.sessionKey || runtime.snapshot?.sessionKey !== state.sessionKey) throw new Error('保存状态与当前对局不符，未恢复')
  if (runtime.programs.size || runtime.goals.size) throw new Error('当前已有目标，不能覆盖恢复')
  if (!Array.isArray(state.programs) || !Array.isArray(state.goals) || !Array.isArray(state.formations) || !Array.isArray(state.production) || !Array.isArray(state.handoffs) || !Array.isArray(state.seenUnitIds) || !Array.isArray(state.pausedQueues)) throw new Error('状态结构不完整')
  const ids = new Set(state.goals.map(([id]) => id))
  if (state.factoryRallies) validateFactoryRallies(state.factoryRallies, runtime.snapshot)
  if (state.battleResult && (state.battleResult.phase !== 'ended' || !['victory', 'defeat'].includes(state.battleResult.outcome ?? '') || state.battleResult.evidence !== 'public-player-status' || !Array.isArray(state.battleResult.players) || state.battleResult.players.some(player => typeof player.name !== 'string' || [player.allied, player.defeated, player.combatant, player.isObserver].some(flag => typeof flag !== 'boolean')))) throw new Error('对局结束状态非法')
  if (state.productionExits) validateProductionExits(state.productionExits, runtime.snapshot)
  if (ids.size !== state.goals.length) throw new Error('重复目标 ID')
  const programIds = new Set(state.programs.map(p => p.id))
  if (programIds.size !== state.programs.length) throw new Error('重复控制对象')
  for (const p of state.programs) {
    if (p.id !== ownerId(p.owner) || !['idle', 'active', 'paused', 'stopped'].includes(p.status) || !Number.isSafeInteger(p.revision) || !Number.isSafeInteger(p.generation) || !Array.isArray(p.goalIds) || !Array.isArray(p.activeGoalIds) || [...p.goalIds, ...p.activeGoalIds].some(id => !ids.has(id))) throw new Error('控制对象状态非法')
  }
  for (const [id, goal] of state.goals) {
    if (id !== goal.spec.id || !programIds.has(goal.ownerId) || goal.ownerId !== ownerId(goalOwner(goal.spec)) || (goal.activeSpec && (goal.activeSpec.id !== id || goal.activeSpec.kind !== goal.spec.kind || goalExecutionMode(goal.activeSpec) !== goalExecutionMode(goal.spec) || ownerId(goalOwner(goal.activeSpec)) !== goal.ownerId)) || !goal.facts || !Array.isArray(goal.facts.members) || !['pending', 'active', 'completed', 'partial', 'failed', 'cancelled'].includes(goal.status)) throw new Error('目标状态非法')
    for (const spec of [goal.spec, goal.activeSpec]) if (spec) {
      validateGoalSpec(spec, runtime.snapshot)
      if (spec.kind === 'unitDeploy' && spec.sources.some(source => { const goal = state.goals.find(([id]) => id === source.goalId)?.[1]; return goal?.spec.kind !== 'production' || goal.spec.target !== source.name || source.quantity > goal.spec.quantity })) throw new Error('部署生产来源不匹配')
      if (spec.kind === 'attack') validateAttackSources(spec, new Map(state.goals))
      if (spec.kind === 'production' && spec.afterGoalId && state.goals.some(([key, target]) => key === spec.afterGoalId && target.spec.kind !== 'relocate')) throw new Error('建筑搬迁依赖非法')
    }
    validateGoalFacts(goal, runtime.snapshot)
  }

  for (const p of state.programs) if ([...p.goalIds, ...p.activeGoalIds].some(id => state.goals.find(([key]) => key === id)![1].ownerId !== p.id)) throw new Error('目标归属非法')
  for (const r of state.production) if (!ids.has(r.goalId) || !Number.isSafeInteger(r.quantity) || r.quantity < 1 || !Array.isArray(r.observedIds) || !['reserved', 'submitted', 'unknown', 'rejected'].includes(r.state)) throw new Error('生产记录非法')
  for (const record of state.production) validateCancellation(record)
  for (const record of state.production) if (record.placement && (!record.building || !validBuildingPlacement(record.placement, runtime.snapshot.mapWidth, runtime.snapshot.mapHeight) || record.placement.directions.length !== record.quantity || record.placementResults?.some(result => !record.observedIds.includes(result.unitId) || !Number.isFinite(result.x) || !Number.isFinite(result.y) || typeof result.matched !== 'boolean'))) throw new Error('建筑放置记录非法')
  for (const record of state.production) if (record.placementRegion && (!record.building || !validTargetRegion(record.placementRegion) || record.placementResults?.some(result => !record.observedIds.includes(result.unitId) || !Number.isFinite(result.x) || !Number.isFinite(result.y) || typeof result.matched !== 'boolean'))) throw new Error('建筑分区记录非法')
  const unitOwners = new Set<number>()
  const formationIds = new Set<string>()
  for (const f of state.formations) {
    if (f.cover) { validateCover(f.cover); if (f.cover.escortIds.some(id => !f.memberIds.includes(id))) throw new Error('掩护成员不属于该队') }
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
      if (!run.id || skillIds.has(run.id) || run.sessionKey !== state.sessionKey || skillGoalIds(run).some(id => !ids.has(id)) || !['preparing', 'exploring', 'repairing', 'covering', 'completed', 'partial', 'failed', 'cancelled', 'superseded'].includes(run.status)) throw new Error('Skill 运行记录非法')
      if (run.kind === 'cover') {
        if (!Array.isArray(run.preparationGoalIds) || !Array.isArray(run.escortIds) || run.escortIds.some(id => !Number.isSafeInteger(id)) || run.assignedEscortIds?.some(id => !Number.isSafeInteger(id)) || run.ownedPreparationGoalIds?.some(id => !run.preparationGoalIds.includes(id))) throw new Error('掩护 Skill 来源非法')
        if (run.cover) {
          validateCover(run.cover)
          if (run.cover.runId !== run.id || run.cover.protectedSources?.some(id => !run.preparationGoalIds.includes(id) || state.goals.find(([key]) => key === id)?.[1].spec.kind !== 'production') || run.cover.escortSources?.some(source => {
            const goal = state.goals.find(([id]) => id === source.goalId)?.[1].spec
            // 来源上限捕获于安排时；玩家后来减产不使历史角色来源失效。
            return !run.preparationGoalIds.includes(source.goalId) || goal?.kind !== 'production'
          })) throw new Error('掩护生产来源不匹配')
        }
        // 转编/解散后的检查点可能先于运行状态刷新；恢复后由真实编队配置归一化状态。
        skillIds.add(run.id); continue
      }
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
  for (const [id, goal] of state.goals) {
    const restored = structuredClone(goal)
    restored.spec = { ...normalizeAttackGoal(restored.spec), executionMode: goalExecutionMode(restored.spec) }
    if (restored.activeSpec) restored.activeSpec = { ...normalizeAttackGoal(restored.activeSpec), executionMode: goalExecutionMode(restored.activeSpec) }
    // 旧 v3/v4 的 done 从未参与判断；只保留 status 与实际进度。
    delete (restored.facts as typeof restored.facts & { done?: boolean }).done
    if (restored.facts.crushing) restored.facts.crushing.pausedAt = runtime.snapshot!.time
    runtime.goals.set(id, restored)
  }
  runtime.production.push(...structuredClone(state.production).map(r => ({ ...r, state: r.state === 'reserved' ? 'unknown' as const : r.state, ...(r.cancellation?.state === 'prepared' ? { cancellation: { ...r.cancellation, state: 'unknown' as const } } : {}) })))
  runtime.seenUnitIds.clear()
  for (const id of state.seenUnitIds) runtime.seenUnitIds.add(id)
  for (const [queue, id] of state.pausedQueues) if (ids.has(id) && Number.isInteger(queue) && queue >= 0 && queue <= 5) runtime.pausedQueues.set(queue, id)
  runtime.handoffs.push(...structuredClone(state.handoffs))
  if (state.factoryRallies) runtime.factoryRallies.state = structuredClone({ ...state.factoryRallies, settings: state.factoryRallies.settings.map(setting => ({ ...setting, status: setting.status === 'prepared' ? 'unknown' as const : setting.status })) })
  if (state.productionExits) runtime.productionExits.restore(state.productionExits)
  if (!runtime.battleResult && state.battleResult) runtime.battleResult = structuredClone(state.battleResult)
  if (state.version === 4) {
    for (const map of state.exploration!.maps) runtime.exploration.maps.set(map.id, structuredClone(map))
    for (const progress of state.exploration!.progress) runtime.exploration.progress.set(progress.goalId, structuredClone(progress))
    for (const run of state.skillRuns!) runtime.skillRuns.set(run.id, structuredClone(run))
  }
  // 第一份快照可能已经结束；恢复不能等待不存在的下一帧才收尾。
  runtime.finishBattle()
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
