// Step 脚本隔离执行 worker（Node worker_threads 占位实现；架构终态为独立进程 QuickJS）。
// 约束：只接受单个 function step 声明源码；同步执行；结果必须可结构化克隆。
import { parentPort } from 'node:worker_threads'
import { createHash } from 'node:crypto'

const compiled = new Map() // codeHash -> { fn }（进程内缓存）

function hashOf(code) {
  return createHash('sha256').update(code).digest('hex')
}

function compile(code) {
  const h = hashOf(code)
  let entry = compiled.get(h)
  if (!entry) {
    const factory = new Function(`${code}\n;return typeof step === 'function' ? step : undefined`)
    const fn = factory()
    if (typeof fn !== 'function') throw new Error('脚本未定义 function step(snapshot, memory)')
    entry = { fn }
    compiled.set(h, entry)
  }
  return entry.fn
}

const KNOWN_KINDS = new Set(['move', 'attackMove', 'attack', 'stop', 'gather'])
// 无坐标/无目标动作：不需要 x/y，也不需要 targetId。
const NO_TARGET_KINDS = new Set(['stop', 'scatter', 'guard'])

/** 动作结构校验（宿主提交前还有一层复查，这里是执行侧第一道）。 */
function validateActions(actions, constraints) {
  if (!Array.isArray(actions)) return 'actions 必须是数组'
  if (actions.length > (constraints.maxActions ?? 20)) return `动作数超上限: ${actions.length}`
  const allowed = new Set(constraints.allowedUnitIds ?? [])
  const enemies = new Set(constraints.enemyIds ?? [])
  for (const a of actions) {
    if (!a || typeof a !== 'object' || !KNOWN_KINDS.has(a.kind)) return `未知动作类型: ${JSON.stringify(a).slice(0, 80)}`
    if (!Array.isArray(a.unitIds) || a.unitIds.length === 0) return `动作 ${a.kind} 缺少 unitIds`
    for (const id of a.unitIds) {
      if (!Number.isInteger(id) || !allowed.has(id)) return `动作 ${a.kind} 引用未授权单位 ${id}`
    }
    if (a.kind === 'attack') {
      if (!Number.isInteger(a.targetId) || !enemies.has(a.targetId)) return `attack 目标 ${a.targetId} 不在可见敌人中`
    } else if (!NO_TARGET_KINDS.has(a.kind)) {
      if (!Number.isInteger(a.x) || !Number.isInteger(a.y)) return `动作 ${a.kind} 坐标非法`
      if (a.x < 0 || a.y < 0 || a.x >= constraints.mapWidth || a.y >= constraints.mapHeight)
        return `动作 ${a.kind} 坐标越界 (${a.x},${a.y})`
    }
  }
  return undefined
}

parentPort.on('message', (msg) => {
  const { runId, code, snapshot, memory, constraints } = msg
  try {
    const fn = compile(code)
    const out = fn(snapshot, memory ?? {})
    if (!out || typeof out !== 'object') throw new Error('step 返回值必须是对象')
    const err = validateActions(out.actions ?? [], constraints)
    if (err) throw new Error(err)
    // memory 必须可 JSON 序列化（跨 tick 传递走结构化克隆，这里提前把关）。
    JSON.stringify(out.memory ?? {})
    parentPort.postMessage({ runId, ok: true, actions: out.actions ?? [], memory: out.memory ?? {} })
  } catch (err) {
    parentPort.postMessage({ runId, ok: false, error: String(err?.message ?? err).slice(0, 500) })
  }
})
