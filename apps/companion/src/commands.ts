import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Browser, Page } from 'playwright'
import { ownerId, type ActionRequest, type Snapshot } from '@ra2c/contracts'
import type { OpenAICompatibleProvider } from '@ra2c/model-providers'
import type { TaskRuntime, FormationRegistry } from '@ra2c/runtime'
import type { WerhdBridge } from '@ra2c/game-werhd'
import { ProgramController } from './controller.ts'
import { combatOptions, productionOptions } from './command-options.ts'
import { loadRegionScheme, type MapRegionIndex } from '../../../packages/maps/src/index.ts'
import { runTranscript } from './transcript.ts'
import type { CommandLog } from './command-log.ts'
const ROOT = resolve(import.meta.dirname, '../../..')

export function usage(): string {
  return [
    '命令：',
    '  say <文字>             把文字作为模拟语音转写，解析目标并生成脚本',
    '  map use ice            手动重新绑定冰天雪地分区（当前默认自动绑定）',
    '  status                 桥状态、会话代次、采样统计',
    '  units [n]              列出最近快照中的己方单位（默认前 20）',
    '  move <ids|all> <x> <y> 移动',
    '  amove <ids|all> <x> <y> 攻击移动',
    '  gather <ids|all> <x> <y> 集结',
    '  attack <ids|all> <targetId> 攻击目标',
    '  stop <ids|all>         停止',
    '  enemy [n]              列出当前可见敌人（默认前 20）',
    '  providers              列出已配置的云模型',
    '  form create <名> <ids|tanks|infantry|vehicles|all> [--force]  建编队',
    '  form list / form transfer <ids> <名> / form dissolve <名>',
    '  task new <标签> @编队 --region=x1,y1,x2,y2 [--mode=hold|move|assault] [--retreat=0.6,x,y] <命令>',
    '  task list              全局与编队脚本、版本和待编译状态',
    '  goal list | goal edit <生产目标ID> <总量> | goal cancel <ID>',
    '  global pause / global resume',
    '  reinforce @编队 <兵种名> <维持数量> [--source=@来源编队]',
    '  rally <ids|all> <x> <y> 未编队单位集结（全局目标）',
    '  task stop <id>         立即撤权停止任务',
    '  task pause <id> / task resume <id>',
    '  produce <目标名> [数量=1] [--pause-queues=0,2] [指令]  限量生产（前置各一次，缺省无队列权限）',
    '  prod                   显示生产状态（电力/队列/可造）',
    '  model <名称>           切换编译用的云模型',
    '  shot                   截图到 .runtime/shots/',
    '  quit                   退出（断开连接，浏览器与对局保留）',
    '  quit hard              退出并关闭常驻浏览器',
  ].join('\n')
}

function parseIds(spec: string, snap: Snapshot | undefined): number[] | undefined {
  if (!snap) return undefined
  if (spec === 'all') return snap.self.filter((u) => u.type === 3 || u.type === 7).map((u) => u.id)
  const ids: number[] = []
  for (const part of spec.split(',')) {
    const range = part.match(/^(\d+)-(\d+)$/)
    if (range) {
      for (let i = Number(range[1]); i <= Number(range[2]); i++) ids.push(i)
    } else if (/^\d+$/.test(part)) {
      ids.push(Number(part))
    } else {
      return undefined
    }
  }
  return ids
}

export interface CommandContext {
  browser: Browser
  bridge: WerhdBridge
  page: Page
  runtime: TaskRuntime
  controller: ProgramController
  formations: FormationRegistry
  providers: Map<string, OpenAICompatibleProvider>
  currentProvider: () => OpenAICompatibleProvider
  mapRegions?: MapRegionIndex
  mapSessionKey?: string
  transcriptAbort?: AbortController
  /** 命令记录（阶段 2）：界面/终端/TCP 的 say 统一入流。 */
  commandLog?: CommandLog
}

const TYPE_LABEL: Record<number, string> = { 1: '空军', 2: '建筑', 3: '步兵', 7: '车辆' }

function resolveOwner(token: string, ctx: CommandContext): string {
  if (token === 'global' || ctx.runtime.programs.has(token)) return token
  const formation = token.startsWith('@') ? token.slice(1) : token
  if (ctx.runtime.programs.has(ownerId({ kind: 'formation', formationId: formation }))) return ownerId({ kind: 'formation', formationId: formation })
  const goal = [...ctx.runtime.goals.values()].reverse().find(g => g.spec.id === token || g.spec.label === token)
  if (goal) return goal.ownerId
  throw new Error('控制对象或任务标签不存在')
}

function debugBusy(ids: number[], ctx: CommandContext): boolean {
  return ids.some(id => {
    const formationId = ctx.formations.ownerOf(id)
    const key = formationId ? ownerId({ kind: 'formation', formationId }) : 'global'
    const p = ctx.runtime.programs.get(key)
    return !!p && (ctx.runtime.hasPendingCommand(key) || (p.status === 'active' && (formationId || p.activeGoalIds.some(g => { const spec = ctx.runtime.goals.get(g)?.activeSpec; return spec?.kind === 'rally' && spec.unitIds.includes(id) }))))
  })
}

/** 单条命令 → 输出文本；quit 由调用方根据返回值处理。 */
export async function handleCommand(line: string, ctx: CommandContext): Promise<string> {
  const [cmd, ...args] = line.split(/\s+/)
  const { bridge, page } = ctx
  if (cmd === 'stop' || cmd === 'quit' || (cmd === 'task' && ['stop', 'pause'].includes(args[0] ?? '')) || (cmd === 'global' && args[0] === 'pause')) ctx.transcriptAbort?.abort()
  switch (cmd) {
    case 'say': return runTranscript(line.slice(3).trim(), ctx, ROOT)
    case 'map': {
      if (args[0] !== 'use' || args[1] !== 'ice') return '用法: map use ice（请确认当前对局使用冰天雪地）'
      ctx.mapRegions = await loadRegionScheme(join(ROOT, 'maps/ice/schemes/nanwang-0.1.0.json'))
      ctx.mapSessionKey = ctx.runtime.battleKey
      return `已显式绑定冰天雪地 ${ctx.mapRegions.scheme.scheme.version} 分区；目的地仍需实机到达确认`
    }
    case 'help':
      return usage()
    case 'status': {
      const st = await bridge.state()
      const snap = bridge.latest
      const lines = [JSON.stringify(st, null, 2)]
      lines.push(
        snap
          ? `最新快照: session=${snap.session} seq=${snap.seq} tick=${snap.tick} 单位=${snap.self.length} 资金=${snap.credits}`
          : '尚无快照（未进局或资源未就绪）',
      )
      return lines.join('\n')
    }
    case 'units': {
      const snap = bridge.latest
      if (!snap) return '尚无快照'
      const n = args[0] ? Number(args[0]) : 20
      const lines = snap.self.slice(0, n).map((u) =>
        `  #${u.id} ${u.name} (${TYPE_LABEL[u.type] ?? `type${u.type}`}) (${u.rx},${u.ry}) hp=${u.hitPoints ?? '?'}/${u.maxHitPoints ?? '?'} ${u.isIdle ? 'idle' : 'busy'}`,
      )
      lines.push(`  共 ${snap.self.length} 个单位；可见敌人 ${snap.enemies.length}；地图 ${snap.mapWidth}x${snap.mapHeight}`)
      return lines.join('\n')
    }
    case 'enemy': {
      const snap = bridge.latest
      if (!snap) return '尚无快照'
      const n = args[0] ? Number(args[0]) : 20
      const lines = snap.enemies.slice(0, n).map((u) =>
        `  #${u.id} ${u.name} (${TYPE_LABEL[u.type] ?? `type${u.type}`}) (${u.rx},${u.ry}) hp=${u.hitPoints ?? '?'}/${u.maxHitPoints ?? '?'}`,
      )
      lines.push(`  可见敌人 ${snap.enemies.length} 个`)
      return lines.join('\n')
    }
    case 'providers': {
      const list = [...ctx.providers.values()]
        .map((p) => `  ${p.config.name}: ${p.model} @ ${p.config.baseUrl}`)
      return list.length ? list.join('\n') : '（未配置任何云模型：检查 .env 的 *_API_KEY）'
    }
    case 'model': {
      const name = args[0]
      const p = name ? ctx.providers.get(name) : undefined
      if (!p) return `用法: model <${[...ctx.providers.keys()].join('|')}>`
      ctx.currentProvider = () => p
      return `编译模型切换为 ${p.config.name} (${p.model})`
    }
    case 'form': {
      const sub = args[0]
      const snap = bridge.latest
      if (sub === 'create') {
        const name = args[1]
        const filter = args[2]
        if (!name || !filter) return '用法: form create <名> <ids|tanks|infantry|vehicles|all> [--force]'
        if (!snap) return '尚无快照'
        const force = args.includes('--force')
        const explicitIds = /^[\d,-]+$/.test(filter) ? parseIds(filter, snap) : undefined
        const matched = snap.self.filter((u) => {
          if (explicitIds) return explicitIds.includes(u.id)
          if (u.type === 3) return filter === 'infantry' || filter === 'all'
          if (u.type === 7) {
            if (filter === 'vehicles' || filter === 'all') return true
            // tanks：按规则排除矿车/维修车等非战斗车辆（名称启发式，待规则目录化）。
            if (filter === 'tanks') return !/HARV|CMIN|MINR|TRUCK|AMBULANCE/i.test(u.name)
            return false
          }
          return false
        })
        if (!matched.length) return '没有匹配的单位'
        return ctx.controller.submit({ id: `form-${randomUUID().slice(0, 8)}`, kind: 'formation', rawText: `建立编队 ${name}`, request: { kind: 'createFormation', formationId: name, unitIds: matched.map(u => u.id), force } })
      }
      if (sub === 'list') {
        const lines = ctx.formations.list().map(
          (f) => `  ${f.id}: 成员 ${f.memberIds.length}/${f.originalMemberIds.length}（原始基准）`,
        )
        return lines.length ? lines.join('\n') : '（无编队）'
      }
      if (sub === 'transfer') {
        const ids = parseIds(args[1] ?? '', snap)
        const to = args[2]
        if (!ids?.length || !to) return '用法: form transfer <ids> <编队名>'
        return ctx.controller.submit({ id: `transfer-${randomUUID().slice(0, 8)}`, kind: 'formation', rawText: `转编到 ${to}`, request: { kind: 'transferUnits', formationId: to, unitIds: ids } })
      }
      if (sub === 'dissolve') {
        const name = args[1]
        if (!name || !ctx.formations.list().some(f => f.id === name)) return '编队不存在'
        return ctx.controller.submit({ id: `dissolve-${randomUUID().slice(0, 8)}`, kind: 'formation', rawText: `解散 ${name}`, request: { kind: 'dissolveFormation', formationId: name } })
      }
      return '用法: form create|list|transfer|dissolve …'
    }
    case 'prod': {
      const p = bridge.latest?.production
      if (!p) return '尚无生产数据（未进局）'
      const lines = [`电力: ${p.power.drain}/${p.power.total}${p.power.isLowPower ? '（低电）' : ''} 资金: ${Math.floor(bridge.latest!.credits)}`]
      for (const q of p.queues) {
        const items = q.items.map((i) => `${i.name}x${i.quantity}@${Math.floor(i.progress * 100)}%`).join(', ')
        lines.push(`  队列 type${q.type} [${['空闲', '生产中', '暂停', '就绪'][q.status] ?? q.status}] ${items || '空'}`)
      }
      lines.push(`可造(${p.available.length}): ${p.available.slice(0, 40).join(',')}`)
      return lines.join('\n')
    }
    case 'produce': {
      const target = args[0]
      if (!target || !/^[A-Za-z0-9_]+$/.test(target)) return '用法: produce <目标名> [数量] [--pause-queues=0,2] [指令]'
      const options = productionOptions(args.slice(1))
      if (!bridge.latest?.production) return '尚无生产数据（未进局）'
      const id = `prod-${target}-${randomUUID().slice(0, 8)}`
      console.log(`[companion] 新增全局目标 ${id}，编译中…`)
      return ctx.controller.submit({ id, kind: 'production', rawText: `生产 ${options.quantity} 个 ${target}；${options.text}`, target, quantity: options.quantity, prerequisites: [], queues: options.queues })
    }
    case 'reinforce': {
      const formationId = args[0]?.replace(/^@/, '')
      const name = args[1]
      const targetSize = Number(args[2])
      const sourceArg = args[3]
      if (!formationId || !name || !Number.isSafeInteger(targetSize) || targetSize < 1 || (sourceArg && !sourceArg.startsWith('--source=@'))) return '用法: reinforce @编队 <兵种名> <维持数量> [--source=@来源编队]；默认仅用未编队单位'
      return ctx.controller.submit({ id: `reinforce-${randomUUID().slice(0, 8)}`, kind: 'reinforce', rawText: line, formationId, name, targetSize, source: sourceArg ? sourceArg.slice(10) : null })
    }
    case 'rally': {
      const ids = parseIds(args[0] ?? '', bridge.latest)
      if (!ids?.length) return '用法: rally <ids|all> <x> <y>；仅指挥未编队单位'
      return ctx.controller.submit({ id: `rally-${randomUUID().slice(0, 8)}`, kind: 'rally', rawText: line, unitIds: ids, x: Number(args[1]), y: Number(args[2]) })
    }
    case 'goal': {
      const id = args[1] ?? ''
      if (args[0] === 'list') return [...ctx.runtime.goals.values()].map(g => {
        const records = ctx.runtime.production.filter(r => r.goalId === g.spec.id && r.state !== 'rejected')
        return `${g.spec.id} [${g.status}] ${g.ownerId} ${g.spec.rawText}${g.activeSpec && JSON.stringify(g.activeSpec) !== JSON.stringify(g.spec) ? '（变更待生效）' : ''}${g.facts.blocked ? `；${g.facts.blocked}` : ''}${records.map(r => `\n  提交 ${r.id} ${r.name}×${r.quantity} [${r.state}] 已观察=${r.observedIds.length}`).join('')}`
      }).join('\n') || '（无目标）'
      if (args[0] === 'resolve' && ['sent', 'not-sent'].includes(args[2] ?? '')) {
        ctx.runtime.resolveProduction(id, args[2] as 'sent' | 'not-sent')
        return '已按人工核对结果更新生产记录'
      }
      const goal = ctx.runtime.goals.get(id)
      if (!goal) return '目标不存在；goal list 查看目标 ID'
      if (args[0] === 'cancel') {
        await ctx.runtime.cancelGoal(id)
        try { return `目标已取消；${await ctx.controller.refresh(goal.ownerId)}` }
        catch (err) { return `目标已取消，其余目标继续；脚本更新失败：${String(err)}` }
      }
      if (args[0] === 'edit' && goal.spec.kind === 'production') {
        const quantity = Number(args[2])
        return ctx.controller.submit({ ...goal.spec, quantity, rawText: `生产 ${quantity} 个 ${goal.spec.target}` })
      }
      return '用法: goal list | goal cancel <ID> | goal edit <生产目标ID> <总量> | goal resolve <提交ID> sent|not-sent'
    }
    case 'global': {
      if (args[0] === 'pause') { ctx.runtime.pause('global'); return '全局脚本已暂停，编队继续' }
      if (args[0] === 'resume') {
        const program = ctx.runtime.programs.get('global')
        if (!program) return '没有全局目标'
        if (!program.script || program.compileError || program.goalIds.some(id => { const g = ctx.runtime.goals.get(id); return g && JSON.stringify(g.spec) !== JSON.stringify(g.activeSpec) && g.status !== 'cancelled' && g.status !== 'completed' })) return ctx.controller.refresh('global')
        ctx.runtime.resume('global'); return '全局脚本已恢复'
      }
      return '用法: global pause|resume'
    }
    case 'task': {
      const sub = args[0]
      if (sub === 'new') {
        const label = args[1]
        const rest = args.slice(2)
        const formationId = rest[0]?.startsWith('@') ? rest.shift()!.slice(1) : undefined
        if (!label || !formationId) return '用法: task new <标签> @编队 --region=x1,y1,x2,y2 <命令>；请先建队'
        const snap = bridge.latest
        if (!snap) return '尚无快照：请先进入对局'
        const options = combatOptions(rest, snap)
        return ctx.controller.submit({ id: `combat-${randomUUID().slice(0, 8)}`, label, kind: 'combat', rawText: options.text, formationId, region: options.region, allowedActions: options.allowedActions, ...(options.retreat ? { retreat: options.retreat } : {}) })
      }
      if (sub === 'list') {
        return [...ctx.runtime.programs.values()].map(p => `${p.id} [${p.status}${ctx.runtime.hasPendingCommand(p.id) ? '/compiling' : ''}] v${p.script?.version ?? '-'} 目标=${p.goalIds.join(',') || '无'} actions=${p.stats.actions}${p.compileError ? ` 编译失败=${p.compileError}` : ''}${p.stats.lastError ? ` 错误=${p.stats.lastError}` : ''}`).join('\n') || '（无脚本）'
      }
      const id = resolveOwner(args[1] ?? '', ctx)
      if (sub === 'stop') { await ctx.runtime.stop(id); return `${id} 已停止` }
      if (sub === 'pause') { ctx.runtime.pause(id); return `${id} 已暂停` }
      if (sub === 'resume') {
        const program = ctx.runtime.programs.get(id)!
        if (!program.script || program.compileError) return ctx.controller.refresh(id)
        ctx.runtime.resume(id); return `${id} 已恢复`
      }
      return '用法: task new|list|stop|pause|resume …'
    }
    case 'move':
    case 'amove':
    case 'gather': {
      const ids = parseIds(args[0] ?? '', bridge.latest)
      const x = Number(args[1])
      const y = Number(args[2])
      if (!ids?.length || !Number.isFinite(x) || !Number.isFinite(y)) return `用法: ${cmd} <ids|all> <x> <y>`
      if (debugBusy(ids, ctx)) return '单位由活动脚本或待编译命令管理，请先 task stop 对应编队/全局'
      const kind = cmd === 'move' ? 'move' : cmd === 'amove' ? 'attackMove' : 'gather'
      const action: ActionRequest = { kind, unitIds: ids, x, y }
      return JSON.stringify(await bridge.submit(action))
    }
    case 'attack': {
      const ids = parseIds(args[0] ?? '', bridge.latest)
      const targetId = Number(args[1])
      if (!ids?.length || !Number.isFinite(targetId)) return '用法: attack <ids|all> <targetId>'
      if (debugBusy(ids, ctx)) return '单位由活动脚本管理，请先停止对应脚本'
      return JSON.stringify(await bridge.submit({ kind: 'attack', unitIds: ids, targetId }))
    }
    case 'stop': {
      const ids = parseIds(args[0] ?? '', bridge.latest)
      if (!ids?.length) return '用法: stop <ids|all>'
      await ctx.runtime.stopUnits(ids)
      return JSON.stringify(await bridge.submit({ kind: 'stop', unitIds: ids }))
    }
    case 'shot': {
      mkdirSync(join(ROOT, '.runtime/shots'), { recursive: true })
      const file = join(ROOT, `.runtime/shots/${Date.now()}.png`)
      await page.screenshot({ path: file })
      return `截图: ${file}`
    }
    case 'eval': {
      // 调试：页面内求值（只读诊断/受控实验用）。用法: eval <表达式>
      const expr = line.slice(line.indexOf('eval') + 4).trim()
      if (!expr) return '用法: eval <JS 表达式（页面上下文）>'
      const value = await bridge.frame.evaluate(`(() => { try { return { ok: true, value: (${expr}) } } catch (e) { return { ok: false, error: String(e) } } })()`)
      return JSON.stringify(value, null, 2).slice(0, 2000)
    }
    case 'quit':
      return args[0] === 'hard' ? '__QUIT_HARD__' : '__QUIT__'
    default:
      return `未知命令: ${cmd}\n${usage()}`
  }
}
