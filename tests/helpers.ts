import type { ActionRequest, Snapshot, StepOutcome } from '../packages/contracts/src/index.ts'
import { TaskRuntime, type RuntimeDeps, type TaskSpec } from '../packages/runtime/src/index.ts'

export const code = 'function step(snapshot, memory) { return { actions: [], memory: {} } }'
export function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    session: 1, sessionKey: 'battle-a', seq: 1, tick: 15, time: 1, credits: 1000, mapWidth: 100, mapHeight: 100,
    self: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: 'MTNK', type: 7, rx: 5, ry: 5, isIdle: true, primaryWeapon: { maxRange: 6, minRange: 0, aa: false, ag: true } })),
    enemies: [{ id: 99, name: 'ENEMY', type: 7, rx: 8, ry: 5, isIdle: true }], ...overrides,
  }
}
export function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return { id: 'alpha', rawText: '守区', unitIds: [1], originalMembers: [1], region: { name: '区', x1: 0, y1: 0, x2: 10, y2: 10 }, allowedActions: ['move', 'attack', 'stop'], ...overrides }
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
export const outcome = (actions: ActionRequest[] = [], memory: unknown = {}): StepOutcome => ({ ok: true, actions, memory })
export const move: Extract<ActionRequest, { kind: 'move' }> = { kind: 'move', unitIds: [1], x: 6, y: 6 }
export async function harness(executor: RuntimeDeps['executor'] = { run: async () => outcome([move]) }, extra: Partial<RuntimeDeps> = {}) {
  const submitted: ActionRequest[] = []
  const runtime = new TaskRuntime({ executor, submit: async (actions, context, guard) => {
    if (!guard()) return []
    submitted.push(...actions)
    return actions.map(() => ({ ok: true, submitted: 1, session: context.session }))
  }, ...extra })
  await runtime.onSnapshot(snapshot())
  return { runtime, submitted }
}
