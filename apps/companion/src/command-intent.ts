import type { MapRegionIndex } from '../../../packages/maps/src/index.ts'
import type { CatalogItem, GameCatalog } from './game-catalog.ts'
import { attackVerb, commandClauses, formationAlias, namedFormation, normalizeName } from './command-text.ts'

export interface IntentClause {
  text: string
  formationId: string | undefined
  region: MapRegionIndex['scheme']['regions'][number] | undefined
  genericAntiAir: boolean
  namedUnits: CatalogItem[]
  attack: { selectors: string[]; fullyParsed: boolean; domain: 'air' | 'ground' | undefined; split: boolean } | undefined
}

/** 一次提取原话中已有的明确事实；组织、部署和作战校正共用，不推断新战术。 */
export class CommandIntent {
  readonly raw: string
  readonly formationId: string | undefined
  readonly clauses: IntentClause[]
  readonly patrolFormations: ReadonlySet<string>
  constructor(text: string, map?: MapRegionIndex, readonly catalog?: GameCatalog) {
    this.raw = normalizeName(text)
    const assigned = this.raw.match(/(?:编入|编到|归入|加入)([\d一二三四五六七八九十两]+)队/)
    this.formationId = assigned ? formationAlias(`${assigned[1]}队`) : namedFormation(this.raw)
    const names = catalog ? [...catalog.profile.attackAliases().filter(item => catalog.all.some(unit => unit.name === item.name)).map(item => ({ alias: item.alias, selector: item.name })),
      ...catalog.profile.roles().flatMap(role => role.aliases.map(alias => ({ alias, selector: role.id }))),
      ...catalog.all.flatMap(item => [item.name, item.label ?? '', ...item.aliases].map(alias => ({ alias, selector: item.name })))].filter(item => item.alias.length >= 2).sort((a, b) => b.alias.length - a.alias.length) : []
    this.clauses = commandClauses(text).map(clause => {
      const region = map?.resolveMention(clause)
      const verb = attackVerb(clause)
      let attack: IntentClause['attack']
      if (verb) {
        let enemyText = clause.slice(verb.index! + verb[0].length).toLowerCase()
        const selectors: string[] = []
        enemyText = enemyText.replace(/部队|军队/g, () => { selectors.push('infantry', 'vehicle'); return ' ' })
        for (const item of names) if (enemyText.includes(normalizeName(item.alias).toLowerCase())) {
          selectors.push(item.selector); enemyText = enemyText.split(normalizeName(item.alias).toLowerCase()).join(' ')
        }
        for (const name of region ? [region.name, ...region.aliases] : []) enemyText = enemyText.split(normalizeName(name).toLowerCase()).join(' ')
        const fullyParsed = !enemyText.replace(/只要|一旦|出现|发现|看到|看见|立即|马上|持续|一直|击落|干掉|攻击|消灭|摧毁|就|以及|并且|视野内|可见|当前|最近|所有|全部|全体|任何|任意|空中|地面|敌方|敌军|敌人|对方|区域内|分区内|区域|分区|单位|目标|的|和|与|及|或|内|里|中|物|[\s、]/g, '')
        attack = { selectors, fullyParsed, domain: /空中/.test(clause.slice(verb.index!)) ? 'air' : /地面/.test(clause.slice(verb.index!)) ? 'ground' : undefined, split: /分头|分散|各自/.test(clause) }
      }
      return { text: clause, formationId: namedFormation(clause), region, attack,
        genericAntiAir: /防空车|防空战车/.test(clause) && !/IFV|FV|多功能/i.test(clause),
        namedUnits: catalog?.all.filter(item => [item.name, item.label ?? '', ...item.aliases].some(name => name.length > 1 && clause.includes(normalizeName(name)))) ?? [] }
    })
    this.patrolFormations = new Set(this.clauses.flatMap(clause => {
      const match = clause.text.match(/([\d一二三四五六七八九十两]+)队[^，,。；;]*巡逻/)
      return match ? [formationAlias(`${match[1]}队`)] : []
    }))
  }
  antiAirClause(formationId?: string): IntentClause | undefined {
    return this.clauses.find(clause => clause.genericAntiAir && (!clause.formationId || !formationId || clause.formationId === formationAlias(formationId)))
  }
}
