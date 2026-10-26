import { loadPrompts } from './prompt-loader.ts'
import { computePrerequisiteClosure } from '../../runtime/src/production.ts'

try {
  const profile = loadPrompts().game, entries = profile.entries()
  let checked = 0, conditional = 0
  for (const yard of profile.roles().find(role => role.id === 'constructionYard')!.members) {
    for (const country of profile.entry(yard.name)?.owner ?? []) {
      const own = [{ id: 1, name: yard.name, type: 2, rx: 0, ry: 0, isIdle: true }]
      const factories = profile.productionFactories(own)
      for (const entry of entries.filter(entry => entry.defined && entry.techLevel >= 0 && !profile.limitation(entry.name, country) && (!profile.factionsFor(entry.name).length || profile.factionsFor(entry.name).some(faction => yard.factions?.includes(faction))))) {
        const plan = await computePrerequisiteClosure(entry.name, { categories: { ...profile.categories(own), ...factories }, available: async () => [], prerequisites: async name => {
          const item = profile.entry(name)
          if (!item) return undefined
          const key = `PRODUCTION_FACTORY_${item.type}${item.type === 7 && item.naval ? '_NAVAL' : ''}`
          return [...item.prerequisite, ...(factories[key]?.length ? [key] : [])]
        },
          restriction: async name => { const reason = profile.limitation(name, country); return reason ? { reason } : undefined } }, own)
        if (plan.unknown.length || plan.blocked.some(condition => condition.reason.includes('循环'))) throw new Error(`${country}/${entry.name}：${JSON.stringify(plan)}`)
        checked++; conditional += Number(plan.blocked.length > 0)
      }
    }
  }
  console.log(`${entries.length} 个单位/建筑，${checked} 个国家/项目依赖检查通过；${conditional} 项需额外设施或条件；目录 ${profile.catalogVersion}`)
} catch (error) { console.error(String(error)); process.exitCode = 1 }
