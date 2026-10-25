import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { GoalSpec } from '@ra2c/contracts'

type Stage = 'interpret' | 'compile'
interface Tactic { id: string; stages: Stage[]; always?: boolean; goalKinds?: GoalSpec['kind'][]; recovery?: boolean; text: string; source: string }
const GOAL_KINDS: Record<GoalSpec['kind'], true> = { production: true, combat: true, explore: true, formation: true, reinforce: true, rally: true, deploy: true }

export class TacticLibrary {
  private readonly tactics: Tactic[]
  constructor(tactics: Tactic[]) { this.tactics = structuredClone(tactics) }
  ids(): string[] { return this.tactics.map(tactic => tactic.id) }
  select(stage: Stage, goals: readonly GoalSpec[] = [], recovery = false): Array<{ id: string; text: string }> {
    return this.tactics.filter(tactic => tactic.stages.includes(stage) && (tactic.always || (recovery && tactic.recovery) || goals.some(goal => tactic.goalKinds?.includes(goal.kind))))
      .sort((a, b) => Number(!!b.always) - Number(!!a.always) || Number(!!a.recovery) - Number(!!b.recovery))
      .map(({ id, text }) => ({ id, text }))
  }
}

export function readTactics(directory = new URL('../../../prompts/tactics/', import.meta.url)): { library: TacticLibrary; sources: Array<{ file: string; source: string }> } {
  const files = readdirSync(directory).filter(file => file.endsWith('.md')).sort()
  for (const required of ['common', 'production', 'combat', 'management', 'recovery']) if (!files.includes(`${required}.md`)) throw new Error(`战术文件缺失：${fileURLToPath(new URL(`${required}.md`, directory))}`)
  const tactics = files.map(file => {
    const location = fileURLToPath(new URL(file, directory))
    try {
      const source = readFileSync(location, 'utf8').trim()
      const blocks = [...source.matchAll(/^```tactic\s*\n([\s\S]*?)^```\s*$/gm)]
      if (blocks.length !== 1) throw new Error('需要一个 tactic JSON 块')
      const value = JSON.parse(blocks[0]![1]!) as Omit<Tactic, 'text' | 'source'>
      if (!value || typeof value.id !== 'string' || file !== `${value.id}.md` || !Array.isArray(value.stages) || !value.stages.length || value.stages.some(stage => !['interpret', 'compile'].includes(stage)) || (value.always !== undefined && typeof value.always !== 'boolean') || (value.recovery !== undefined && typeof value.recovery !== 'boolean') || (value.goalKinds !== undefined && (!Array.isArray(value.goalKinds) || value.goalKinds.some(kind => !Object.hasOwn(GOAL_KINDS, kind)))) || !(value.always || value.recovery || value.goalKinds?.length)) throw new Error('战术选择条件非法')
      const text = source.replace(blocks[0]![0], '').trim()
      if (!text) throw new Error('缺少战术正文')
      return { ...value, text, source }
    } catch (error) { throw new Error(`战术定义错误 ${location}：${error instanceof Error ? error.message : String(error)}`) }
  })
  return { library: new TacticLibrary(tactics), sources: tactics.map(tactic => ({ file: `${tactic.id}.md`, source: tactic.source })) }
}
