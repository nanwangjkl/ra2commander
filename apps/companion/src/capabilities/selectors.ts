import type { Region, Snapshot, SnapshotUnit } from '@ra2c/contracts'
import type { CommandContext } from '../commands.ts'
import { bindDefaultMap } from '../map-binding.ts'

import type { GameProfile } from '@ra2c/command'
import { resolveUnitSelection, type SelectionPolicy, type SelectionQuery } from '../unit-selection.ts'
import { GameCatalog } from '../game-catalog.ts'
export { GameCatalog, loadGameCatalog } from '../game-catalog.ts'

const digits = '零一二三四五六七八九'
export function chineseNumber(value: string): number {
  if (/^\d+$/.test(value)) return Number(value)
  if (value === '两') return 2
  if (value.includes('十')) { const [tens, ones] = value.split('十'); return (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0) }
  return digits.indexOf(value)
}
export const normalizeName = (value: string): string => value.normalize('NFKC').replace(/^@/, '').replace(/\s+/g, '').replace(/([1-9])楼/g, (_match, n: string) => `${digits[Number(n)]}楼`)
export const formationAlias = (value: string) => normalizeName(value).replace(/^([\d一二三四五六七八九十两]+)队$/, (_match, n: string) => `${chineseNumber(n)}队`)
export function formationName(ctx: CommandContext, value: string, allowNew = false, allowPending = false): string {
  const normalized = formationAlias(value)
  const existing = ctx.formations.list().find(formation => formation.id === value.replace(/^@/, ''))
    ?? ctx.formations.list().find(formation => formationAlias(formation.id) === normalized)
  if (existing) return existing.id
  if (allowPending && ctx.runtime.hasPlannedFormation(normalized)) return normalized
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

export { isCombatUnit, isRepairVehicle } from '../unit-selection.ts'
export function selectUnitSet(ctx: CommandContext, params: SelectionQuery & { sourceFormationId?: string }, catalog?: GameCatalog, profile?: GameProfile, policy: SelectionPolicy = {}) {
  const sourceFormationId = params.sourceFormationId ? formationName(ctx, params.sourceFormationId) : undefined
  return resolveUnitSelection(ctx, params, catalog, profile, { ...policy, ...(sourceFormationId ? { sourceFormationId } : {}) })
}
export function selectUnits(ctx: CommandContext, params: { selector?: string; unitIds?: number[]; sourceFormationId?: string }, catalog?: GameCatalog, profile?: GameProfile): SnapshotUnit[] {
  const { selector, unitIds, sourceFormationId } = params
  return selectUnitSet(ctx, { ...(selector ? { selector } : {}), ...(unitIds ? { unitIds } : {}), ...(sourceFormationId ? { sourceFormationId } : {}) }, catalog, profile).selected
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
export async function destination(ctx: CommandContext, params: { regionName?: string; x?: number; y?: number }, check: () => void, catalog?: GameCatalog | (() => Promise<GameCatalog>)) {
  if (params.regionName && /^(?:我方)?(?:基地|家)(?:附近|旁边|周围|里)?$/.test(normalizeName(params.regionName))) {
    const known = typeof catalog === 'function' ? await catalog() : catalog
    const snap = ctx.runtime.snapshot!
    const own = snap.self.slice().sort((a, b) => a.id - b.id)
    const base = own.find(unit => known?.isRole(unit.name, 'constructionYard', unit.type))
      ?? own.find(unit => known?.isRole(unit.name, 'constructionVehicle', unit.type))
    if (!base) throw new Error('当前未找到己方建造厂或基地车')
    check()
    return { x: Math.min(snap.mapWidth - 1, Math.max(0, Math.round(base.rx + 4))), y: Math.min(snap.mapHeight - 1, Math.max(0, Math.round(base.ry + 4))), name: '基地附近' }
  }
  if (params.regionName) return (await regionDestination(ctx, params.regionName, check)).destination
  if (params.x === undefined || params.y === undefined) throw new Error('缺少目的地分区或完整坐标')
  checkPoint(ctx.runtime.snapshot!, params.x, params.y)
  return { x: params.x, y: params.y }
}
