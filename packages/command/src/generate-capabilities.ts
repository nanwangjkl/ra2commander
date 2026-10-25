import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { readCapabilityDocuments, capabilityContractVersion, type ParameterDefinition } from './capability-definitions.ts'

export const CAPABILITY_TYPES_FILE = new URL('./capability-types.generated.ts', import.meta.url)
function parameterType(rule: ParameterDefinition): string {
  const type = rule.enum ? rule.enum.map(value => JSON.stringify(value)).join(' | ')
    : rule.type === 'integer' || rule.type === 'number' ? 'number' : rule.type === 'integer[]' ? 'number[]' : rule.type
  return rule.allowAll ? `${type} | 'all'` : type
}
export function generatedCapabilityTypes(): string {
  const documents = readCapabilityDocuments()
  const parameters = (resolved: boolean) => documents.map(({ definition }) => {
    const fields = Object.entries(definition.parameters).map(([name, rule]) => {
      const required = resolved ? rule.required || 'default' in rule : rule.required && !('default' in rule)
      return `${name}${required ? '' : '?'}: ${parameterType(rule)}`
    })
    return `  ${JSON.stringify(definition.id)}: ${fields.length ? `{ ${fields.join('; ')} }` : 'Record<string, never>'}`
  })
  return [
    '// 由 prompts/capabilities/*.md 生成；修改定义后运行 pnpm capabilities:generate。',
    `export const CAPABILITY_CONTRACT_VERSION = '${capabilityContractVersion(documents)}'`,
    'export interface CapabilityParameters {',
    ...parameters(false),
    '}',
    'export interface ResolvedCapabilityParameters {',
    ...parameters(true),
    '}',
    'export type CapabilityId = keyof CapabilityParameters',
    'export type CapabilityCall = { [Id in CapabilityId]: { capability: Id; params: CapabilityParameters[Id] } }[CapabilityId]',
    'export type ResolvedCapabilityCall = { [Id in CapabilityId]: { capability: Id; params: ResolvedCapabilityParameters[Id] } }[CapabilityId]',
    '',
  ].join('\n')
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const source = generatedCapabilityTypes()
    if (process.argv.includes('--check')) {
      if (readFileSync(CAPABILITY_TYPES_FILE, 'utf8') !== source) throw new Error('能力类型已过期，请运行 pnpm capabilities:generate')
      console.log('能力参数类型与 Markdown 一致')
    } else { writeFileSync(CAPABILITY_TYPES_FILE, source); console.log('已从 Markdown 生成能力参数类型') }
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
