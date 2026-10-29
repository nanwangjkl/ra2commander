import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommandEvent } from '../packages/contracts/src/index.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { CommandLog } from '../apps/companion/src/command-log.ts'
import { runTranscript } from '../apps/companion/src/transcript.ts'
import { WorkbenchApi } from '../apps/companion/src/workbench-api.ts'
import { bindDefaultMap } from '../apps/companion/src/map-binding.ts'
import { applyCommandEvent, type CardData } from '../apps/companion/ui/command-card.ts'
import { activate, code, deferred, harness, outcome, production, snapshot, spec } from './helpers.ts'

const modelResult = (text: string) => ({ text, model: 'fixture', durationMs: 0 })
const plan = JSON.stringify({ summary: '制造电厂', operations: [{ capability: 'production.produce', params: { target: 'GAPOWR', quantity: 1 } }] })
const executor = { run: async () => outcome() }
const rules = async (name: string, type: number) => name === 'GAPOWR' && type === 2 ? { label: 'Power Plant', power: 200 } : undefined
const provider = { generate: async (input: { messages: Array<{ content: string }> }) => modelResult('text' in JSON.parse(input.messages[1]!.content) ? plan : code) }
async function context(): Promise<CommandContext> {
  const { runtime, formations } = await harness(executor)
  return { runtime, formations, commandLog: new CommandLog(), controller: new ProgramController({ runtime, executor, provider: () => provider as never }),
    currentProvider: () => provider as never, bridge: { rules } as never, browser: {} as never, page: {} as never, providers: new Map() }
}
function render(events: CommandEvent[]): Map<string, CardData> {
  const cards = new Map<string, CardData>()
  for (const event of events) cards.set(event.commandId, applyCommandEvent(event, cards.get(event.commandId)))
  return cards
}

test('规则/模型早期失败、解析取消和零目标都有明确结束反馈', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-feedback-'))
  try {
    for (const failure of ['rules', 'model', 'json', 'empty']) {
      const ctx = await context()
      if (failure === 'rules') ctx.bridge = { rules: async () => { throw new Error('规则连接失败') } } as never
      else ctx.currentProvider = () => ({ generate: async () => {
        if (failure === 'model') throw new Error('模型连接失败')
        return modelResult(failure === 'json' ? 'invalid json' : JSON.stringify({ summary: '没有可执行目标', operations: [] }))
      } }) as never
      await runTranscript('测试原话', ctx, root).catch(() => {})
      const events = ctx.commandLog!.since(0)
      assert.equal(events[0]!.text, '测试原话')
      assert.equal(events.at(-1)!.stage, 'failed', failure)
      assert.ok(events.at(-1)!.error)
    }
    const ctx = await context()
    const started = deferred<void>()
    ctx.currentProvider = () => ({ generate: async ({ signal }: { signal: AbortSignal }) => {
      started.resolve()
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    } }) as never
    const pending = runTranscript('取消中的原话', ctx, root)
    await started.promise
    ctx.transcripts!.cancelAll(new Error('已被玩家取消'))
    await assert.rejects(pending)
    assert.equal(ctx.commandLog!.since(0).at(-1)!.stage, 'cancelled')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('生成被停止不会报生效，合并目标等真实提交后再更新旧卡片', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-feedback-'))
  try {
    const ctx = await context()
    const started = deferred<void>(), resume = deferred<void>()
    ctx.controller = new ProgramController({ runtime: ctx.runtime, executor, provider: () => provider as never,
      prepare: async goals => { started.resolve(); await resume.promise; return goals } })
    const stopped = runTranscript('制造电厂', ctx, root)
    await started.promise
    ctx.runtime.cancelAllCommands()
    resume.resolve()
    await stopped
    assert.equal(ctx.runtime.programs.get('global')!.script, undefined)
    assert.equal(ctx.commandLog!.since(0).at(-1)!.stage, 'cancelled')
    assert.ok(!ctx.commandLog!.since(0).some(event => event.stage === 'effective'))

    const merged = await context()
    const oldStarted = deferred<void>(), oldResume = deferred<void>(), nextStarted = deferred<void>(), nextResume = deferred<void>()
    let calls = 0
    merged.controller = new ProgramController({ runtime: merged.runtime, executor, provider: () => provider as never,
      prepare: async goals => { if (++calls === 1) { oldStarted.resolve(); await oldResume.promise } else { nextStarted.resolve(); await nextResume.promise }; return goals } })
    const first = runTranscript('第一个电厂', merged, root)
    await oldStarted.promise
    const oldId = merged.commandLog!.since(0)[0]!.commandId
    const second = runTranscript('第二个电厂', merged, root)
    await nextStarted.promise
    oldResume.resolve()
    await first
    assert.equal(render(merged.commandLog!.since(0)).get(oldId)!.stage, 'merged')
    assert.ok(merged.commandLog!.since(0).filter(event => event.stage === 'merged').every(event => !event.error), '正常合并不记为错误')
    assert.equal(render(merged.commandLog!.since(0)).get(oldId)!.error, '')
    assert.ok([...render(merged.commandLog!.since(0)).get(oldId)!.goals.values()].every(goal => !goal.error))
    nextResume.resolve()
    await second
    const cards = [...render(merged.commandLog!.since(0)).values()]
    assert.ok(cards.every(card => card.stage === 'running'))
    assert.ok(cards.every(card => [...card.goals.values()].every(goal => goal.version === 1)))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('后续生产合并全局生成时继续原命令的独立编队生成，明确停止全部仍可中断', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-multi-owner-'))
  try {
    for (const stop of [false, true]) {
      const ctx = await context(), started = deferred<void>(), resume = deferred<void>()
      let firstGlobal = true, formationCompiles = 0
      const model = { generate: async (input: { messages: Array<{ content: string }> }) => {
        const value = JSON.parse(input.messages[1]!.content)
        if (!('text' in value)) return modelResult(code)
        return modelResult(JSON.stringify({ summary: value.text, operations: value.text === '第一条' ? [
          { capability: 'production.produce', params: { target: 'GAPOWR', quantity: 1 } },
          { capability: 'combat.move', params: { formationId: 'A', x: 9, y: 9 } },
        ] : stop ? [{ capability: 'control.stop', params: { scope: 'all' } }] : [{ capability: 'production.produce', params: { target: 'GAPOWR', quantity: 1 } }] }))
      } }
      ctx.currentProvider = () => model as never
      ctx.bridge = { rules, submit: async () => ({ ok: true }) } as never
      ctx.controller = new ProgramController({ runtime: ctx.runtime, executor, provider: () => model as never,
        prepare: async goals => {
          if (goals.some(goal => goal.kind === 'combat')) formationCompiles++
          if (firstGlobal && goals.some(goal => goal.kind === 'production')) { firstGlobal = false; started.resolve(); await resume.promise }
          return goals
        } })
      const first = runTranscript('第一条', ctx, root)
      await started.promise
      const firstId = ctx.commandLog!.since(0)[0]!.commandId
      await runTranscript(stop ? '停止全部' : '再造一个', ctx, root)
      resume.resolve(); await first
      const goal = [...ctx.runtime.goals.values()].find(goal => goal.spec.kind === 'combat')!
      assert.equal(formationCompiles, stop ? 0 : 1)
      assert.equal(goal.status, stop ? 'cancelled' : 'active')
      if (!stop) {
        assert.ok(goal.activeSpec)
        assert.equal(ctx.commandLog!.since(0).some(event => event.commandId === firstId && event.stage === 'cancelled'), false)
        assert.equal(render(ctx.commandLog!.since(0)).get(firstId)!.error, '')
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('自动绑定冰天雪地，移动与建造描述对应各自目标，部分失败不覆盖成功', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-feedback-'))
  try {
    const ctx = await context()
    await ctx.runtime.onSnapshot(snapshot({ seq: 2, mapWidth: 256, mapHeight: 256 }))
    const mixed = { generate: async (input: { messages: Array<{ content: string }> }) => {
      const payload = JSON.parse(input.messages[1]!.content)
      if ('text' in payload) {
        assert.equal(payload.map.name, '冰天雪地')
        return modelResult(JSON.stringify({ summary: 'A队去三楼右下并造电厂', operations: [{ capability: 'combat.move', params: { formationId: 'A', regionName: '三楼右下' } }, { capability: 'production.produce', params: { target: 'GAPOWR', quantity: 1 } }] }))
      }
      if (payload.control.owner.kind === 'global') throw new Error('电厂脚本生成失败')
      return modelResult(code)
    } }
    ctx.currentProvider = () => mixed as never
    ctx.controller = new ProgramController({ runtime: ctx.runtime, executor, provider: () => mixed as never })
    await runTranscript('A队去三楼右下并造电厂', ctx, root)
    const card = [...render(ctx.commandLog!.since(0)).values()][0]!
    const goals = [...card.goals.values()]
    assert.equal(card.stage, 'partial')
    assert.match(goals[0]!.choice, /A 前往三楼右下/)
    assert.equal(goals[0]!.stage, 'effective')
    assert.match(goals[1]!.choice, /Power Plant/)
    assert.equal(goals[1]!.stage, 'failed')
    assert.equal(ctx.mapSessionKey, 'battle-a')
    await ctx.runtime.onSnapshot(snapshot({ sessionKey: 'battle-b', seq: 1 }))
    await bindDefaultMap(ctx)
    assert.equal(ctx.mapSessionKey, 'battle-b')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('一队生效不会提前标记其他队，重复事件不会追加未执行原因', () => {
  let seq = 0
  let card: CardData | undefined
  const send = (event: Partial<CommandEvent> & Pick<CommandEvent, 'stage'>) => card = applyCommandEvent({ commandId: 'a', source: 'cli', seq: ++seq, at: 0, ...event }, card)
  send({ stage: 'bound', goalId: 'A', owner: 'formation:A', choice: 'A队进攻' })
  send({ stage: 'bound', goalId: 'B', owner: 'formation:B', choice: 'B队进攻' })
  send({ stage: 'effective', goalId: 'A', owner: 'formation:A', version: 1 })
  assert.equal(card!.stage, 'generating')
  assert.equal(card!.goals.get('B')!.stage, 'bound')
  send({ stage: 'failed', owner: 'formation:B', error: 'B队生成失败' })
  assert.equal(card!.stage, 'partial')
  assert.equal(card!.goals.get('B')!.stage, 'failed')
  send({ stage: 'skipped', error: '缺少编队' })
  send({ stage: 'skipped', error: '缺少编队' })
  assert.equal(card!.skipped.size, 1)
})

function bind(log: CommandLog, goalId: string, owner = 'global', commandId = 'tracked') {
  log.emit({ commandId, source: 'cli', sessionKey: 'battle-a', stage: 'bound', goalId, owner, choice: goalId })
}

test('事件窗口滚动后老目标仍推送完成，已完成生产追加总量继续跟踪', async () => {
  const { runtime } = await harness(executor)
  activate(runtime, production({ id: 'tank' }))
  const log = new CommandLog(), delivered: CommandEvent[] = []
  log.subscribe(event => delivered.push(event))
  bind(log, 'tank')
  log.syncRuntime(runtime)
  for (let n = 0; n < 2100; n++) log.emit({ commandId: `other-${n}`, source: 'cli', stage: 'received', text: '其他命令' })
  assert.ok(!log.since(0).some(event => event.commandId === 'tracked'), '老事件已离开重连窗口')
  const before = log.lastSeq(), born = { ...snapshot().self[0]!, id: 11 }
  runtime.production.push({ id: 'sent', goalId: 'tank', name: 'MTNK', quantity: 1, building: false, state: 'submitted', observedIds: [], placed: false })
  await runtime.onSnapshot(snapshot({ seq: 2, self: [...snapshot().self, born] }))
  log.syncRuntime(runtime)
  assert.equal(log.since(before).find(event => event.goalId === 'tank')!.execution!.state, 'completed')
  for (let n = 0; n < 2100; n++) log.emit({ commandId: `later-${n}`, source: 'cli', stage: 'received', text: '后续命令' })
  activate(runtime, production({ id: 'tank', quantity: 2 }))
  const updated = log.lastSeq()
  log.syncRuntime(runtime)
  const progress = log.since(updated).find(event => event.goalId === 'tank')!
  assert.equal(progress.commandId, 'tracked')
  assert.equal(progress.execution!.progress!.total, 2)
  assert.notEqual(progress.execution!.state, 'completed')
  await runtime.onSnapshot(snapshot({ sessionKey: 'battle-b', seq: 1 }))
  log.syncRuntime(runtime)
  assert.equal(delivered.filter(event => event.goalId === 'tank').at(-1)!.execution!.state, 'cancelled')
  const ended = log.lastSeq()
  log.syncRuntime(runtime)
  assert.equal(log.lastSeq(), ended, '结束对局的目标关联已释放')
})

test('实际产出后才完成，持续补电保持执行中，暂停与运行故障不伪装为完成', async () => {
  let sent = false, fault = false
  const { runtime } = await harness({ run: async () => {
    if (fault) return { ok: false, error: 'fixture 脚本异常', actions: [], memory: {} }
    if (sent) return outcome()
    sent = true
    return outcome([{ kind: 'produce', name: 'MTNK', quantity: 1 }], {}, 'tank')
  } })
  activate(runtime, production({ id: 'tank' }))
  activate(runtime, production({ id: 'power', target: 'NAPOWR', targetType: 2, maintainPower: { reserve: 100, output: 200 } }))
  const log = new CommandLog()
  bind(log, 'tank'); bind(log, 'power')
  await runtime.onSnapshot(snapshot({ seq: 2 }))
  log.syncRuntime(runtime)
  let card = render(log.since(0)).get('tracked')!
  assert.equal(card.stage, 'running')
  assert.equal(card.goals.get('tank')!.execution!.progress!.completed, 0)
  assert.equal(card.goals.get('power')!.execution!.state, 'continuous')
  const born = { ...snapshot().self[0]!, id: 11 }
  const observed = snapshot({ seq: 3, self: [...snapshot().self, born] })
  await runtime.onSnapshot(observed)
  log.syncRuntime(runtime)
  card = render(log.since(0)).get('tracked')!
  assert.equal(card.goals.get('tank')!.execution!.state, 'completed')
  assert.equal(card.stage, 'continuous')
  const last = log.lastSeq()
  log.syncRuntime(runtime)
  assert.equal(log.lastSeq(), last, '相同状态不按快照刷事件')
  runtime.pause('global'); log.syncRuntime(runtime)
  assert.equal(render(log.since(0)).get('tracked')!.stage, 'paused')
  runtime.resume('global'); log.syncRuntime(runtime)
  assert.equal(render(log.since(0)).get('tracked')!.stage, 'continuous')
  fault = true
  for (const seq of [4, 5, 6]) await runtime.onSnapshot({ ...observed, seq })
  log.syncRuntime(runtime)
  card = render(log.since(0)).get('tracked')!
  assert.equal(card.stage, 'faulted')
  assert.equal(card.goals.get('tank')!.execution!.state, 'completed')
  await runtime.cancelGoal('power'); log.syncRuntime(runtime)
  assert.equal(render(log.since(0)).get('tracked')!.stage, 'partial-completed')
})

test('展开命令按建筑实际出现完成，重启恢复完成卡片不重放动作', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-completion-'))
  try {
    const { runtime, submitted } = await harness({ run: async () => outcome([{ kind: 'deploy', unitIds: [1] }], {}, 'base') })
    const mcv = { ...snapshot().self[0]!, name: 'AMCV', canDeploy: true }
    await runtime.onSnapshot(snapshot({ seq: 2, self: [mcv] }))
    const goal = { id: 'base', kind: 'deploy' as const, rawText: '展开基地', unitIds: [1], target: 'GACNST' }
    activate(runtime, goal)
    const log = new CommandLog()
    bind(log, 'base')
    await runtime.onSnapshot(snapshot({ seq: 3, self: [mcv] }))
    log.syncRuntime(runtime)
    assert.equal(render(log.since(0)).get('tracked')!.stage, 'running')
    await runtime.onSnapshot(snapshot({ seq: 4, self: [{ ...mcv, id: 40, name: 'GACNST', type: 2, canDeploy: false }] }))
    log.syncRuntime(runtime)
    assert.equal(render(log.since(0)).get('tracked')!.stage, 'completed')
    assert.equal(runtime.programs.get('global')!.status, 'idle')
    log.emit({ commandId: 'tracked', source: 'cli', goalId: 'base', stage: 'effective', version: 1 })
    assert.equal(render(log.since(0)).get('tracked')!.stage, 'completed', '迟到的生成事件不能覆盖完成事实')
    mkdirSync(join(root, '.runtime/transcripts'), { recursive: true })
    writeFileSync(join(root, '.runtime/transcripts/base.json'), JSON.stringify({ requestId: 'base', text: '展开基地', sessionKey: 'battle-a', goals: [goal], choices: ['展开基地车 #1'] }))
    const count = submitted.length
    const restored = new CommandLog()
    restored.restoreCurrent(root, runtime)
    assert.equal([...render(restored.since(0)).values()][0]!.stage, 'completed')
    assert.equal(submitted.length, count)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('移动等待所有存活队员实际到达，守区持续运行，同局新脚本不覆盖旧完成状态', async () => {
  const { runtime, formations } = await harness({ run: async () => outcome() })
  formations.transfer([2], 'A')
  activate(runtime, spec({ id: 'move', destination: { x: 8, y: 8 }, allowedActions: ['move', 'stop'] }))
  const log = new CommandLog()
  bind(log, 'move', 'formation:A', 'move-command')
  await runtime.onSnapshot(snapshot({ seq: 2, self: snapshot().self.map(unit => unit.id === 1 ? { ...unit, rx: 8, ry: 8 } : unit) }))
  log.syncRuntime(runtime)
  assert.equal(render(log.since(0)).get('move-command')!.stage, 'running')
  await runtime.onSnapshot(snapshot({ seq: 3, self: snapshot().self.map(unit => [1, 2].includes(unit.id) ? { ...unit, rx: 8, ry: 8 } : unit) }))
  log.syncRuntime(runtime)
  assert.equal(render(log.since(0)).get('move-command')!.stage, 'completed')
  activate(runtime, spec({ id: 'hold' }))
  bind(log, 'hold', 'formation:A', 'hold-command')
  log.syncRuntime(runtime)
  const cards = render(log.since(0))
  assert.equal(cards.get('move-command')!.stage, 'completed')
  assert.equal(cards.get('hold-command')!.stage, 'continuous')
})

class Response extends EventEmitter {
  chunks: string[] = []
  writableEnded = false
  destroyed = false
  status = 0
  writeHead(status: number) { this.status = status }
  flushHeaders() {}
  write(value: string) { this.chunks.push(value); return true }
  end(value?: string) { if (value) this.chunks.push(value); this.writableEnded = true }
}
function request(url: string, method = 'GET', body = '', headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { url, method, headers }) as IncomingMessage
}

test('工作台接收同一命令 ID，重启游标不漏新消息，退出主动关闭 SSE', async () => {
  const log = new CommandLog()
  const api = new WorkbenchApi({ log, ready: () => true, status: async () => 'ready', submit: async (text, commandId) => { log.emit({ commandId, text, source: 'sidebar', stage: 'received' }) } })
  const post = new Response()
  const commandId = 'cmd-12345678'
  await api.handle(request('/commander/say', 'POST', JSON.stringify({ text: '展开基地', commandId })), post as never)
  assert.equal(post.status, 202)
  assert.equal(log.since(0)[0]!.commandId, commandId)
  const invalid = new Response()
  await api.handle(request('/commander/say', 'POST', 'null'), invalid as never)
  assert.equal(invalid.status, 400)
  const stream = new Response()
  await api.handle(request('/commander/events', 'GET', '', { 'last-event-id': 'old-process:9999' }), stream as unknown as ServerResponse)
  assert.ok(stream.chunks.join('').includes('展开基地'))
  const count = stream.chunks.length
  api.close()
  assert.equal(stream.writableEnded, true)
  log.emit({ commandId, source: 'sidebar', stage: 'understood', summary: '不再写入已退出连接' })
  assert.equal(stream.chunks.length, count)
})

test('状态查询失败返回连接错误，后续查询恢复，不把失败报告为游戏加载中', async () => {
  let failed = true
  const api = new WorkbenchApi({ log: new CommandLog(), ready: () => true, submit: async () => {},
    status: async () => { if (failed) throw new Error('Target page has been closed'); return 'ready' } })
  const disconnected = new Response()
  await api.handle(request('/commander/status'), disconnected as never)
  assert.equal(disconnected.status, 503)
  assert.match(JSON.parse(disconnected.chunks.join('')).error, /游戏连接暂时不可用/)
  failed = false
  const connected = new Response()
  await api.handle(request('/commander/status'), connected as never)
  assert.equal(connected.status, 200)
  assert.deepEqual(JSON.parse(connected.chunks.join('')), { game: 'ready' })
})
