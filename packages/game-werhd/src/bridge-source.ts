import { createGameAlgorithms, type CrushingRules } from '@ra2c/contracts'

/** 安装判断与注入代码使用同一版本；升级时只改此处。 */
export const BRIDGE_VERSION = 25

/** 注入已擦除类型的自包含工厂，页面无需模块加载器或宿主全局变量。 */
export function createBridgeSource(script: string, buildingFoundations: Record<string, { width: number; height: number }> = {}, crushingRules: CrushingRules = { attackers: [], targets: [] }): string {
  return `window.__ra2cBuildingFoundations = ${JSON.stringify(buildingFoundations)};\nwindow.__ra2cCrushingRules = ${JSON.stringify(crushingRules)};\n(${script}) ((${createGameAlgorithms.toString()})(), ${BRIDGE_VERSION});`
}
