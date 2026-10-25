import type { Region, Snapshot, SnapshotUnit } from '@ra2c/contracts'
import type { CommandContext } from '../commands.ts'
import { bindDefaultMap } from '../map-binding.ts'

// 当前游戏的同类项目映射继续沿用；游戏目录与战术拆分在阶段 C 整理。
const PRODUCTION_FAMILIES = [
  ['AMCV', 'SMCV', 'PCV'], ['GACNST', 'NACNST', 'YACNST'], ['GAPOWR', 'NAPOWR', 'YAPOWR'],
  ['GAREFN', 'NAREFN', 'YAREFN'], ['GAPILE', 'NAPILE', 'YAPILE'], ['GAWEAP', 'NAWEAP', 'YAWEAP'],
  ['GAAIRC', 'NARADR', 'YAPSY'], ['GATECH', 'NATECH', 'YATECH'], ['GASPYSAT'], ['MTNK', 'HTNK', 'LTNK'],
]
interface CatalogItem { name: string; type: number; label?: string | undefined; power: number; deploysInto?: string | undefined; available: boolean; faction?: string | undefined }
export class GameCatalog {
  readonly items: CatalogItem[]
  readonly faction: string | undefined
  constructor(readonly all: CatalogItem[], snap: Snapshot) {
    this.faction = snap.self.find(unit => /^(GA|NA|YA)CNST$/.test(unit.name))?.name.slice(0, 2)
      ?? (snap.self.some(unit => unit.name === 'AMCV') ? 'GA' : snap.self.some(unit => unit.name === 'SMCV') ? 'NA' : snap.self.some(unit => unit.name === 'PCV') ? 'YA' : undefined)
    const owned = new Set(snap.self.map(unit => unit.name))
    const rank = (item: CatalogItem) => Number(item.available) * 4 + Number(item.faction === this.faction) * 2 + Number(owned.has(item.name))
    this.items = all.filter(item => !this.faction || !item.faction || item.faction === this.faction || item.available).sort((a, b) => rank(b) - rank(a))
  }
  resolve(target: string): CatalogItem | undefined {
    const normalized = target.trim().toLowerCase()
    const exact = this.items.find(item => item.name.toLowerCase() === normalized)
    if (exact) return exact
    const matches = this.all.filter(item => item.name.toLowerCase() === normalized || item.label?.toLowerCase() === normalized)
    const names = new Set(matches.flatMap(item => PRODUCTION_FAMILIES.find(family => family.includes(item.name)) ?? [item.name]))
    return this.items.find(item => names.has(item.name))
  }
  powerPlant(): CatalogItem | undefined { return this.items.find(item => PRODUCTION_FAMILIES[2]!.includes(item.name) && item.power > 0) }
}

export async function loadGameCatalog(ctx: CommandContext, check: () => void): Promise<GameCatalog> {
  const snap = ctx.runtime.snapshot!
  const names = [...new Set([...PRODUCTION_FAMILIES.flat(), ...snap.self.map(unit => unit.name), ...(snap.production?.available ?? [])])]
  const available = new Set(snap.production?.available ?? [])
  const all = await Promise.all(names.map(async name => {
    const known = snap.self.find(unit => unit.name === name)?.type
    const types = [...new Set([...(known ? [known] : []), 2, 7, 3, 1])]
    for (const type of types) {
      const rule = await ctx.bridge.rules?.(name, type) as { label?: string; power?: number; deploysInto?: string } | undefined
      check()
      if (rule) return { name, type, label: rule.label, power: rule.power ?? 0, deploysInto: rule.deploysInto, available: available.has(name),
        faction: /^(GA|NA|YA)/.exec(name)?.[1] ?? (['AMCV', 'MTNK'].includes(name) ? 'GA' : ['SMCV', 'HTNK'].includes(name) ? 'NA' : ['PCV', 'LTNK'].includes(name) ? 'YA' : undefined) }
    }
    return undefined
  }))
  return new GameCatalog(all.filter((item): item is NonNullable<typeof item> => !!item), snap)
}

const digits = '零一二三四五六七八九'
export function chineseNumber(value: string): number {
  if (/^\d+$/.test(value)) return Number(value)
  if (value === '两') return 2
  if (value.includes('十')) { const [tens, ones] = value.split('十'); return (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0) }
  return digits.indexOf(value)
}
export const normalizeName = (value: string): string => value.normalize('NFKC').replace(/^@/, '').replace(/\s+/g, '').replace(/([1-9])楼/g, (_match, n: string) => `${digits[Number(n)]}楼`)
const formationAlias = (value: string) => normalizeName(value).replace(/^([\d一二三四五六七八九十两]+)队$/, (_match, n: string) => `${chineseNumber(n)}队`)
export function formationName(ctx: CommandContext, value: string, allowNew = false): string {
  const normalized = formationAlias(value)
  const existing = ctx.formations.list().find(formation => formation.id === value.replace(/^@/, ''))
    ?? ctx.formations.list().find(formation => formationAlias(formation.id) === normalized)
  if (existing) return existing.id
  if (allowNew) return normalized
  throw new Error(`编队不存在：${value}`)
}
export function resolveOwner(ctx: CommandContext, token: string): string {
  if (token === 'global' || ctx.runtime.programs.has(token)) return token
  const named = ctx.formations.list().find(formation => formationAlias(formation.id) === formationAlias(token))
  const owner = named ? `formation:${named.id}` : ''
  if (named) return owner
  const goal = [...ctx.runtime.goals.values()].reverse().find(goal => goal.spec.id === token || goal.spec.label === token)
  if (goal) return goal.ownerId
  throw new Error(`控制对象或任务标签不存在：${token}`)
}

export function selectUnits(ctx: CommandContext, params: { selector?: string; unitIds?: number[]; sourceFormationId?: string }, catalog?: GameCatalog): SnapshotUnit[] {
  const snap = ctx.runtime.snapshot!
  const source = params.sourceFormationId ? formationName(ctx, params.sourceFormationId) : undefined
  const explicit = params.unitIds ? new Set(params.unitIds) : undefined
  const selector = normalizeName(params.selector ?? 'all').toLowerCase()
  const rule = catalog?.resolve(selector)
  return snap.self.filter(unit => {
    if (source && ctx.formations.ownerOf(unit.id) !== source) return false
    if (explicit) return explicit.has(unit.id)
    if (['all', '全部', '所有单位'].includes(selector)) return [1, 3, 7].includes(unit.type)
    if (['infantry', '步兵', '所有步兵'].includes(selector)) return unit.type === 3
    if (['vehicles', '车辆', '所有车辆'].includes(selector)) return unit.type === 7
    if (['aircraft', '空军', '飞机'].includes(selector)) return unit.type === 1
    if (['tanks', '坦克', '所有坦克'].includes(selector)) return unit.type === 7 && (/^(MTNK|HTNK|LTNK|GTNK|TTNK|APOC|MGTK|TNKD|DMTK|YTNK)$/.test(unit.name) || /tank|坦克/i.test(catalog?.all.find(item => item.name === unit.name)?.label ?? ''))
    return unit.name.toLowerCase() === selector || unit.name === rule?.name || catalog?.all.find(item => item.name === unit.name)?.label?.toLowerCase() === selector
  }).sort((a, b) => Number(!!ctx.formations.ownerOf(a.id)) - Number(!!ctx.formations.ownerOf(b.id)) || a.id - b.id)
}

export function checkPoint(snap: Snapshot, x: number, y: number): void {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= snap.mapWidth || y >= snap.mapHeight) throw new Error('目的地坐标不在当前地图内')
}
export const fullMap = (snap: Snapshot): Region => ({ name: '沿途与全图作战', x1: 0, y1: 0, x2: snap.mapWidth - 1, y2: snap.mapHeight - 1 })
export function rectangle(snap: Snapshot, bounds: number[]): Region {
  if (bounds.length !== 4) throw new Error('活动地域须为 x1,y1,x2,y2')
  const [x1, y1, x2, y2] = bounds as [number, number, number, number]
  checkPoint(snap, x1, y1); checkPoint(snap, x2, y2)
  if (x1 > x2 || y1 > y2) throw new Error('活动地域范围非法')
  return { name: '显式活动区', x1, y1, x2, y2 }
}
export async function regionDestination(ctx: CommandContext, name: string, check: () => void) {
  await bindDefaultMap(ctx)
  check()
  const index = ctx.mapRegions
  const region = index?.resolve(normalizeName(name)) ?? index?.resolve(name)
  if (!index || !region) throw new Error(`冰天雪地分区中未找到地名：${name}`)
  const [lx, ly] = region.labelPosition
  for (let radius = 0; radius <= 20; radius++) for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) {
    const x = Math.round(lx) + dx, y = Math.round(ly) + dy
    if ([-1, 0, 1].every(a => [-1, 0, 1].every(b => index.regionsAt(x + a, y + b).some(item => item.id === region.id)))) {
      checkPoint(ctx.runtime.snapshot!, x, y)
      return { region, destination: { x, y, name: region.name } }
    }
  }
  throw new Error('未找到分区内部的候选目的地')
}
export async function destination(ctx: CommandContext, params: { regionName?: string; x?: number; y?: number }, check: () => void) {
  if (params.regionName) return (await regionDestination(ctx, params.regionName, check)).destination
  if (params.x === undefined || params.y === undefined) throw new Error('缺少目的地分区或完整坐标')
  checkPoint(ctx.runtime.snapshot!, params.x, params.y)
  return { x: params.x, y: params.y }
}
