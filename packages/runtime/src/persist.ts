import type { TaskRuntime, TaskSpec, TaskState } from './index.ts'
import type { Formation, FormationRegistry } from './formation.ts'

/** 持久化状态（.runtime/state.json）：companion 重启后恢复指挥。 */
export interface PersistedState {
  version: 1
  /** 保存时的对局代次（恢复后换局由 runtime 的会话失效机制自动终结旧任务）。 */
  session: number
  savedAt: number
  formations: Array<{ id: string; memberIds: number[]; originalMemberIds: number[]; createdAt: number }>
  tasks: Array<{
    spec: TaskSpec
    code: string
    version: number
    memory: unknown
    status: string
  }>
}

/** 全量导出（stopped 任务不导出；memory 保持脚本自己的 JSON 结构）。 */
export function persistState(
  runtime: TaskRuntime,
  formations: FormationRegistry,
  session: number,
): PersistedState {
  const tasks: PersistedState['tasks'] = []
  for (const t of runtime.tasks.values()) {
    if (!t.script || t.status === 'stopped') continue
    tasks.push({ spec: t.spec, code: t.script.code, version: t.script.version, memory: t.memory, status: t.status })
  }
  return {
    version: 1,
    session,
    savedAt: Date.now(),
    formations: formations.list().map((f) => ({ ...f, memberIds: [...f.memberIds], originalMemberIds: [...f.originalMemberIds] })),
    tasks,
  }
}

/**
 * 恢复：编队原样重建（跨局无效成员由快照存活过滤自然终结）；
 * 任务按原状态恢复（active/paused），代码不重新校验（与保存前同一份，未变更）。
 */
export function restoreState(
  runtime: TaskRuntime,
  formations: FormationRegistry,
  state: PersistedState,
): number {
  for (const f of state.formations) {
    formations.create(f.id, f.memberIds, { force: true })
    // 保留原始成员基准（create 会把当前成员当基准；补一次修正）。
    const created = formations.list().find((x) => x.id === f.id)
    if (created) created.originalMemberIds = [...f.originalMemberIds]
  }
  let restored = 0
  for (const t of state.tasks) {
    if (t.status === 'stopped') continue
    runtime.deploy(t.spec, t.code)
    const task = runtime.tasks.get(t.spec.id) as TaskState | undefined
    if (task) {
      task.memory = t.memory
      task.script!.version = t.version
      if (t.status === 'paused') task.status = 'paused'
      restored++
    }
  }
  return restored
}
