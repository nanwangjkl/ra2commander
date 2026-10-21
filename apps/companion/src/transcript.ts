import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GoalSpec, ProductionGoal } from '@ra2c/contracts'
import type { CommandContext } from './commands.ts'

export const TRANSCRIPT_PROMPT = `把红警玩家的语音转写文本解析为明确目标，只输出 JSON {"summary":"简短中文理解","operations":[...]}。
可用操作：
{"kind":"deploy"} 展开已有基地车；
{"kind":"produce","target":"原生名称","quantity":正整数,"formationId":"可选编队名"} 新造指定数量并可将新造单位编入队；
{"kind":"move","formationId":"编队名","regionName":"区域名称"} 让该队前往已绑定地名；
{"kind":"power","reserve":100} 仅在明确要求保持电量健康时持续补电，未指定余量时以100为测试默认值；
{"kind":"attackAll"} 使用已有作战编队主动摧毁全部敌人。
生产目标只能使用 catalog 提供的原生名称；根据当前阵营选取。战车工厂是 War Factory，盟军普通坦克是 Grizzly Battle Tank，间谍卫星是 SpySat Uplink。
catalog 已按本局建造厂或基地车的阵营筛选，普通“工厂”“坦克”使用当前阵营对应项目，不必再次询问盟军还是苏军。
编队名称按 formations 中已有名称绑定；新建数字编队统一使用“1队”“2队”这种格式。只创建本句话要求的目标，必要生产前置由宿主计算。
不添加额外造兵或扩张。保持电量健康与制造卫星应返回两个操作；制造5辆坦克并编入1队应返回一个带 formationId 的生产操作。
不支持或不能唯一绑定时输出 {"summary":"需要澄清的原因","operations":[]}。`

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
  const ids = ['AMCV', 'SMCV', 'PCV', 'GACNST', 'NACNST', 'YACNST', 'GAPOWR', 'NAPOWR', 'YAPOWR', 'GAREFN', 'NAREFN', 'YAREFN', 'GAPILE', 'NAPILE', 'YAPILE', 'GAWEAP', 'NAWEAP', 'YAWEAP', 'GAAIRC', 'NARADR', 'YAPSY', 'GATECH', 'NATECH', 'YATECH', 'GASPYSAT', 'MTNK', 'HTNK', 'LTNK']
  const prefix = snap.self.find(u => /^(GA|NA|YA)CNST$/.test(u.name))?.name.slice(0, 2)
    ?? (snap.self.some(u => u.name === 'AMCV') ? 'GA' : snap.self.some(u => u.name === 'SMCV') ? 'NA' : snap.self.some(u => u.name === 'PCV') ? 'YA' : undefined)
  const catalog = (await Promise.all(ids.map(async name => {
    for (const type of [2, 7]) {
      const r = await ctx.bridge.rules(name, type) as { label?: string; power?: number; deploysInto?: string } | undefined
      check()
      if (r) return { name, type, label: r.label, power: r.power ?? 0, deploysInto: r.deploysInto }
    }
    return undefined
  }))).filter(r => !!r).filter(r => !prefix || (r.type === 2 ? r.name.startsWith(prefix) : (prefix === 'GA' ? ['AMCV', 'MTNK'] : prefix === 'NA' ? ['SMCV', 'HTNK'] : ['PCV', 'LTNK']).includes(r.name)))
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
  const record = { requestId, text, model: result.model, durationMs: result.durationMs, sessionKey: key, plan, goals, results: [] as string[], error: '' }
  const save = () => writeFileSync(join(folder, `${requestId}.json`), JSON.stringify(record, null, 2))
  save()
  const makeId = () => `voice-${randomUUID().slice(0, 8)}`
  const fullMap = { name: '沿途与全图作战', x1: 0, y1: 0, x2: snap.mapWidth - 1, y2: snap.mapHeight - 1 }
  try {
    for (const operation of plan.operations) {
      if (operation.kind === 'deploy') {
        const vehicles = snap.self.filter(u => u.canDeploy && catalog.some(r => r.name === u.name && r.deploysInto?.endsWith('CNST')))
        if (vehicles.length !== 1) throw new Error('未能唯一绑定可展开的基地车')
        goals.push({ id: makeId(), kind: 'deploy', rawText: text, unitIds: [vehicles[0]!.id], target: catalog.find(r => r.name === vehicles[0]!.name)!.deploysInto! })
      } else if (operation.kind === 'produce' || operation.kind === 'power') {
        const target = operation.kind === 'power' ? snap.self.some(u => u.name.startsWith('NA') && u.name.endsWith('CNST')) ? 'NAPOWR' : snap.self.some(u => u.name === 'YACNST') ? 'YAPOWR' : 'GAPOWR' : operation.target
        const matches = catalog.filter(r => r.name === target || r.label?.toLowerCase() === target.toLowerCase())
        const rule = matches.length === 1 ? matches[0] : undefined
        if (!rule) throw new Error(`未能唯一绑定生产项目：${target}`)
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
    }
    check()
    save()
    if (!goals.length) return `理解：${plan.summary}；未执行（${requestId}）`
    const owners = new Set<string>()
    for (const goal of goals) owners.add(ctx.runtime.upsertGoal(goal))
    for (const owner of owners) {
      check()
      record.results.push(await ctx.controller.refresh(owner))
      save()
    }
    return `理解：${plan.summary}\n${record.results.join('\n')}\n记录：${requestId}`
  } catch (error) {
    record.error = String(error)
    save()
    throw new Error(`${String(error)}；记录：${requestId}`)
  }
}
