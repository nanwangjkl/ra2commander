import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const CAPABILITY_DIRECTORY = new URL('../../../prompts/capabilities/', import.meta.url)
export interface ParameterDefinition {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'integer[]' | 'string[]'
  description: string
  required?: boolean
  default?: unknown
  enum?: string[]
  min?: number
  max?: number
  minItems?: number
  maxItems?: number
  allowAll?: boolean
}
export interface CapabilityDefinition {
  id: string
  name: string
  version: string
  binder: string
  owner: 'global' | 'formation' | 'selected'
  parameters: Record<string, ParameterDefinition>
}
export interface CapabilityDocument { definition: CapabilityDefinition; source: string; file: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** 参数校验和默认值只使用 Markdown 中的声明。 */
export function parameterValue(value: unknown, rule: ParameterDefinition, location: string): unknown {
  if (rule.allowAll && value === 'all') return value
  const valid = rule.type === 'string' ? typeof value === 'string' && !!value.trim()
    : rule.type === 'boolean' ? typeof value === 'boolean'
      : rule.type === 'string[]' ? Array.isArray(value) && value.every(item => typeof item === 'string' && !!item.trim() && (!rule.enum || rule.enum.includes(item)))
      : rule.type === 'integer[]' ? Array.isArray(value) && value.every(Number.isSafeInteger)
        : typeof value === 'number' && Number.isFinite(value) && (rule.type !== 'integer' || Number.isSafeInteger(value))
  if (!valid) throw new Error(`${location} 参数类型应为 ${rule.type}${rule.allowAll ? ' 或 all' : ''}`)
  if (typeof value === 'number' && ((rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max))) throw new Error(`${location} 参数超出允许范围`)
  if (typeof value === 'string' && rule.enum && !rule.enum.includes(value)) throw new Error(`${location} 参数须为 ${rule.enum.join('|')}`)
  if (Array.isArray(value) && ((rule.minItems !== undefined && value.length < rule.minItems) || (rule.maxItems !== undefined && value.length > rule.maxItems) || (rule.type === 'integer[]' && value.some(n => (rule.min !== undefined && n < rule.min) || (rule.max !== undefined && n > rule.max))))) throw new Error(`${location} 数组长度或元素超出允许范围`)
  return structuredClone(value)
}

export function readCapabilityDocuments(directory = CAPABILITY_DIRECTORY): CapabilityDocument[] {
  const seen = new Set<string>()
  const files = readdirSync(directory).filter(file => file.endsWith('.md')).sort()
  if (!files.length) throw new Error(`能力目录为空：${fileURLToPath(directory)}`)
  return files.map(file => {
    const location = fileURLToPath(new URL(file, directory))
    try {
      const source = readFileSync(location, 'utf8').trim()
      const blocks = [...source.matchAll(/^```capability\s*\n([\s\S]*?)^```\s*$/gm)]
      if (blocks.length !== 1) throw new Error('需要且只能包含一个 capability JSON 块')
      const value: unknown = JSON.parse(blocks[0]![1]!)
      if (!object(value) || typeof value.id !== 'string' || !/^[a-z][a-z0-9.-]+$/.test(value.id) || typeof value.name !== 'string' || !value.name.trim() || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version) || typeof value.binder !== 'string' || !value.binder || !['global', 'formation', 'selected'].includes(String(value.owner)) || !object(value.parameters)) throw new Error('能力元信息不完整')
      if (file !== `${value.id}.md` || seen.has(value.id)) throw new Error(`能力文件名不匹配或 ID 重复：${value.id}`)
      seen.add(value.id)
      for (const [name, raw] of Object.entries(value.parameters)) {
        if (!/^[a-zA-Z]\w*$/.test(name) || !object(raw) || !['string', 'integer', 'number', 'boolean', 'integer[]', 'string[]'].includes(String(raw.type)) || typeof raw.description !== 'string' || !raw.description.trim()) throw new Error(`参数定义非法：${name}`)
        const allowed = ['type', 'description', 'required', 'default', 'enum', 'min', 'max', 'minItems', 'maxItems', 'allowAll']
        if (Object.keys(raw).some(key => !allowed.includes(key))) throw new Error(`参数 ${name} 含不支持的字段`)
        if (['required', 'allowAll'].some(key => raw[key] !== undefined && typeof raw[key] !== 'boolean')) throw new Error(`参数 ${name} 的开关须为 boolean`)
        if (raw.allowAll && raw.type !== 'integer') throw new Error(`参数 ${name} 仅 integer 支持 allowAll`)
        if (raw.enum !== undefined && (!['string', 'string[]'].includes(String(raw.type)) || !Array.isArray(raw.enum) || !raw.enum.length || raw.enum.some(item => typeof item !== 'string' || !item))) throw new Error(`参数 ${name} 的枚举非法`)
        if (['min', 'max', 'minItems', 'maxItems'].some(key => raw[key] !== undefined && (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])))) throw new Error(`参数 ${name} 的范围非法`)
        if ((typeof raw.min === 'number' && typeof raw.max === 'number' && raw.min > raw.max) || ['minItems', 'maxItems'].some(key => raw[key] !== undefined && (!['integer[]', 'string[]'].includes(String(raw.type)) || !Number.isSafeInteger(raw[key]) || Number(raw[key]) < 0)) || (typeof raw.minItems === 'number' && typeof raw.maxItems === 'number' && raw.minItems > raw.maxItems)) throw new Error(`参数 ${name} 的范围非法`)
        if ('default' in raw) parameterValue(raw.default, raw as unknown as ParameterDefinition, name)
      }
      if (!source.replace(blocks[0]![0], '').trim()) throw new Error('能力缺少行为说明')
      return { definition: value as unknown as CapabilityDefinition, source, file }
    } catch (error) { throw new Error(`能力定义错误 ${location}：${error instanceof Error ? error.message : String(error)}`) }
  })
}

export function capabilityContractVersion(documents: CapabilityDocument[]): string {
  return createHash('sha256').update(JSON.stringify(documents.map(({ definition }) => ({
    id: definition.id, binder: definition.binder,
    parameters: Object.fromEntries(Object.entries(definition.parameters).map(([name, { description: _description, ...rule }]) => [name, rule])),
  })))).digest('hex')
}
