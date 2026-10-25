import type { Region, Snapshot } from '@ra2c/contracts'
import type { CapabilityParameters } from '@ra2c/command'

function point(values: number[], snap: Snapshot): boolean {
  return values.length === 2 && values.every(Number.isInteger) && values[0]! >= 0 && values[1]! >= 0 && values[0]! < snap.mapWidth && values[1]! < snap.mapHeight
}

/** 调试 CLI 的授权由玩家显式提供，生成模型只能在此范围内选择战术。 */
export function combatOptions(tokens: string[], snap: Snapshot): {
  text: string; region: Region; mode?: CapabilityParameters['combat.hold']['mode']; retreat?: { lossAbove: number; x: number; y: number }
} {
  let region: Region | undefined
  let retreat: { lossAbove: number; x: number; y: number } | undefined
  let mode: CapabilityParameters['combat.hold']['mode']
  const text: string[] = []
  for (const token of tokens) {
    if (token.startsWith('--region=')) {
      const v = numbers(token.slice(9))
      if (v.length !== 4 || !point(v.slice(0, 2), snap) || !point(v.slice(2), snap) || v[0]! > v[2]! || v[1]! > v[3]!) throw new Error('--region 必须是地图内的 x1,y1,x2,y2')
      region = { name: '显式授权区', x1: v[0]!, y1: v[1]!, x2: v[2]!, y2: v[3]! }
    } else if (token.startsWith('--retreat=')) {
      const v = numbers(token.slice(10))
      if (v.length !== 3 || !Number.isFinite(v[0]) || v[0]! < 0 || v[0]! >= 1 || !point(v.slice(1), snap)) throw new Error('--retreat 必须是阵亡比例阈值(0≤值<1),x,y；仅超过阈值后回撤')
      retreat = { lossAbove: v[0]!, x: v[1]!, y: v[2]! }
    } else if (token.startsWith('--mode=')) {
      mode = token.slice(7) as typeof mode // 枚举由共用能力入口按 Markdown 校验。
    } else if (token.startsWith('--')) throw new Error(`未知授权参数: ${token}`)
    else text.push(token)
  }
  if (!region) throw new Error('请显式绑定 --region=x1,y1,x2,y2；地图地名自动绑定尚未实现')
  if (!text.length) throw new Error('缺少命令文本')
  if (/战损|阵亡|损失.*(?:成|%|％)|(?:条件|如果|除非|只有)/.test(text.join(' ')) && !retreat) throw new Error('条件尚未绑定；战损回撤请使用 --retreat=比例,x,y，其他条件暂不支持')
  return { text: text.join(' '), region, ...(mode !== undefined ? { mode } : {}), ...(retreat ? { retreat } : {}) }
}

export function productionOptions(tokens: string[]): { quantity?: number; queues?: number[]; text: string } {
  const rest = [...tokens]
  const quantity = rest[0] && /^[+-]?\d+(?:\.\d+)?$/.test(rest[0]) ? Number(rest.shift()) : undefined
  let queues: number[] | undefined
  const text: string[] = []
  for (const token of rest) {
    if (token.startsWith('--pause-queues=')) {
      queues = [...new Set(numbers(token.slice(15)))]
    } else if (token.startsWith('--')) throw new Error(`未知授权参数: ${token}`)
    else text.push(token)
  }
  return { ...(quantity !== undefined ? { quantity } : {}), ...(queues ? { queues } : {}), text: text.join(' ') }
}

function numbers(input: string): number[] {
  const values = input.split(',')
  if (values.some(v => v.trim() === '')) throw new Error('授权参数不能包含空值')
  return values.map(Number)
}
