import { gameAlgorithms } from './game-algorithms.ts'

export interface TargetRegion {
  id: string
  name: string
  polygons: Array<{ outer: [number, number][]; holes: [number, number][][] }>
}
export function validTargetRegion(region: TargetRegion): boolean {
  const ring = (value: unknown): boolean => Array.isArray(value) && value.length >= 4 && value.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)) && value[0][0] === value.at(-1)[0] && value[0][1] === value.at(-1)[1]
  return !!region && typeof region.id === 'string' && !!region.id && typeof region.name === 'string' && Array.isArray(region.polygons) && region.polygons.length > 0 && region.polygons.every(polygon => !!polygon && ring(polygon.outer) && Array.isArray(polygon.holes) && polygon.holes.every(ring))
}

/** 边界计入区域，孔洞内部排除；与地图分区的几何规则相同。 */
export const inTargetRegion = gameAlgorithms.inTargetRegion
