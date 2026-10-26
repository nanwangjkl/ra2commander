import { inTargetRegion, type ActionRequest, type ActionResult, type GoalView, type RelocateGoal, type Snapshot } from '@ra2c/contracts'

export interface RelocationState {
  unitId: number
  form: 'yard' | 'vehicle'
  phase: NonNullable<GoalView['relocation']>['phase']
  knownIds: number[]
  position: { x: number; y: number }
  candidate: number
  progressTick: number
  lastActionTick?: number
  lastActionKind?: 'move' | 'deploy'
  missingTick?: number
  detail: string
}

export function initialRelocation(spec: RelocateGoal, snap: Snapshot): RelocationState {
  const unit = snap.self.find(unit => unit.id === spec.unitId)
  const form = unit?.name === spec.vehicleName ? 'vehicle' : 'yard'
  return { unitId: spec.unitId, form, phase: form === 'yard' ? 'packing' : 'moving',
    knownIds: snap.self.filter(unit => [spec.vehicleName, spec.yardName].includes(unit.name)).map(unit => unit.id),
    position: unit ? { x: unit.rx, y: unit.ry } : spec.origin, candidate: 0, progressTick: snap.tick, detail: form === 'yard' ? '收起建造厂并出发' : '移动基地车至目标区域' }
}

export function observeRelocation(spec: RelocateGoal, state: RelocationState, snap: Snapshot, paused: boolean): number | undefined {
  if (state.phase === 'completed' || state.phase === 'failed') return undefined
  if (paused) { state.progressTick = snap.tick; if (state.lastActionTick !== undefined) state.lastActionTick = snap.tick; if (state.missingTick !== undefined) state.missingTick = snap.tick }
  let unit = snap.self.find(unit => unit.id === state.unitId && [spec.vehicleName, spec.yardName].includes(unit.name))
  let converted: number | undefined
  if (!unit) {
    const expected = state.form === 'yard' ? spec.vehicleName : spec.yardName
    const requested = state.form === 'yard' ? state.lastActionKind === 'move' : state.lastActionKind === 'deploy'
    const candidates = requested ? snap.self.filter(unit => unit.name === expected && !state.knownIds.includes(unit.id) && Math.hypot(unit.rx - state.position.x, unit.ry - state.position.y) <= 4) : []
    if (candidates.length === 1) {
      unit = candidates[0]!
      state.unitId = unit.id; state.progressTick = snap.tick; converted = unit.id
      delete state.lastActionTick; delete state.lastActionKind; delete state.missingTick
    } else {
      state.missingTick ??= snap.tick
      state.detail = candidates.length ? '等待确认基地变形后的唯一身份' : '等待基地变形完成并确认实际单位'
      if (snap.tick - state.missingTick >= 300) fail(state, '基地已损失或无法确认变形后的身份，搬迁未完成')
      return undefined
    }
  }
  state.knownIds = [...new Set([...state.knownIds, ...snap.self.filter(unit => [spec.vehicleName, spec.yardName].includes(unit.name)).map(unit => unit.id)])]
  const moved = Math.hypot(unit.rx - state.position.x, unit.ry - state.position.y) > 0.25
  state.position = { x: unit.rx, y: unit.ry }
  if (moved) state.progressTick = snap.tick
  const point = spec.candidates[state.candidate]!
  const arrived = Math.hypot(unit.rx - point.x, unit.ry - point.y) <= 2 && (!spec.targetRegion || inTargetRegion(unit.rx, unit.ry, spec.targetRegion))
  if (unit.name === spec.yardName) {
    if (state.form === 'vehicle') {
      if (arrived) { state.phase = 'completed'; state.detail = '目标区域的新建造厂已确认' }
      else fail(state, '基地已展开，但实际位置不在本次搬迁目标内')
    } else {
      state.phase = 'packing'; state.detail = '收起建造厂并出发'
      if (snap.tick - state.progressTick >= 900) fail(state, '建造厂未能收起，请检查本局是否允许基地重新部署')
    }
    state.form = 'yard'
  } else {
    if (state.form === 'yard') { state.progressTick = snap.tick; delete state.lastActionTick; delete state.lastActionKind }
    state.form = 'vehicle'
    if (arrived) {
      state.phase = state.lastActionKind === 'deploy' ? 'confirming' : 'deploying'
      state.detail = state.phase === 'confirming' ? '等待实际展开成建造厂' : '基地车已抵达，准备展开'
      if (state.lastActionKind === 'deploy' && snap.tick - (state.lastActionTick ?? snap.tick) >= 150) advanceSite(spec, state, snap.tick, '当前位置未能展开，改用区域内另一落点')
    } else {
      state.phase = 'moving'; state.detail = '移动基地车至目标区域'
      if (snap.tick - state.progressTick >= 180) advanceSite(spec, state, snap.tick, '行进未取得进展，尝试区域内另一落点')
    }
  }
  return converted
}

export function relocationView(spec: RelocateGoal, state: RelocationState, snap: Snapshot): NonNullable<GoalView['relocation']> {
  const view: NonNullable<GoalView['relocation']> = { phase: state.phase, unitId: state.unitId, destination: spec.candidates[state.candidate]!, detail: state.detail }
  if (!snap.self.some(unit => unit.id === state.unitId) || ['completed', 'failed', 'confirming'].includes(state.phase) || (state.lastActionTick !== undefined && snap.tick - state.lastActionTick < 30)) return view
  if (state.phase === 'packing' || state.phase === 'moving') view.action = { kind: 'move', unitIds: [state.unitId], ...view.destination }
  else if (state.phase === 'deploying') view.action = { kind: 'deploy', unitIds: [state.unitId] }
  return view
}

export function recordRelocationResult(spec: RelocateGoal, state: RelocationState, request: ActionRequest, results: ActionResult[], tick: number): void {
  if (request.kind !== 'move' && request.kind !== 'deploy') return
  if (results.some(result => result.ok)) { state.lastActionTick = tick; state.lastActionKind = request.kind }
  else if (request.kind === 'deploy' && results.some(result => result.reason === 'deploy-rejected')) advanceSite(spec, state, tick, '当前位置无法展开，改用区域内另一落点')
}
function fail(state: RelocationState, detail: string): void { state.phase = 'failed'; state.detail = detail }
function advanceSite(spec: RelocateGoal, state: RelocationState, tick: number, detail: string): void {
  if (state.candidate + 1 >= spec.candidates.length) { fail(state, '区域内候选落点均未能抵达或展开，搬迁未完成'); return }
  state.candidate++; state.phase = 'moving'; state.progressTick = tick; state.detail = detail
  delete state.lastActionTick; delete state.lastActionKind
}
