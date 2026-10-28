import type { CapabilityCall, PromptLibrary } from '@ra2c/command'

const ATTACKS = new Set(['combat.attack', 'combat.attack-all', 'combat.clear-region'])
/** 绑定修正保留攻击范围和掩护职责，不能把失败的战术要求降为普通生产或编队。 */
export function retainBindingScope(original: unknown, replacement: unknown, prompts: PromptLibrary): CapabilityCall {
  let previous: CapabilityCall
  try { previous = prompts.capabilities.parse(original) } catch { return prompts.capabilities.parse(replacement) }
  const isCover = (call: CapabilityCall) => call.capability === 'formation.cover' || call.capability === 'skill.run' && prompts.skills.get(call.params.skillId)?.definition.id === 'cover'
  if (isCover(previous)) {
    const corrected = prompts.capabilities.parse(replacement)
    if (!isCover(corrected)) throw new Error('掩护绑定修正必须保留同队掩护，不能改成只生产、普通编队或其他 Skill')
    const before = previous.params as Record<string, unknown>, after = corrected.params as Record<string, unknown>
    const acceptedFields = prompts.capabilities.definitions().find(definition => definition.id === corrected.capability)!.parameters
    for (const field of ['formationId', 'selector', 'unitIds', 'quantity', 'protectedSelector', 'protectedQuantity', 'protectedUnitIds', 'memberSource', 'useExisting']) {
      if (before[field] === undefined) continue
      if (!(field in acceptedFields)) throw new Error(`修正不能丢弃原掩护的 ${field} 要求`)
      after[field] = before[field]
    }
    return prompts.capabilities.parse(corrected)
  }
  if (!ATTACKS.has(previous.capability)) return prompts.capabilities.parse(replacement)
  const corrected = prompts.capabilities.parse(replacement)
  if (!ATTACKS.has(corrected.capability)) throw new Error('攻击绑定修正不能改成建队或其他全局操作')
  const before = previous.params as Record<string, unknown>, after = corrected.params as Record<string, unknown>
  const acceptedFields = prompts.capabilities.definitions().find(definition => definition.id === corrected.capability)!.parameters
  for (const field of ['formationId', 'selector', 'unitIds', 'regionName', 'target', 'targetId', 'quantity']) {
    if (before[field] === undefined) continue
    if (!(field in acceptedFields)) throw new Error(`修正不能丢弃原攻击的 ${field} 范围`)
    after[field] = before[field]
  }
  return prompts.capabilities.parse(corrected)
}
