import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GoalSpec, ProductionGoal } from '@ra2c/contracts'
import type { CommandContext } from './commands.ts'

export const TRANSCRIPT_PROMPT = `把红警玩家的语音转写文本解析为明确目标，只输出 JSON {"summary":"简短中文理解","operations":[...]}。
RTS 优先快速响应。目标能理解时，根据当前战况选一个合理解释并执行，允许玩家用下一条命令纠正；不要为了消除歧义停下来询问。summary 简短说明你的选择，不要求确认。
可用操作：
{"kind":"deploy"} 展开已有基地车；
{"kind":"produce","target":"原生名称","quantity":正整数,"formationId":"可选编队名"} 新造指定数量并可将新造单位编入队；
{"kind":"move","formationId":"编队名","regionName":"区域名称"} 让该队前往已绑定地名；
{"kind":"power","reserve":100} 仅在明确要求保持电量健康时持续补电，未指定余量时以100为测试默认值；
{"kind":"attackAll"} 使用已有作战编队主动摧毁全部敌人。
生产目标只能使用 catalog 提供的原生名称；根据当前阵营选取。战车工厂是 War Factory，盟军普通坦克是 Grizzly Battle Tank，间谍卫星是 SpySat Uplink。
catalog 提供当前阵营及实际可生产项目，available 表示现在可造。普通“工厂”“重工”“坦克”优先选择现在可造的同类项目，再按本局阵营及已有设施选择；仍有多个候选时直接选一个，不询问盟军还是苏军。数量未说时默认1。
编队名称按 formations 中已有名称绑定；新建数字编队统一使用“1队”“2队”这种格式。只创建本句话要求的目标，必要生产前置由宿主计算。
不添加额外造兵或扩张。保持电量健康与制造卫星应返回两个操作；制造5辆坦克并编入1队应返回一个带 formationId 的生产操作。
同一句话的可执行部分先执行，不因另一部分缺少对象而整句放弃。仅当命令完全不属于支持范围、或确实没有相关对象和生产项目时才返回空 operations，并说明具体原因；不能仅因为存在多个合理选择而返回空操作。`

// 当前支持目录中的同类项目；用于将模型选错的阵营名称落到本局可用项目。
const PRODUCTION_FAMILIES = [
  ['AMCV', 'SMCV', 'PCV'], ['GACNST', 'NACNST', 'YACNST'], ['GAPOWR', 'NAPOWR', 'YAPOWR'],
  ['GAREFN', 'NAREFN', 'YAREFN'], ['GAPILE', 'NAPILE', 'YAPILE'], ['GAWEAP', 'NAWEAP', 'YAWEAP'],
  ['GAAIRC', 'NARADR', 'YAPSY'], ['GATECH', 'NATECH', 'YATECH'], ['GASPYSAT'], ['MTNK', 'HTNK', 'LTNK'],
]

type Operation = { kind: 'deploy' } | { kind: 'produce'; target: string; quantity: number; formationId?: string }
  | { kind: 'move'; formationId: string; regionName: string } | { kind: 'power'; reserve: number } | { kind: 'attackAll' }

export async function runTranscript(text: string, ctx: CommandContext, root: string): Promise<string> {
  if (!text.trim()) throw new Error('缺少模拟语音转写文本')
  const snap = ctx.runtime.snapshot
  if (!snap) throw new Error('请先进入对局')
  ctx.transcriptAbort?.abort()
  const abort = new AbortController()
  ctx.transcriptAbort = abort
  const signal = abort.signal
  const key = ctx.runtime.battleKey
  const check = () => { signal.throwIfAborted(); if (key !== ctx.runtime.battleKey) throw new Error('对局已变化，转写结果作废') }
  const ids = PRODUCTION_FAMILIES.flat()
  const prefix = snap.self.find(u => /^(GA|NA|YA)CNST$/.test(u.name))?.name.slice(0, 2)
    ?? (snap.self.some(u => u.name === 'AMCV') ? 'GA' : snap.self.some(u => u.name === 'SMCV') ? 'NA' : snap.self.some(u => u.name === 'PCV') ? 'YA' : undefined)
  const available = new Set(snap.production?.available ?? [])
  const owned = new Set(snap.self.map(u => u.name))
  const factionOf = (name: string) => /^(GA|NA|YA)/.exec(name)?.[1]
    ?? (['AMCV', 'MTNK'].includes(name) ? 'GA' : ['SMCV', 'HTNK'].includes(name) ? 'NA' : 'YA')
  const allCatalog = (await Promise.all(ids.map(async name => {
    for (const type of [2, 7]) {
      const r = await ctx.bridge.rules(name, type) as { label?: string; power?: number; deploysInto?: string } | undefined
      check()
      if (r) return { name, type, label: r.label, power: r.power ?? 0, deploysInto: r.deploysInto,
        available: available.has(name), faction: factionOf(name) }
    }
    return undefined
  }))).filter(r => !!r)
  const rank = (r: typeof allCatalog[number]) => Number(r.available) * 4 + Number(r.faction === prefix) * 2 + Number(owned.has(r.name))
  const catalog = allCatalog.filter(r => !prefix || r.faction === prefix || r.available).sort((a, b) => rank(b) - rank(a))
  const resolveProduction = (target: string) => {
    const normalized = target.trim().toLowerCase()
    const exact = catalog.find(r => r.name.toLowerCase() === normalized)
    if (exact) return exact
    const matches = allCatalog.filter(r => r.name.toLowerCase() === normalized || r.label?.toLowerCase() === normalized)
    const names = new Set(matches.flatMap(r => PRODUCTION_FAMILIES.find(f => f.includes(r.name)) ?? [r.name]))
    return catalog.find(r => names.has(r.name))
  }
  const result = await ctx.currentProvider().generate({ messages: [
    { role: 'system', content: TRANSCRIPT_PROMPT },
    { role: 'user', content: JSON.stringify({ text, faction: prefix === 'GA' ? 'Allied 盟军' : prefix === 'NA' ? 'Soviet 苏军' : prefix === 'YA' ? 'Yuri 尤里' : null, self: snap.self.map(u => ({ id: u.id, name: u.name, canDeploy: u.canDeploy })), formations: ctx.formations.list(), catalog, map: ctx.mapRegions ? { name: ctx.mapRegions.scheme.map.name, regions: ctx.mapRegions.scheme.regions.map(r => r.name) } : null }) },
  ], maxTokens: 2048, thinking: 'disabled', signal })
  check()
  const raw = result.text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim()
  const plan = JSON.parse(raw) as { summary: string; operations: Operation[] }
  if (!plan || typeof plan.summary !== 'string' || !Array.isArray(plan.operations) || plan.operations.length > 8) throw new Error('转写解析格式非法')
  const requestId = randomUUID()
  const goals: GoalSpec[] = []
  const folder = join(root, '.runtime/transcripts')
  mkdirSync(folder, { recursive: true })
  const record = { requestId, text, model: result.model, durationMs: result.durationMs, sessionKey: key, plan, goals,
    choices: [] as string[], skipped: [] as string[], results: [] as string[], error: '' }
  const save = () => writeFileSync(join(folder, `${requestId}.json`), JSON.stringify(record, null, 2))
  save()
  const makeId = () => `voice-${randomUUID().slice(0, 8)}`
  const fullMap = { name: '沿途与全图作战', x1: 0, y1: 0, x2: snap.mapWidth - 1, y2: snap.mapHeight - 1 }
  try {
    for (const operation of plan.operations) {
      try {
        if (operation.kind === 'deploy') {
          const vehicle = snap.self.filter(u => u.canDeploy && allCatalog.some(r => r.name === u.name && r.deploysInto?.endsWith('CNST')))
            .sort((a, b) => Number(b.isIdle) - Number(a.isIdle) || a.id - b.id)[0]
          if (!vehicle) throw new Error('没有可展开的基地车')
          goals.push({ id: makeId(), kind: 'deploy', rawText: text, unitIds: [vehicle.id], target: allCatalog.find(r => r.name === vehicle.name)!.deploysInto! })
          record.choices.push(`展开基地车 #${vehicle.id}`)
        } else if (operation.kind === 'produce' || operation.kind === 'power') {
          const target = operation.kind === 'power' ? 'Power Plant' : operation.target
          const rule = operation.kind === 'power' ? catalog.find(r => PRODUCTION_FAMILIES[2]!.includes(r.name) && r.power > 0) : resolveProduction(target)
          if (!rule) throw new Error(`未找到可用生产项目：${target}`)
          const quantity = operation.kind === 'produce' ? operation.quantity : 1
          if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) throw new Error('生产数量非法')
          const goal: ProductionGoal = { id: makeId(), kind: 'production', rawText: text, target: rule.name, quantity, prerequisites: [], queues: [] }
          if (operation.kind === 'power') {
            if (!Number.isFinite(operation.reserve) || operation.reserve < 0 || rule.power <= 0) throw new Error('补电目标非法')
            goal.maintainPower = { reserve: operation.reserve, output: rule.power }
          } else if (operation.formationId) {
            if (typeof operation.formationId !== 'string' || rule.type === 2) throw new Error('编队生产目标非法')
            goal.formationId = operation.formationId
          }
          goals.push(goal)
          record.choices.push(`${operation.kind === 'power' ? '持续补电' : `生产${quantity}个`} ${rule.label ?? rule.name}（${rule.name}）`)
        } else if (operation.kind === 'move') {
          if (!ctx.formations.list().some(f => f.id === operation.formationId)) throw new Error(`编队不存在：${operation.formationId}`)
          const index = ctx.mapSessionKey === key ? ctx.mapRegions : undefined
          const region = index?.resolve(operation.regionName)
          if (!index || !region) throw new Error(`地名尚未绑定：${operation.regionName}；请先 map use ice`)
          const [lx, ly] = region.labelPosition
          let destination: { x: number; y: number; name: string } | undefined
          // 选区域内部且相邻格也属于本区的整数格；是否可达由实机后续位置确认。
          for (let radius = 0; radius <= 20 && !destination; radius++) {
            for (let dx = -radius; dx <= radius && !destination; dx++) for (let dy = -radius; dy <= radius && !destination; dy++) {
              const x = Math.round(lx) + dx, y = Math.round(ly) + dy
              if ([-1, 0, 1].every(a => [-1, 0, 1].every(b => index.regionsAt(x + a, y + b).some(r => r.id === region.id)))) destination = { x, y, name: region.name }
            }
          }
          if (!destination) throw new Error('未找到分区内部的候选目的地')
          goals.push({ id: makeId(), kind: 'combat', rawText: text, formationId: operation.formationId, region: fullMap, destination, allowedActions: ['move', 'stop'] })
        } else if (operation.kind === 'attackAll') {
          const formations = ctx.formations.list().filter(f => snap.self.some(u => f.memberIds.includes(u.id) && u.primaryWeapon))
          if (!formations.length) throw new Error('没有可用作战编队')
          for (const formation of formations) goals.push({ id: makeId(), kind: 'combat', rawText: text, formationId: formation.id, region: fullMap, allowedActions: ['move', 'attackMove', 'attack', 'stop'] })
        } else throw new Error('不支持的转写操作')
      } catch (error) {
        check()
        record.skipped.push(String(error))
      }
    }
    check()
    save()
    const skipped = record.skipped.length ? `\n未执行部分：${record.skipped.join('；')}` : ''
    if (!goals.length) return `理解：${plan.summary}；未执行${skipped}\n记录：${requestId}`
    const owners = new Set<string>()
    for (const goal of goals) owners.add(ctx.runtime.upsertGoal(goal))
    for (const owner of owners) {
      check()
      record.results.push(await ctx.controller.refresh(owner))
      save()
    }
    return `理解：${plan.summary}${record.choices.length ? `\n执行选择：${record.choices.join('；')}` : ''}\n${record.results.join('\n')}${skipped}\n记录：${requestId}`
  } catch (error) {
    record.error = String(error)
    save()
    throw new Error(`${String(error)}；记录：${requestId}`)
  }
}
