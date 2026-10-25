import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readCapabilityDocuments } from './capability-definitions.ts'
import { CapabilityCatalog } from './capability-catalog.ts'
import { readGameProfile, type GameProfile } from './game-profile.ts'
import { readTactics, type TacticLibrary } from './tactics.ts'
import type { GoalSpec } from '@ra2c/contracts'

const PLACEHOLDER = /{{\s*([A-Za-z][\w]*)\s*}}/g
const TEMPLATE_DIRECTORY = new URL('../../../prompts/templates/', import.meta.url)
const DEFINITIONS = {
  interpret: { file: 'interpret.md', variables: ['capabilities'] },
  compile: { file: 'compile.md', variables: [] },
  repair: { file: 'repair.md', variables: ['error'] },
  validationFeedback: { file: 'validation-feedback.md', variables: ['errors'] },
} as const satisfies Record<string, { file: string; variables: readonly string[] }>

type PromptName = keyof typeof DEFINITIONS
type StaticPromptName = 'interpret' | 'compile'

/** 一次命令固定使用同一套模板；版本由全部 Markdown 内容计算。 */
export class PromptLibrary {
  private readonly templates: Readonly<Record<PromptName, string>>
  constructor(
    templates: Record<PromptName, string>,
    readonly version: string,
    readonly capabilities: CapabilityCatalog,
    readonly game: GameProfile,
    readonly tactics: TacticLibrary,
  ) {
    this.templates = Object.freeze({ ...templates })
    Object.freeze(this)
  }

  render(name: StaticPromptName): string
  render(name: 'repair', variables: { error: string }): string
  render(name: 'validationFeedback', variables: { errors: string }): string
  render(name: PromptName, variables: Record<string, string> = {}): string {
    const expected = (DEFINITIONS[name].variables as readonly string[]).filter(key => key !== 'capabilities')
    for (const key of Object.keys(variables)) {
      if (!expected.includes(key)) throw new Error(`提示词 ${name} 不接受变量 ${key}`)
    }
    for (const key of expected) {
      if (typeof variables[key] !== 'string') throw new Error(`提示词 ${name} 缺少变量 ${key}`)
    }
    const values = name === 'interpret' ? { ...variables, capabilities: this.capabilities.render() } : variables
    const rendered = this.templates[name].replace(PLACEHOLDER, (_match, key: string) => values[key] ?? '')
    return name === 'interpret' ? [rendered, this.game.instructions, ...this.tactics.select('interpret').map(tactic => tactic.text)].join('\n\n') : rendered
  }

  compileFor(goals: readonly GoalSpec[], recovery = false): string {
    return [this.render('compile'), this.game.instructions, ...this.tactics.select('compile', goals, recovery).map(tactic => tactic.text)].join('\n\n')
  }
}

/** 严格检查磁盘内容，不回退缓存；供开发检查和独立加载器使用。 */
export function readPrompts(directory = TEMPLATE_DIRECTORY): PromptLibrary {
  const templates = {} as Record<PromptName, string>
  const hash = createHash('sha256')
  for (const [name, definition] of Object.entries(DEFINITIONS) as Array<[PromptName, (typeof DEFINITIONS)[PromptName]]>) {
    const file = new URL(definition.file, directory)
    const location = fileURLToPath(file)
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch (error) {
      throw new Error(`提示词读取失败 ${location}：${String(error)}`)
    }
    if (!source.trim()) throw new Error(`提示词为空 ${location}`)
    const placeholders = [...source.matchAll(PLACEHOLDER)].map(match => match[1]!)
    for (const key of placeholders) {
      if (!(definition.variables as readonly string[]).includes(key)) throw new Error(`提示词变量未声明 ${location}：${key}`)
    }
    for (const key of definition.variables) {
      if (!placeholders.includes(key)) throw new Error(`提示词缺少变量 ${location}：${key}`)
    }
    const remainder = source.replace(PLACEHOLDER, '')
    if (remainder.includes('{{')) throw new Error(`提示词模板标记无效 ${location}`)
    templates[name] = source.trim()
    hash.update(definition.file).update('\0').update(source).update('\0')
  }
  const documents = readCapabilityDocuments(new URL('../capabilities/', directory))
  const capabilities = new CapabilityCatalog(documents)
  for (const document of documents) hash.update(document.file).update('\0').update(document.source).update('\0')
  const game = readGameProfile(new URL('../games/current-mod.md', directory))
  const tactics = readTactics(new URL('../tactics/', directory))
  hash.update('games/current-mod.md').update('\0').update(game.source).update('\0')
  for (const document of tactics.sources) hash.update(`tactics/${document.file}`).update('\0').update(document.source).update('\0')
  return new PromptLibrary(templates, `sha256:${hash.digest('hex').slice(0, 16)}`, capabilities, game.profile, tactics.library)
}

export interface PromptLoadOptions {
  onFallback?: (error: Error) => void
  validate?: (prompts: PromptLibrary) => void
}

/** 缓存按加载目录隔离；只有整套文件通过校验后才替换上一份可用定义。 */
export class PromptLoader {
  private lastGood?: PromptLibrary
  constructor(private readonly directory = TEMPLATE_DIRECTORY) {}

  load({ onFallback = error => console.error(`[companion] ${error.message}；沿用上一份可用提示词`), validate }: PromptLoadOptions = {}): PromptLibrary {
    try {
      const loaded = readPrompts(this.directory)
      validate?.(loaded)
      if (this.lastGood?.version === loaded.version) return this.lastGood
      this.lastGood = loaded
      return loaded
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      if (!this.lastGood) throw failure
      onFallback(failure)
      return this.lastGood
    }
  }
}

const defaultLoader = new PromptLoader()

/** 在新命令/编译请求边界重读，不在逐 tick 执行中调用。 */
export function loadPrompts(options?: PromptLoadOptions): PromptLibrary {
  return defaultLoader.load(options)
}
