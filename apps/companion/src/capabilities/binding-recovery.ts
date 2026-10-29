import type { CapabilityCall, PromptLibrary } from '@ra2c/command'
import { isBaseRegion } from '../base-defense.ts'

const ATTACKS = new Set(['combat.attack', 'combat.attack-all', 'combat.clear-region'])
/** 绑定修正保留攻击范围和掩护职责，不能把失败的战术要求降为普通生产或编队。 */
export function retainBindingScope(original: unknown, replacement: unknown, prompts: PromptLibrary, text = ''): CapabilityCall {
  let previous: CapabilityCall
  try { previous = prompts.capabilities.parse(original) } catch { return prompts.capabilities.parse(replacement) }
  if (previous.capability === 'production.produce') {
    const corrected = prompts.capabilities.parse(replacement)
    if (corrected.capability !== 'production.produce') throw new Error('生产修正必须保留生产要求')
    const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
    const memberMatches = (name: string, target: string) => [name, ...prompts.game.memberAliases(name), prompts.game.entry(name)?.label ?? '', prompts.game.entry(name)?.englishName ?? ''].some(alias => normalize(alias) === normalize(target))
    const families = prompts.game.roles().filter(role => !role.match && role.members.length && (prompts.game.roleForAlias(previous.params.target) === role.id || role.members.some(member => memberMatches(member.name, previous.params.target))))
    if (families.some(role => prompts.game.roleForAlias(corrected.params.target) !== role.id && !role.members.some(member => memberMatches(member.name, corrected.params.target)))) throw new Error('生产修正不能丢弃具体项目类别，例如把核电站改成普通电厂')
    return prompts.capabilities.parse({ ...corrected, params: { ...previous.params, target: corrected.params.target } })
  }
  if(previous.capability==='combat.hold'&&(previous.params.defendBase||isBaseRegion(previous.params.regionName))) {
    const corrected=prompts.capabilities.parse(replacement)
    if(corrected.capability!=='combat.hold')throw new Error('基地防守修正必须保留基地分区与原地待命，不能降为普通移动或进攻')
    const {regionName:_region,bounds:_bounds,...params}=previous.params
    return prompts.capabilities.parse({capability:'combat.hold',params:{...params,defendBase:true,mode:'hold'}})
  }
  if (previous.capability === 'combat.hold') {
    const corrected = prompts.capabilities.parse(replacement)
    if (corrected.capability !== 'combat.hold') throw new Error('持续守卫修正必须保留监视、敌方兵种和范围，不能改成普通移动或进攻')
    return prompts.capabilities.parse({ ...corrected, params: { ...corrected.params, ...previous.params } })
  }
  const isCover = (call: CapabilityCall) => call.capability === 'formation.cover' || call.capability === 'skill.run' && prompts.skills.get(call.params.skillId)?.definition.id === 'cover'
  if (isCover(previous)) {
    const corrected = prompts.capabilities.parse(replacement)
    if (!isCover(corrected)) throw new Error('掩护绑定修正必须保留同队掩护，不能改成只生产、普通编队或其他 Skill')
    const before = previous.params as Record<string, unknown>, after = corrected.params as Record<string, unknown>
    // 泛称的防空车来自玩家原话，IFV 只是模型误选；不能把误选固定为原始要求。
    const selector = String(before.selector ?? ''), role = prompts.game.roleForAlias(selector)
    if (/防空车|防空战车/.test(text) && !/IFV|FV|多功能/i.test(text) && !before.unitIds && (role === 'infantryFightingVehicle' || role === 'antiAirVehicle' || prompts.game.rolesFor(selector, 7).includes('antiAirVehicle'))) before.selector = 'antiAirVehicle'
    const acceptedFields = prompts.capabilities.definitions().find(definition => definition.id === corrected.capability)!.parameters
    for (const field of ['formationId', 'selector', 'unitIds', 'quantity', 'protectedSelector', 'protectedQuantity', 'protectedUnitIds', 'memberSource', 'useExisting']) {
      if (before[field] === undefined) continue
      if (!(field in acceptedFields)) throw new Error(`修正不能丢弃原掩护的 ${field} 要求`)
      after[field] = before[field]
    }
    return prompts.capabilities.parse(corrected)
  }
  if (previous.capability === 'unit.deploy') {
    const corrected = prompts.capabilities.parse(replacement)
    if (corrected.capability !== 'unit.deploy') throw new Error('部署绑定修正不能丢弃部署、改成仅移动或重新生产')
    return prompts.capabilities.parse({ ...corrected, params: { ...corrected.params, ...previous.params } })
  }
  if (!ATTACKS.has(previous.capability)) return prompts.capabilities.parse(replacement)
  const corrected = prompts.capabilities.parse(replacement)
  if (!ATTACKS.has(corrected.capability)) throw new Error('攻击绑定修正不能改成建队或其他全局操作')
  const before = previous.params as Record<string, unknown>, after = corrected.params as Record<string, unknown>
  const acceptedFields = prompts.capabilities.definitions().find(definition => definition.id === corrected.capability)!.parameters
  for (const field of ['formationId', 'selector', 'unitIds', 'regionName', 'target', 'targetId', 'targetSelectors', 'targetDomain', 'splitTargets', 'quantity']) {
    if (before[field] === undefined) continue
    if (!(field in acceptedFields)) throw new Error(`修正不能丢弃原攻击的 ${field} 范围`)
    after[field] = before[field]
  }
  return prompts.capabilities.parse(corrected)
}

/** 掩护修正按整组审核，生产由掩护绑定器按固定份额统一建立，避免先造一份又补造。 */
export function retainBindingRepairs(original: unknown, replacements: unknown[], prompts: PromptLibrary, text: string): CapabilityCall[] {
  const previous = prompts.capabilities.parse(original)
  const isCover = (call: CapabilityCall) => call.capability === 'formation.cover' || call.capability === 'skill.run' && call.params.skillId === 'cover'
  if (!isCover(previous)) return replacements.map(value => retainBindingScope(original, value, prompts, text))
  const parsed = replacements.map(value => prompts.capabilities.parse(value)), covers = parsed.filter(isCover)
  if (covers.length !== 1 || parsed.some(call => !isCover(call) && call.capability !== 'production.produce')) throw new Error('掩护绑定修正必须保留同队掩护，不能改成只生产、普通编队或其他 Skill')
  return [retainBindingScope(previous, covers[0], prompts, text)]
}
