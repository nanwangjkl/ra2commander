import type { ActionRequest, CombatGoal, GoalSpec, ProductionGoal, Snapshot, StepOutcome } from '../packages/contracts/src/index.ts'
import { TaskRuntime, FormationRegistry, type RuntimeDeps } from '../packages/runtime/src/index.ts'

export const code = 'function step(snapshot, memory) { return { actions: [], memory: {} } }'
export function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return { session: 1, sessionKey: 'battle-a', seq: 1, tick: 15, time: 1, credits: 1000, mapWidth: 100, mapHeight: 100,
    production: { power: { drain: 0, total: 100, isLowPower: false }, queues: [], available: ['MTNK', 'NAPOWR'] },
    self: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: 'MTNK', type: 7, rx: 5, ry: 5, isIdle: true, primaryWeapon: { maxRange: 6, minRange: 0, aa: false, ag: true } })),
    enemies: [{ id: 99, name: 'ENEMY', type: 7, rx: 8, ry: 5, isIdle: true }], ...overrides }
}
export function spec(overrides: Partial<CombatGoal> = {}): CombatGoal {
  return { id: 'alpha', kind: 'combat', rawText: '守区', formationId: 'A', region: { name: '区', x1: 0, y1: 0, x2: 10, y2: 10 }, allowedActions: ['move', 'attack', 'stop'], ...overrides }
}
export function production(overrides: Partial<ProductionGoal> = {}): ProductionGoal {
  return { id: 'production', kind: 'production', rawText: '生产坦克', target: 'MTNK', quantity: 1, prerequisites: [], queues: [], targetType: 7, ...overrides }
}
export function activate(runtime: TaskRuntime, goal: GoalSpec = spec(), source = code): string {
  const id = runtime.upsertGoal(goal)
  const lease = runtime.beginCompile(id)
  if (!runtime.commitCompile(lease, source)) throw new Error('fixture 部署失败')
  return id
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
export const outcome = (actions: ActionRequest[] = [], memory: unknown = {}, goalId = 'alpha'): StepOutcome => ({ ok: true, actions: actions.map(request => ({ goalId, request })), memory })
export const move: Extract<ActionRequest, { kind: 'move' }> = { kind: 'move', unitIds: [1], x: 6, y: 6 }
export async function harness(executor: RuntimeDeps['executor'] = { run: async () => outcome([move]) }, extra: Partial<RuntimeDeps> = {}) {
  const submitted: ActionRequest[] = []
  const formations = extra.formations ?? new FormationRegistry()
  if (!extra.formations) formations.create('A', [1])
  const runtime = new TaskRuntime({ executor, formations, checkpoint: () => {}, submit: async (actions, context, guard) => {
    if (!guard()) return []
    submitted.push(...actions)
    return actions.map(() => ({ ok: true, submitted: 1, session: context.session }))
  }, ...extra })
  await runtime.onSnapshot(snapshot())
  return { runtime, submitted, formations }
}
