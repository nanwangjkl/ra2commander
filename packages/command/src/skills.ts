import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parameterValue, type ParameterDefinition } from './capability-definitions.ts'

export interface SkillDefinition {
  id: string; version: string; name: string; aliases: string[]; games: string[]; description: string
  parameters: Record<string, ParameterDefinition>
  requires: string[]
  steps: [
    { id: string; capability: 'production.produce'; existingCapability: 'formation.assign'; role: string },
    { id: string; capability: 'map.explore'; after: { step: string; milestone: 'first-member-ready' } },
  ]
  exploration: { pointSpacing: number; stallTicks: number; maxStallsPerRegion: number; coverageRatio: number; interiorMargin?: number; retryPasses?: number; centerFirst?: boolean }
}
export interface SkillDocument { definition: SkillDefinition; instructions: string; source: string; hash: string; file: string }
export class SkillCatalog {
  private readonly documents: SkillDocument[]
  constructor(documents: SkillDocument[]) { this.documents = structuredClone(documents) }
  ids(): string[] { return this.documents.map(doc => doc.definition.id) }
  get(id: string): SkillDocument | undefined {
    const normalized = id.normalize('NFKC').trim().toLowerCase()
    const doc = this.documents.find(doc => [doc.definition.id, doc.definition.name, ...doc.definition.aliases].some(name => name.toLowerCase() === normalized))
    return doc ? structuredClone(doc) : undefined
  }
  parameters(id: string, overrides: Record<string, unknown>): { quantity: number; memberSource: 'auto' | 'existing' | 'new' } {
    const doc = this.get(id)
    if (!doc) throw new Error(`Skill 不存在：${id}`)
    const inputs = { ...overrides }
    if (inputs.memberSource === undefined && typeof inputs.useExisting === 'boolean') inputs.memberSource = inputs.useExisting ? 'existing' : 'new'
    const values = Object.fromEntries(Object.entries(doc.definition.parameters).map(([key, rule]) => [key, parameterValue(inputs[key] ?? rule.default, rule, `${id}.${key}`)]))
    return { quantity: values.quantity as number, memberSource: values.memberSource as 'auto' | 'existing' | 'new' }
  }
  renderIndex(): string {
    return this.documents.map(({ definition: d }) => `- ${d.id}（${d.name}；别名：${d.aliases.join('、')}）v${d.version}：${d.description}；默认参数 ${JSON.stringify(Object.fromEntries(Object.entries(d.parameters).map(([key, rule]) => [key, rule.default])))}`).join('\n')
  }
}

export function readSkills(directory: URL, capabilityIds: readonly string[], gameId: string): { catalog: SkillCatalog; sources: SkillDocument[] } {
  const names = readdirSync(directory, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()
  const aliases = new Set<string>()
  const sources = names.map(name => {
    const file = new URL(`${name}/SKILL.md`, directory)
    try {
      const source = readFileSync(file, 'utf8').trim()
      const blocks = [...source.matchAll(/^```skill\s*\n([\s\S]*?)^```\s*$/gm)]
      if (blocks.length !== 1) throw new Error('需要一个 skill JSON 块')
      const d = JSON.parse(blocks[0]![1]!) as SkillDefinition
      const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string' && !!item.trim())
      if (!d || d.id !== name || !/^[a-z][a-z0-9-]*$/.test(d.id) || !/^\d+\.\d+\.\d+$/.test(d.version) || !d.name?.trim() || !d.description?.trim() || !strings(d.aliases) || !strings(d.games) || !d.games.includes(gameId) || !strings(d.requires) || d.requires.some(id => !capabilityIds.includes(id))) throw new Error('Skill 元信息、适用游戏或能力引用非法')
      for (const alias of [d.id, d.name, ...d.aliases]) {
        const key = alias.toLowerCase()
        if (aliases.has(key)) throw new Error(`Skill 名称重复：${alias}`)
        aliases.add(key)
      }
      if (!['production.produce', 'formation.assign', 'map.explore'].every(id => d.requires.includes(id))) throw new Error('Skill 缺少依赖能力声明')
      if (!d.parameters || Object.keys(d.parameters).sort().join(',') !== 'memberSource,quantity' || d.parameters.quantity?.type !== 'integer' || d.parameters.memberSource?.type !== 'string' || d.parameters.memberSource.enum?.join(',') !== 'auto,existing,new') throw new Error('首版参数须声明 quantity 与 memberSource（auto/existing/new）')
      for (const [key, rule] of Object.entries(d.parameters)) parameterValue(rule.default, rule, `${d.id}.${key}`)
      if (!Array.isArray(d.steps) || d.steps.length !== 2 || typeof d.steps[0]?.id !== 'string' || !d.steps[0].id.trim() || typeof d.steps[1]?.id !== 'string' || !d.steps[1].id.trim() || d.steps[0].capability !== 'production.produce' || d.steps[0].existingCapability !== 'formation.assign' || !d.steps[0].role || d.steps[1]?.id === d.steps[0].id || d.steps[1]?.capability !== 'map.explore' || d.steps[1].after?.step !== d.steps[0].id || d.steps[1].after.milestone !== 'first-member-ready') throw new Error('首版只支持准备成员后按实际交接里程碑探索')
      if (!d.exploration || !Number.isSafeInteger(d.exploration.pointSpacing) || d.exploration.pointSpacing < 1 || !Number.isSafeInteger(d.exploration.stallTicks) || d.exploration.stallTicks < 1 || !Number.isSafeInteger(d.exploration.maxStallsPerRegion) || d.exploration.maxStallsPerRegion < 1) throw new Error('探索策略参数非法')
      if (!Number.isFinite(d.exploration.coverageRatio) || d.exploration.coverageRatio <= 0 || d.exploration.coverageRatio > 1) throw new Error('探索分区覆盖阈值须大于 0 且不超过 1')
      for (const value of [d.exploration.interiorMargin, d.exploration.retryPasses]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error('探索内缩与重试轮数须为非负整数')
      if (d.exploration.centerFirst !== undefined && typeof d.exploration.centerFirst !== 'boolean') throw new Error('探索中心优先开关须为 boolean')
      const instructions = source.replace(blocks[0]![0], '').trim()
      if (!instructions) throw new Error('缺少 Skill 正文')
      return { definition: d, source, instructions, hash: createHash('sha256').update(source).digest('hex'), file: `${name}/SKILL.md` }
    } catch (error) { throw new Error(`Skill 定义错误 ${fileURLToPath(file)}：${String(error)}`) }
  })
  if (!sources.length) throw new Error('Skill 目录为空')
  return { catalog: new SkillCatalog(sources), sources }
}
