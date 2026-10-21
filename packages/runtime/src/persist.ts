import { closeSync, constants, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ownerId, goalOwner } from '@ra2c/contracts'
import type { TaskRuntime } from './index.ts'
import type { Formation } from './formation.ts'
import type { GoalState, ProgramState, ProductionRecord, Handoff } from './state.ts'

export interface PersistedState {
  version: 3
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
}
export function persistState(runtime: TaskRuntime): PersistedState {
  return structuredClone({ version: 3, session: runtime.session, sessionKey: runtime.battleKey, savedAt: Date.now(), formations: runtime.formations.list(), programs: [...runtime.programs.values()], goals: [...runtime.goals], production: runtime.production, seenUnitIds: [...runtime.seenUnitIds], pausedQueues: [...runtime.pausedQueues], handoffs: runtime.handoffs })
}

/** 恢复前先观察页面；持久化文件不能替代当前对局身份证明。 */
export function restoreState(runtime: TaskRuntime, state: PersistedState): number {
  if (state.version !== 3) throw new Error('旧 v1/v2 任务不能合并到新脚本协议，请核对游戏队列后重新下令')
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
    if (id !== goal.spec.id || !programIds.has(goal.ownerId) || goal.ownerId !== ownerId(goalOwner(goal.spec)) || (goal.activeSpec && (goal.activeSpec.id !== id || ownerId(goalOwner(goal.activeSpec)) !== goal.ownerId)) || !goal.facts || !Array.isArray(goal.facts.members) || !['pending', 'active', 'completed', 'cancelled'].includes(goal.status)) throw new Error('目标状态非法')
  }
  for (const p of state.programs) if ([...p.goalIds, ...p.activeGoalIds].some(id => state.goals.find(([key]) => key === id)![1].ownerId !== p.id)) throw new Error('目标归属非法')
  for (const r of state.production) if (!ids.has(r.goalId) || !Number.isSafeInteger(r.quantity) || r.quantity < 1 || !Array.isArray(r.observedIds) || !['reserved', 'submitted', 'unknown', 'rejected'].includes(r.state)) throw new Error('生产记录非法')
  const unitOwners = new Set<number>()
  const formationIds = new Set<string>()
  for (const f of state.formations) {
    if (formationIds.has(f.id) || !Array.isArray(f.memberIds) || !Array.isArray(f.originalMemberIds) || f.memberIds.some(id => !Number.isSafeInteger(id) || unitOwners.has(id))) throw new Error('编队归属非法')
    formationIds.add(f.id)
    for (const id of f.memberIds) unitOwners.add(id)
  }
  for (const h of state.handoffs) if (!ids.has(h.goalId) || !Array.isArray(h.unitIds) || !Array.isArray(h.owners) || h.unitIds.some(id => !h.owners.some(([unit]) => unit === id))) throw new Error('交接记录非法')
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
  return state.programs.filter(p => p.script).length
}

export function readStateFile(path: string): PersistedState {
  const state = JSON.parse(readFileSync(path, 'utf8')) as PersistedState
  if (state.version !== 3) throw new Error('发现旧 v1/v2 状态；文件保留，请先核对游戏中已有生产，再重新下令')
  return state
}

/** JSON 检查点先 fsync 再替换。保留旧格式备份，不修改浏览器资源。 */
export function saveStateFile(path: string, state: PersistedState): void {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    const previous = JSON.parse(readFileSync(path, 'utf8')) as { version?: number }
    if (previous.version !== 3) {
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
