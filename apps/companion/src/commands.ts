import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Browser, Page } from 'playwright'
import { ownerId, type ActionRequest, type Snapshot } from '@ra2c/contracts'
import type { OpenAICompatibleProvider } from '@ra2c/model-providers'
import type { TaskRuntime, FormationRegistry } from '@ra2c/runtime'
import type { WerhdBridge } from '@ra2c/game-werhd'
import { ProgramController } from './controller.ts'
import { combatOptions, productionOptions } from './command-options.ts'
import type { MapRegionIndex } from '../../../packages/maps/src/index.ts'
import { loadIceMap } from './map-binding.ts'
import { runTranscript } from './transcript.ts'
import type { CommandLog } from './command-log.ts'
import { executeCapabilities, executeCapability, executionText, loadCommandPrompts } from './capabilities/index.ts'
const ROOT = resolve(import.meta.dirname, '../../..')

export function usage(): string {
  return [
    '命令：',
    '  say <文字>             把文字作为模拟语音转写，解析目标并生成脚本',
    '  cap list / cap <能力ID> <JSON参数>  统一玩家能力入口',
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
  mapPlayableArea?: import('../../../packages/maps/src/index.ts').PlayableAreaIndex
  transcriptAbort?: AbortController
  /** 命令记录（阶段 2）：界面/终端/TCP 的 say 统一入流。 */
  commandLog?: CommandLog
}

const TYPE_LABEL: Record<number, string> = { 1: '空军', 2: '建筑', 3: '步兵', 7: '车辆' }

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
      const { regions, area } = await loadIceMap()
      ctx.mapRegions = regions
      ctx.mapPlayableArea = area
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
    case 'cap': {
      if (args[0] === 'list') return loadCommandPrompts().capabilities.definitions().map(definition => `${definition.id} ${definition.name}`).join('\n')
      if (!args[0]) return '用法: cap list | cap <能力ID> <JSON参数>'
      const params = JSON.parse(args.slice(1).join(' ') || '{}')
      return executionText(await executeCapabilities([{ capability: args[0], params }], ctx, { text: line }))
    }
    case 'form': {
      const sub = args[0], name = args[1], filter = args[2]
      if (sub === 'list') return ctx.formations.list().map(formation => `  ${formation.id}: 成员 ${formation.memberIds.length}/${formation.originalMemberIds.length}（原始基准）`).join('\n') || '（无编队）'
      if (sub === 'create') {
        if (!name || !filter) return '用法: form create <名> <ids|tanks|infantry|vehicles|all> [--force]'
        const ids = /^[\d,-]+$/.test(filter) ? parseIds(filter, bridge.latest) : undefined
        return executeCapability('formation.create', { formationId: name, ...(ids ? { unitIds: ids } : { selector: filter }), force: args.includes('--force') }, ctx, line)
      }
      if (sub === 'transfer') {
        const ids = parseIds(name ?? '', bridge.latest)
        if (!ids?.length || !filter) return '用法: form transfer <ids> <编队名>'
        return executeCapability('formation.transfer', { formationId: filter, unitIds: ids }, ctx, line)
      }
      if (sub === 'dissolve' && name) return executeCapability('formation.dissolve', { formationId: name }, ctx, line)
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
      return executeCapability('production.produce', { target, ...(options.quantity !== undefined ? { quantity: options.quantity } : {}), ...(options.queues ? { queues: options.queues } : {}) }, ctx, options.text || line)
    }
    case 'reinforce': {
      const formationId = args[0]?.replace(/^@/, ''), target = args[1], targetSize = Number(args[2]), sourceArg = args[3]
      if (!formationId || !target || !Number.isSafeInteger(targetSize) || targetSize < 1 || (sourceArg && !sourceArg.startsWith('--source=@'))) return '用法: reinforce @编队 <兵种名> <维持数量> [--source=@来源编队]'
      return executeCapability('management.reinforce', { formationId, target, targetSize, ...(sourceArg ? { sourceFormationId: sourceArg.slice(10) } : {}) }, ctx, line)
    }
    case 'rally': {
      if (args[0] === 'all') return executeCapability('management.rally', { selector: 'all', x: Number(args[1]), y: Number(args[2]) }, ctx, line)
      const ids = parseIds(args[0] ?? '', bridge.latest)
      if (!ids?.length) return '用法: rally <ids|all> <x> <y>'
      return executeCapability('management.rally', { unitIds: ids, x: Number(args[1]), y: Number(args[2]) }, ctx, line)
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
      if (args[0] === 'cancel') return executeCapability('goal.cancel', { goalId: id }, ctx, line)
      if (args[0] === 'edit') return executeCapability('goal.edit', { goalId: id, quantity: Number(args[2]) }, ctx, line)
      return '用法: goal list | goal cancel <ID> | goal edit <生产目标ID> <总量> | goal resolve <提交ID> sent|not-sent'
    }
    case 'global': {
      if (args[0] === 'pause') return executeCapability('control.pause', { scope: 'global' }, ctx, line)
      if (args[0] === 'resume') return executeCapability('control.resume', { scope: 'global' }, ctx, line)
      if (args[0] === 'stop') return executeCapability('control.stop', { scope: 'global' }, ctx, line)
      return '用法: global stop|pause|resume'
    }
    case 'task': {
      const sub = args[0]
      if (sub === 'new') {
        const label = args[1], rest = args.slice(2)
        const formationId = rest[0]?.startsWith('@') ? rest.shift()!.slice(1) : undefined
        if (!label || !formationId) return '用法: task new <标签> @编队 --region=x1,y1,x2,y2 <命令>'
        const snap = bridge.latest
        if (!snap) return '尚无快照：请先进入对局'
        const options = combatOptions(rest, snap)
        return executeCapability('combat.hold', { formationId, label, bounds: [options.region.x1, options.region.y1, options.region.x2, options.region.y2], ...(options.mode ? { mode: options.mode } : {}), ...(options.retreat ? { retreatLoss: options.retreat.lossAbove, retreatX: options.retreat.x, retreatY: options.retreat.y } : {}) }, ctx, options.text)
      }
      if (sub === 'list') return [...ctx.runtime.programs.values()].map(program => `${program.id} [${program.status}${ctx.runtime.hasPendingCommand(program.id) ? '/compiling' : ''}] v${program.script?.version ?? '-'} 目标=${program.goalIds.join(',') || '无'} actions=${program.stats.actions}${program.compileError ? ` 编译失败=${program.compileError}` : ''}${program.stats.lastError ? ` 错误=${program.stats.lastError}` : ''}`).join('\n') || '（无脚本）'
      const formationId = args[1]
      if (!formationId) return '用法: task new|list|stop|pause|resume …'
      if (sub === 'stop') return executeCapability('control.stop', { scope: 'formation', formationId }, ctx, line)
      if (sub === 'pause') return executeCapability('control.pause', { scope: 'formation', formationId }, ctx, line)
      if (sub === 'resume') return executeCapability('control.resume', { scope: 'formation', formationId }, ctx, line)
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
      if (args[0] === 'all') return executeCapability('control.stop', { scope: 'units', selector: 'all' }, ctx, line)
      const ids = parseIds(args[0] ?? '', bridge.latest)
      if (!ids?.length) return '用法: stop <ids|all>'
      return executeCapability('control.stop', { scope: 'units', unitIds: ids }, ctx, line)
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
