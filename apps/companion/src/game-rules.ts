import type { GameProfile, RuleFacts } from '@ra2c/command'

export interface GameRule extends RuleFacts {
  type?: number
  prerequisite?: string[]
  deploysInto?: string
  undeploysInto?: string
  buildCat?: number
}
export type RuleQuery = (name: string, type: number) => Promise<unknown>

/** 同一请求复用已读取的规则，不缓存当前可造性，也不跨局缓存。 */
export function createRuleLookup(query: RuleQuery, check: () => void, profile: GameProfile, hints: ReadonlyMap<string, number> = new Map()) {
  const cache = new Map<string, Promise<{ rule: GameRule; type: number } | undefined>>()
  return (name: string) => {
    check()
    let pending = cache.get(name)
    if (!pending) {
      pending = (async () => {
        const hint = hints.get(name) ?? profile.member(name)?.type
        let failure: unknown, reads = 0
        for (const type of [...new Set([...(hint ? [hint] : []), 2, 7, 3, 1])]) {
          check()
          let raw: unknown
          try { raw = await query(name, type); reads++ } catch (error) { check(); failure = error; continue }
          check()
          if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            const rule = raw as GameRule
            return { rule, type: rule.type !== undefined && [1, 2, 3, 7].includes(rule.type) ? rule.type : type }
          }
        }
        if (!reads && failure) throw failure
        return undefined
      })()
      cache.set(name, pending)
    }
    return pending
  }
}
