import { CAPABILITY_CONTRACT_VERSION, type ResolvedCapabilityCall } from './capability-types.generated.ts'
import { capabilityContractVersion, parameterValue, type CapabilityDocument } from './capability-definitions.ts'

export class CapabilityCatalog {
  private readonly documents: CapabilityDocument[]
  constructor(documents: CapabilityDocument[]) {
    if (capabilityContractVersion(documents) !== CAPABILITY_CONTRACT_VERSION) throw new Error('能力参数或绑定器声明已变化，请运行 pnpm capabilities:generate 并检查绑定实现')
    this.documents = structuredClone(documents)
  }
  render(): string { return this.documents.map(document => document.source).join('\n\n') }
  definitions() { return this.documents.map(document => structuredClone(document.definition)) }
  assertBindings(bindings: readonly string[]): void {
    const declared = this.documents.map(document => document.definition.binder)
    const missing = declared.filter(id => !bindings.includes(id))
    const extra = bindings.filter(id => !declared.includes(id))
    if (missing.length || extra.length) throw new Error(`能力绑定不完整：缺少实现=${missing.join(',') || '无'}；未声明入口=${extra.join(',') || '无'}`)
  }
  parse(value: unknown): ResolvedCapabilityCall {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('能力调用须为 {capability,params}')
    const call = value as Record<string, unknown>
    const document = this.documents.find(document => document.definition.id === call.capability)
    if (!document) throw new Error(`未知能力：${String(call.capability)}`)
    if (Object.keys(call).some(key => !['capability', 'params'].includes(key))) throw new Error(`能力 ${document.definition.id} 含未知调用字段`)
    const raw = call.params ?? {}
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('能力参数须为对象')
    const supplied = raw as Record<string, unknown>
    const { definition } = document
    for (const name of Object.keys(supplied)) if (!Object.hasOwn(definition.parameters, name)) throw new Error(`能力 ${definition.id} 不接受参数 ${name}`)
    const params: Record<string, unknown> = {}
    for (const [name, rule] of Object.entries(definition.parameters)) {
      const value = supplied[name] ?? rule.default
      if (value === undefined) { if (rule.required) throw new Error(`能力 ${definition.id} 缺少参数 ${name}`); continue }
      params[name] = parameterValue(value, rule, `${definition.id}.${name}`)
    }
    return { capability: definition.id, params } as ResolvedCapabilityCall
  }
}
