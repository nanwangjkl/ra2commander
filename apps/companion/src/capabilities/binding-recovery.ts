import type { CapabilityCall, PromptLibrary } from '@ra2c/command'

const ATTACKS = new Set(['combat.attack', 'combat.attack-all', 'combat.clear-region'])
/** 修正具体绑定不能把“这一队/这些飞机/这个分区”变成全军进攻。 */
export function retainAttackScope(original: unknown, replacement: unknown, prompts: PromptLibrary): CapabilityCall {
  let previous: CapabilityCall
  try { previous = prompts.capabilities.parse(original) } catch { return prompts.capabilities.parse(replacement) }
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
