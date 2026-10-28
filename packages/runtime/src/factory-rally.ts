import { inTargetRegion, validTargetRegion, validateActions, type ActionRequest, type ActionResult, type Snapshot, type TargetRegion } from '@ra2c/contracts'

/** 占地来源为当前游戏目录的 art.ini；factory 使用本局公开规则。 */
export interface FactorySite {
  id: number; name: string; x: number; y: number; elevation?: number
  foundation?: { width: number; height: number }
  factory: number
}
export interface RallySetting {
  factoryId: number; name: string; origin: { x: number; y: number }
  point?: { x: number; y: number }
  source: 'automatic' | 'player'
  commandId?: string
  status: 'prepared' | 'submitted' | 'unknown' | 'failed'
  attempts: number; tick: number; reason?: string
  region?: TargetRegion
}
export interface FactoryRallyState { enabled: boolean; settings: RallySetting[] }
export interface FactoryRallyDeps {
  current(): Snapshot | undefined
  sites(snap: Snapshot): Promise<FactorySite[]>
  tiles(points: Array<{ x: number; y: number }>, snap: Snapshot): Promise<Array<{ x: number; y: number; z: number; landType: number }>>
  submit(action: ActionRequest, snap: Snapshot, guard: () => boolean): Promise<ActionResult[]>
  checkpoint(): void | Promise<void>
  automaticAllowed(): boolean
  /** 地图有效范围及初始树石的统一 3×3 排除；无补丁的游戏可省略。 */
  clear?(point: { x: number; y: number }): boolean
  notify?(setting: RallySetting): void
  relocated?(factoryId: number, before: { x: number; y: number }, after: { x: number; y: number }, snap: Snapshot): void
}
const sameSite = (setting: RallySetting, site: FactorySite) => setting.factoryId === site.id && setting.name === site.name && setting.origin.x === site.x && setting.origin.y === site.y
const inFootprint = (x: number, y: number, site: FactorySite, margin = 0) => x >= site.x - margin && y >= site.y - margin && x < site.x + (site.foundation?.width ?? 1) + margin && y < site.y + (site.foundation?.height ?? 1) + margin

/** 有界候选；车辆使用真实出口，兵营使用占地外侧参照，向两侧扩展。 */
export function rallyCandidates(factory: FactorySite, sites: FactorySite[], snap: Snapshot, reserved: RallySetting[]): Array<{ x: number; y: number }> {
  if (!factory.foundation) return []
  const exit = { x: factory.x + factory.foundation.width, y: factory.y + Math.floor(factory.foundation.height / 2) }
  const candidates = []
  for (let dx = 2; dx <= 8; dx++) for (let dy = -8; dy <= 8; dy++) {
    const distance = Math.hypot(dx, dy), x = exit.x + dx, y = exit.y + dy
    if (distance < 4 || distance > 8 || x < 0 || y < 0 || x >= snap.mapWidth || y >= snap.mapHeight) continue
    if (sites.some(site => inFootprint(x, y, site, site.foundation ? 1 : 2) || site.factory === 3 && site.foundation && Math.hypot(x - site.x - site.foundation.width, y - site.y - Math.floor(site.foundation.height / 2)) < 3)) continue
    if (snap.self.some(unit => unit.type !== 2 && unit.type !== 1 && unit.zone !== 1 && Math.hypot(unit.rx - x, unit.ry - y) < 2)) continue
    if (reserved.some(setting => setting.factoryId !== factory.id && setting.point && Math.hypot(setting.point.x - x, setting.point.y - y) < 3)) continue
    candidates.push({ x, y, score: Math.abs(distance - 5) + Math.abs(dy) / 2 })
  }
  return candidates.sort((a, b) => a.score - b.score).slice(0, 128).map(({ x, y }) => ({ x, y }))
}

/** 一次设置不占用编队／生产脚本；发令经过同局、对象和本次设置身份复查。 */
export class FactoryRallies {
  state: FactoryRallyState = { enabled: false, settings: [] }
  knownSites: FactorySite[] = []
  private siteKey = ''
  private polledAt = -Infinity
  private staticChecked = new WeakSet<RallySetting>()
  constructor(private readonly deps: FactoryRallyDeps) {}
  reset(): void { this.state = { enabled: false, settings: [] }; this.knownSites = []; this.siteKey = ''; this.polledAt = -Infinity; this.staticChecked = new WeakSet() }
  clear = (point: { x: number; y: number }): boolean => this.deps.clear?.(point) ?? true
  async sites(snap: Snapshot): Promise<FactorySite[]> {
    const sites = await this.deps.sites(snap)
    if (this.deps.current()?.sessionKey === snap.sessionKey) this.knownSites = sites
    return sites
  }
  private prune(snap: Snapshot): void {
    this.state.settings = this.state.settings.filter(setting => snap.self.some(unit => unit.type === 2 && unit.id === setting.factoryId && unit.name === setting.name && unit.rx === setting.origin.x && unit.ry === setting.origin.y))
  }
  async point(factory: FactorySite, sites: FactorySite[], snap: Snapshot, extra: Array<{ x: number; y: number }> = []): Promise<{ x: number; y: number } | undefined> {
    const candidates = rallyCandidates(factory, sites, snap, this.state.settings).filter(point => extra.every(other => Math.hypot(point.x - other.x, point.y - other.y) >= 2))
    if (!candidates.length) return undefined
    return (await this.open(candidates, sites, snap, false, false, factory.elevation))[0]
  }
  private nearby(setting: RallySetting, sites: FactorySite[], snap: Snapshot): Array<{ x: number; y: number }> {
    const center = setting.point!, points: Array<{ x: number; y: number }> = []
    for (let radius = 1; radius <= 8; radius++) for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
      const x = center.x + dx, y = center.y + dy
      if (x < 1 || y < 1 || x >= snap.mapWidth - 1 || y >= snap.mapHeight - 1 || !this.clear({ x, y }) || setting.region && !inTargetRegion(x, y, setting.region) || sites.some(site => inFootprint(x, y, site, site.foundation ? 1 : 2))) continue
      points.push({ x, y })
      if (points.length === 64) return points
    }
    return points
  }
  /** 开阔地按 3×3 地形及建筑占地检查；单位的临时停留不算永久障碍。 */
  private async open(points: Array<{ x: number; y: number }>, sites: FactorySite[], snap: Snapshot, naval = false, allowUnknown = false, elevation?: number): Promise<Array<{ x: number; y: number }>> {
    const candidates = points.filter(point => point.x >= 1 && point.y >= 1 && point.x < snap.mapWidth - 1 && point.y < snap.mapHeight - 1 && this.clear(point) && !sites.some(site => inFootprint(point.x, point.y, site, site.foundation ? 1 : 2)))
    const cells = [...new Map(candidates.flatMap(point => [-1, 0, 1].flatMap(dx => [-1, 0, 1].map(dy => ({ x: point.x + dx, y: point.y + dy })))).map(point => [`${point.x},${point.y}`, point])).values()]
    const tiles = new Map<string, { z: number; landType: number }>()
    for (let start = 0; start < cells.length; start += 128) for (const tile of await this.deps.tiles(cells.slice(start, start + 128), snap)) tiles.set(`${tile.x},${tile.y}`, tile)
    return candidates.filter(point => {
      const center = tiles.get(`${point.x},${point.y}`)
      return (!!center || allowUnknown) && (elevation === undefined || !center || center.z === elevation) && [-1, 0, 1].every(dx => [-1, 0, 1].every(dy => {
        const tile = tiles.get(`${point.x + dx},${point.y + dy}`)
        return !tile ? allowUnknown : (!center || tile.z === center.z) && (naval ? tile.landType === 7 : ![2, 7, 8, 10].includes(tile.landType))
      }))
    })
  }
  /** 每次入队前调用，不占用生产额度；无法换点时延后本项，其他目标继续。 */
  async beforeProduction(queueType: number, snap: Snapshot, valid: () => boolean): Promise<{ ok: boolean; reason?: string }> {
    const kind = ({ 2: 2, 3: 3, 5: 4 } as Record<number, number>)[queueType]
    if (kind === undefined) return { ok: true }
    const check = () => { if (!valid() || this.deps.current()?.sessionKey !== snap.sessionKey) throw new Error('生产前集结点检查已失效') }
    const sites = await this.sites(snap); check()
    for (const factory of sites.filter(site => site.factory === kind)) {
      const previous = this.state.settings.find(setting => sameSite(setting, factory))
      // 未托管的船厂保留原生设置；地面重工与兵营必须先建立可检查的目的地。
      if (!previous && kind === 4) continue
      if (previous?.point && ['submitted', 'unknown'].includes(previous.status)) {
        // 黑幕不是已知障碍；不能因为远处未探开就让玩家指定的集结点阻断生产。
        const available = (await this.open([previous.point], sites, snap, kind === 4, previous.source === 'player')).length > 0
        check()
        if (this.state.settings.find(setting => setting.factoryId === factory.id) !== previous) return { ok: false, reason: '集结点已被新命令修改，按最新设置重查' }
        if (available) continue
      }
      check()
      const candidates = previous?.source === 'player' && previous.point ? this.nearby(previous, sites, snap) : rallyCandidates(factory, sites, snap, this.state.settings).filter(point => this.clear(point)).slice(0, 64)
      const [point] = await this.open(candidates, sites, snap, kind === 4, false, previous?.source === 'player' ? undefined : factory.elevation); check()
      if (this.state.settings.find(setting => setting.factoryId === factory.id) !== previous) return { ok: false, reason: '集结点已被新命令修改，按最新设置重查' }
      if (!point) return { ok: false, reason: `${factory.name} #${factory.id} 集结点不是开阔地带，附近暂无可用位置，等待换点后生产` }
      const setting = await this.set(factory, point, previous?.source ?? 'automatic', snap, check, previous?.commandId, previous?.region, previous?.point)
      if (setting.status !== 'submitted') return { ok: false, reason: `${factory.name} #${factory.id} 新集结点尚未确认提交：${setting.reason ?? setting.status}` }
      setting.reason = previous?.point ? '生产前发现原集结点被占用或地形不再开阔，已更换附近位置' : '生产前初始化开阔集结点'
      await this.deps.checkpoint(); this.deps.notify?.(setting); check()
    }
    return { ok: true }
  }
  async set(factory: FactorySite, point: { x: number; y: number } | undefined, source: RallySetting['source'], snap: Snapshot, check: () => void = () => {}, commandId?: string, region?: TargetRegion, relocatedFrom?: { x: number; y: number }): Promise<RallySetting> {
    check()
    if (this.deps.current()?.sessionKey !== snap.sessionKey) throw new Error('集结点设置对局已变化')
    const previous = this.state.settings.find(setting => sameSite(setting, factory))
    const setting: RallySetting = { factoryId: factory.id, name: factory.name, origin: { x: factory.x, y: factory.y }, ...(point ? { point } : {}), source, ...(commandId ? { commandId } : {}), status: point ? 'prepared' : 'failed', attempts: source === 'automatic' ? (previous?.attempts ?? 0) + 1 : 1, tick: snap.tick,
      ...(region ? { region: structuredClone(region) } : {}),
      ...(!point ? { reason: factory.foundation ? '附近没有已知可用集结位置' : '缺少可靠的建筑占地，未猜测默认集结位置' } : {}) }
    this.state.settings = this.state.settings.filter(item => item.factoryId !== factory.id)
    this.state.settings.push(setting)
    if (!point) return setting
    const action: ActionRequest = { kind: 'setRallyPoint', unitIds: [factory.id], ...point }
    const error = region && !inTargetRegion(point.x, point.y, region) ? '集结点不在指定分区内' : validateActions([action], { allowedUnitIds: [factory.id], factoryRallyIds: [factory.id], allowedActions: ['setRallyPoint'], enemyIds: [], mapWidth: snap.mapWidth, mapHeight: snap.mapHeight }, snap)
    if (error) { setting.status = 'failed'; setting.reason = error; return setting }
    // 原点已被证明不可用：准备状态和待集结成员的改点必须同次保存，
    // 避免设置成功后重启，仍有旧产物等待一个已被建筑占据的位置。
    if (relocatedFrom) this.deps.relocated?.(factory.id, relocatedFrom, point, snap)
    const valid = () => {
      check()
      return (source !== 'automatic' || this.deps.automaticAllowed()) && this.deps.current()?.sessionKey === snap.sessionKey && this.state.settings.includes(setting) && this.deps.current()!.self.some(unit => unit.type === 2 && unit.id === factory.id && unit.name === factory.name && unit.rx === factory.x && unit.ry === factory.y)
    }
    let sending = false
    try {
      await this.deps.checkpoint()
      if (!valid()) { setting.status = 'failed'; setting.reason = '设置已失效或建筑已离场'; return setting }
      sending = true
      const results = await this.deps.submit(action, snap, valid)
      if (this.state.settings.includes(setting)) {
        setting.status = results.length === 1 && results[0]!.ok && results[0]!.submitted === 1 ? 'submitted' : 'failed'
        if (setting.status === 'failed') setting.reason = results[0]?.reason ?? '集结点动作未提交'
      }
    } catch (error) {
      // 可能已进入锁步队列；未知回执不自动重发覆盖玩家后来的设置。
      if (this.state.settings.includes(setting)) { setting.status = sending ? 'unknown' : 'failed'; setting.reason = String(error).slice(0, 160) }
    }
    await this.deps.checkpoint()
    check()
    return setting
  }
  async configure(ids: number[], point: { x: number; y: number } | undefined, commandId: string, check: () => void, region?: TargetRegion): Promise<RallySetting[]> {
    const snap = this.deps.current()
    if (!snap) throw new Error('请先进入对局')
    if (!ids.length || new Set(ids).size !== ids.length) throw new Error('生产建筑选择为空或重复')
    const sites = await this.sites(snap); check()
    const results: RallySetting[] = []
    for (const id of ids) {
      const factory = sites.find(site => site.id === id && [2, 3, 4].includes(site.factory))
      if (!factory) throw new Error(`建筑 #${id} 不支持生产集结点`)
      let destination = point ? (await this.open([point], sites, snap, factory.factory === 4, true))[0] : await this.point(factory, sites, snap)
      check()
      if (point && !destination) {
        const reference: RallySetting = { factoryId: id, name: factory.name, origin: { x: factory.x, y: factory.y }, point, source: 'player', commandId, status: 'prepared', attempts: 1, tick: snap.tick, ...(region ? { region } : {}) }
        destination = (await this.open(this.nearby(reference, sites, snap), sites, snap, factory.factory === 4, true))[0]
        check()
      }
      const setting = await this.set(factory, destination, 'player', snap, check, commandId, region)
      if (point && destination && (point.x !== destination.x || point.y !== destination.y)) setting.reason = '指定位置周围有障碍，已在附近选择开阔集结点'
      results.push(setting)
    }
    await this.deps.checkpoint()
    return results
  }
  async poll(snap: Snapshot): Promise<void> {
    this.prune(snap)
    const siteKey = JSON.stringify(snap.self.filter(unit => unit.type === 2).map(unit => [unit.id, unit.name, unit.rx, unit.ry, unit.elevation]))
    if (siteKey !== this.siteKey) { await this.sites(snap); if (this.deps.current()?.sessionKey !== snap.sessionKey) return; this.siteKey = siteKey }
    if (!this.state.enabled && !this.state.settings.some(setting => setting.point && !this.staticChecked.has(setting))) return
    if (!this.deps.automaticAllowed() || snap.tick - this.polledAt < 30) return
    this.polledAt = snap.tick
    const sites = this.knownSites
    if (this.deps.current()?.sessionKey !== snap.sessionKey) return
    let budget = 2
    // 新补丁加载／同局恢复后也检查旧点，不依赖还有下一批生产。
    for (const previous of [...this.state.settings]) {
      if (!previous.point || this.staticChecked.has(previous)) continue
      if (this.clear(previous.point)) { this.staticChecked.add(previous); continue }
      const factory = sites.find(site => sameSite(previous, site))
      if (!factory) continue
      const candidates = previous.source === 'player' ? this.nearby(previous, sites, snap) : rallyCandidates(factory, sites, snap, this.state.settings)
      const [point] = await this.open(candidates, sites, snap, factory.factory === 4, false, previous.source === 'automatic' ? factory.elevation : undefined)
      if (this.deps.current()?.sessionKey !== snap.sessionKey || this.state.settings.find(setting => setting.factoryId === factory.id) !== previous) continue
      this.staticChecked.add(previous)
      if (!point) {
        previous.status = 'failed'
        previous.reason = '原集结点周围有静态树石障碍，附近暂无已知开阔位置，等待换点'
        await this.deps.checkpoint(); this.deps.notify?.(previous)
      } else {
        const check = () => { if (!this.deps.automaticAllowed()) throw new Error('集结点复查已暂停') }
        const setting = await this.set(factory, point, previous.source, snap, check, previous.commandId, previous.region, previous.point)
        if (setting.status === 'submitted') setting.reason = '原集结点周围有静态树石障碍，已更换开阔位置并更新待集结成员'
        await this.deps.checkpoint(); this.deps.notify?.(setting)
      }
      if (--budget === 0) return
    }
    if (!this.state.enabled) return
    for (const site of sites.filter(site => site.factory === 3 || site.factory === 2)) {
      const previous = this.state.settings.find(setting => sameSite(setting, site))
      if (previous && (previous.point && !this.clear(previous.point) || previous.source === 'player' || previous.status !== 'failed' || previous.attempts >= 3 || snap.tick - previous.tick < 150)) continue
      const destination = await this.point(site, sites, snap)
      // 地形查询期间可能到达新的语音设置；自动设置不能覆盖它。
      if (this.deps.current()?.sessionKey !== snap.sessionKey || this.state.settings.find(setting => setting.factoryId === site.id) !== previous) continue
      const setting = await this.set(site, destination, 'automatic', snap)
      this.deps.notify?.(setting)
      if (--budget === 0) break
    }
  }
}

export function validateFactoryRallies(state: FactoryRallyState, snap: Snapshot): void {
  if (!state || typeof state.enabled !== 'boolean' || !Array.isArray(state.settings) || new Set(state.settings.map(setting => setting.factoryId)).size !== state.settings.length) throw new Error('生产建筑集结状态非法')
  for (const setting of state.settings) if (!Number.isSafeInteger(setting.factoryId) || !setting.name || !setting.origin || ![setting.origin.x, setting.origin.y, setting.point?.x ?? 0, setting.point?.y ?? 0].every(Number.isSafeInteger) || setting.point && (setting.point.x < 0 || setting.point.y < 0 || setting.point.x >= snap.mapWidth || setting.point.y >= snap.mapHeight) || !['automatic', 'player'].includes(setting.source) || !['prepared', 'submitted', 'unknown', 'failed'].includes(setting.status) || !Number.isSafeInteger(setting.attempts) || setting.attempts < 1 || !Number.isFinite(setting.tick) || setting.status !== 'failed' && !setting.point) throw new Error('生产建筑集结记录非法')
  for (const setting of state.settings) if (setting.region && !validTargetRegion(setting.region)) throw new Error('生产集结分区非法')
}
