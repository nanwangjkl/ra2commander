import type { ActionRequest, Snapshot, SnapshotUnit } from '@ra2c/contracts'
import type { FactorySite, RallySetting } from './factory-rally.ts'
import type { ProductionRecord } from './state.ts'

export interface ExitUnit {
  unitId: number; name: string; type: number; born: { x: number; y: number }
  factoryId?: number; point?: { x: number; y: number }
  phase: 'exiting' | 'rallying' | 'ready'
  position: { x: number; y: number }; progressAt: number; attempts: number
  sentAt?: number; halted?: boolean; detail?: string
}
export interface ExitBlockage {
  factoryId: number; unitId: number; attempts: number; lastAttempt?: number
  state: 'blocked' | 'clearing' | 'recovered' | 'unresolved'; detail: string
}
export interface ExitYield {
  unitId: number; factoryId: number; point: { x: number; y: number }; sentAt: number
  owner: string; revision: number; generation: number
  resume?: { goalId: string; request: ActionRequest }
}
export interface ProductionExitState { units: ExitUnit[]; blockages: ExitBlockage[]; yields: ExitYield[] }
export const emptyProductionExits = (): ProductionExitState => ({ units: [], blockages: [], yields: [] })
export const insideFactory = (unit: { rx: number; ry: number }, site: FactorySite) => !!site.foundation && unit.rx >= site.x && unit.ry >= site.y && unit.rx < site.x + site.foundation.width && unit.ry < site.y + site.foundation.height
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)
const mobile = (unit: SnapshotUnit) => (unit.type === 3 || unit.type === 7) && unit.zone !== 1 && !unit.harvester && !unit.naval
export const exitPoint = (site: FactorySite) => ({ x: site.x + (site.foundation?.width ?? 1), y: site.y + Math.floor((site.foundation?.height ?? 1) / 2) })
/** 出口周围两格仍可能挡住后续产物，不能用四格到达容差提前放行。 */
export const inFactoryExit = (unit: { rx: number; ry: number }, site: FactorySite) => insideFactory(unit, site) || distance({ x: unit.rx, y: unit.ry }, exitPoint(site)) <= 2

/** 产物身份先记账，抵达集结点才释放给编队、攻击及 Skill。 */
export class ProductionExits {
  state = emptyProductionExits()
  private restored = false
  private legacy = new Map<number, { x: number; y: number; since: number }>()
  reset(): void { this.state = emptyProductionExits(); this.restored = false; this.legacy.clear() }
  restore(state: ProductionExitState): void { this.state = structuredClone(state); this.restored = true }
  waiting(id: number): boolean { return this.state.units.some(unit => unit.unitId === id && unit.phase !== 'ready') }
  locked(id: number): boolean { return this.waiting(id) || this.state.yields.some(order => order.unitId === id) }
  halt(ids: number[]): void { for (const unit of this.state.units) if (ids.includes(unit.unitId)) unit.halted = true }
  unhalt(ids: number[]): void { for (const unit of this.state.units) if (ids.includes(unit.unitId)) delete unit.halted }
  /** 原位置被永久障碍占据时，只有尚未就绪的同批成员改去新点。 */
  relocatePending(factoryId: number, before: { x: number; y: number }, after: { x: number; y: number }, snap: Snapshot): void {
    for (const job of this.state.units) {
      if (job.factoryId !== factoryId || job.phase === 'ready' || job.point?.x !== before.x || job.point.y !== before.y) continue
      job.point = { ...after }; job.progressAt = snap.time; job.attempts = 0; delete job.sentAt
      job.detail = '原集结点有障碍，等待抵达更换后的开阔位置'
    }
  }
  observe(snap: Snapshot, sites: FactorySite[], settings: RallySetting[], seen: ReadonlySet<number>, production: readonly ProductionRecord[], converted: ReadonlySet<number>, paused: boolean, clear: (point: { x: number; y: number }) => boolean = () => true): void {
    this.state.units = this.state.units.filter(job => snap.self.some(unit => unit.id === job.unitId && unit.name === job.name && mobile(unit)))
    this.state.yields = this.state.yields.filter(order => snap.self.some(unit => unit.id === order.unitId))
    this.state.blockages = this.state.blockages.filter(block => sites.some(site => site.id === block.factoryId) || !sites.length)
    for (const unit of snap.self) {
      if (!mobile(unit) || converted.has(unit.id) || this.state.units.some(job => job.unitId === unit.id)) continue
      const newlyProduced = !seen.has(unit.id) && production.some(record => !record.building && record.name === unit.name && record.state !== 'rejected')
      // 也接住接管前卡在厂内或旧版本已过早编队的存活单位。
      const inFactory = sites.some(site => site.factory === (unit.type === 3 ? 2 : 3) && insideFactory(unit, site))
      if (!newlyProduced) {
        if (!inFactory) { this.legacy.delete(unit.id); continue }
        let observation = this.legacy.get(unit.id)
        if (!observation || paused || snap.time < observation.since || Math.hypot(unit.rx - observation.x, unit.ry - observation.y) >= 1) {
          observation = { x: unit.rx, y: unit.ry, since: snap.time }; this.legacy.set(unit.id, observation)
        }
        if (snap.time - observation.since < 3) continue
      }
      const progressAt = newlyProduced ? snap.time : this.legacy.get(unit.id)!.since
      this.state.units.push({ unitId: unit.id, name: unit.name, type: unit.type, born: { x: unit.rx, y: unit.ry }, position: { x: unit.rx, y: unit.ry }, phase: 'exiting', progressAt, attempts: 0 })
      this.legacy.delete(unit.id)
    }
    for (const job of this.state.units) {
      if (job.phase === 'ready') continue
      const unit = snap.self.find(unit => unit.id === job.unitId)!
      if (this.restored || paused || snap.time < job.progressAt) { job.progressAt = snap.time; job.position = { x: unit.rx, y: unit.ry }; delete job.sentAt }
      if (!job.factoryId) {
        const candidates = sites.filter(site => site.factory === (job.type === 3 ? 2 : 3) && site.foundation && (insideFactory({ rx: job.born.x, ry: job.born.y }, site) || distance(job.born, exitPoint(site)) <= 8))
          .sort((a, b) => Number(insideFactory({ rx: job.born.x, ry: job.born.y }, b)) - Number(insideFactory({ rx: job.born.x, ry: job.born.y }, a)) || distance(job.born, exitPoint(a)) - distance(job.born, exitPoint(b)))
        const source = candidates[0]
        if (source && !(candidates[1] && insideFactory({ rx: job.born.x, ry: job.born.y }, source) === insideFactory({ rx: job.born.x, ry: job.born.y }, candidates[1]) && distance(job.born, exitPoint(source)) === distance(job.born, exitPoint(candidates[1])))) job.factoryId = source.id
      }
      const factory = sites.find(site => site.id === job.factoryId)
      if (!job.point && factory) {
        const setting = settings.find(setting => setting.factoryId === factory.id && setting.point && ['submitted', 'unknown'].includes(setting.status))
        if (setting?.point) job.point = { ...setting.point }
      }
      const point = { x: unit.rx, y: unit.ry }
      if (distance(point, job.position) >= 1) { job.position = point; job.progressAt = snap.time }
      const outside = factory ? !inFactoryExit(unit, factory) : job.factoryId !== undefined && !snap.self.some(unit => unit.id === job.factoryId)
      if (job.point && clear(job.point) && outside && distance(point, job.point) <= 4 && (unit.isIdle || snap.time - job.progressAt >= 1)) {
        job.phase = 'ready'; job.detail = '已抵达集结点'
        continue
      }
      job.phase = factory && insideFactory(unit, factory) ? 'exiting' : 'rallying'
      job.detail = !job.point ? '等待确认生产建筑及集结点' : job.phase === 'exiting' ? '等待驶出生产建筑并抵达集结点' : '前往集结点，暂不交接'
      if (factory && snap.time - job.progressAt >= 3 && !paused && !job.halted) {
        if (job.phase === 'exiting') {
          const previous = this.state.blockages.find(block => block.factoryId === factory.id)
          if (!previous || previous.state === 'recovered') {
            this.state.blockages = this.state.blockages.filter(block => block.factoryId !== factory.id)
            this.state.blockages.push({ factoryId: factory.id, unitId: job.unitId, attempts: 0, state: 'blocked', detail: `#${job.unitId} 在生产建筑内部持续无位移，等待疏通出口` })
          }
        } else job.detail = job.attempts >= 3 ? '集结受阻，重试已用尽' : '前往集结点受阻，准备有限重试'
      }
    }
    this.restored = false
    for (const id of this.legacy.keys()) if (!snap.self.some(unit => unit.id === id)) this.legacy.delete(id)
    for (const block of this.state.blockages) {
      const unit = this.state.units.find(job => job.unitId === block.unitId), site = sites.find(site => site.id === block.factoryId), live = snap.self.find(item => item.id === block.unitId)
      if (!unit || unit.phase === 'ready' || site && live && !insideFactory(live, site)) { block.state = 'recovered'; block.detail = '受阻车辆已离开厂内，继续前往集结点' }
    }
  }
}

export function validateProductionExits(state: ProductionExitState, snap: Snapshot): void {
  if (!state || !Array.isArray(state.units) || !Array.isArray(state.blockages) || !Array.isArray(state.yields) || new Set(state.units.map(unit => unit.unitId)).size !== state.units.length || new Set(state.yields.map(order => order.unitId)).size !== state.yields.length) throw new Error('出厂交接状态非法')
  const point = (p: { x: number; y: number }) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x < snap.mapWidth && p.y < snap.mapHeight
  for (const unit of state.units) if (!Number.isSafeInteger(unit.unitId) || !unit.name || ![3, 7].includes(unit.type) || !point(unit.born) || !point(unit.position) || unit.point && !point(unit.point) || !['exiting', 'rallying', 'ready'].includes(unit.phase) || !Number.isFinite(unit.progressAt) || !Number.isSafeInteger(unit.attempts) || unit.attempts < 0 || unit.factoryId !== undefined && !Number.isSafeInteger(unit.factoryId) || unit.sentAt !== undefined && !Number.isFinite(unit.sentAt) || unit.halted !== undefined && typeof unit.halted !== 'boolean') throw new Error('出厂成员进度非法')
  for (const block of state.blockages) if (!Number.isSafeInteger(block.factoryId) || !Number.isSafeInteger(block.unitId) || !Number.isSafeInteger(block.attempts) || block.attempts < 0 || !['blocked', 'clearing', 'recovered', 'unresolved'].includes(block.state) || block.lastAttempt !== undefined && !Number.isFinite(block.lastAttempt) || typeof block.detail !== 'string') throw new Error('出口疏通进度非法')
  for (const order of state.yields) if (!Number.isSafeInteger(order.unitId) || !Number.isSafeInteger(order.factoryId) || !point(order.point) || !Number.isFinite(order.sentAt) || !order.owner || !Number.isSafeInteger(order.revision) || !Number.isSafeInteger(order.generation) || order.resume && (!order.resume.goalId || !order.resume.request || !['move', 'attack', 'attackMove', 'gather', 'guard'].includes(order.resume.request.kind))) throw new Error('出口让路记录非法')
}
