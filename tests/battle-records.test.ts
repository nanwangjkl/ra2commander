import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { BattleRecords } from '../apps/companion/src/battle-records.ts'
import { CommandLog } from '../apps/companion/src/command-log.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { WorkbenchApi } from '../apps/companion/src/workbench-api.ts'
import { runTranscript } from '../apps/companion/src/transcript.ts'
import { code, harness, outcome, snapshot } from './helpers.ts'

test('归档保留理解请求、失败候选、共享脚本版本和实际事实，换局重启后仍可反馈', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-battle-records-'))
  let records = new BattleRecords(root)
  try {
    const executor = { run: async () => outcome() }
    const { runtime, formations, submitted } = await harness(executor)
    records.setSession(runtime.battleKey)
    const log = new CommandLog(records)
    let generations = 0
    const provider = { generate: async ({ messages }: { messages: Array<{ content: string }> }) => ({
      text: 'text' in JSON.parse(messages[1]!.content)
        ? JSON.stringify({ summary: '生产坦克', operations: [{ capability: 'production.produce', params: { target: 'MTNK', quantity: 1 } }] })
        : ++generations === 1 ? '没有代码' : `${code}\n// 候选 ${generations}`,
      model: 'fixture', durationMs: 1,
    }) }
    const ctx = { runtime, formations, commandLog: log, currentProvider: () => provider, bridge: { rules: async (name: string) => ({ label: name }) },
      controller: new ProgramController({ runtime, executor, provider: () => provider as never, recordCompilation: records.compilation }), providers: new Map(), browser: {}, page: {} } as unknown as CommandContext
    await runTranscript('制造一辆坦克', ctx, root)
    await runTranscript('再制造一辆坦克', ctx, root)
    records.observe(runtime)
    const before = records.read(records.currentId!)!
    assert.equal(Object.keys(before.transcripts).length, 2)
    assert.ok(Object.values(before.transcripts).every(item => item.rawResponse && Array.isArray(item.messages)))
    assert.ok(before.compilations.some(item => item.stage === 'response' && (item.response as { text: string }).text === '没有代码'))
    assert.ok(before.compilations.some(item => item.stage === 'validation' && (item.errors as string[]).length))
    const effective = before.compilations.filter(item => item.stage === 'effective')
    assert.deepEqual(effective.map(item => item.version), [1, 2])
    assert.equal(effective[1]!.goalIds.length, 2, '全局新版本关联保留的两个目标')
    runtime.pause('global')
    runtime.programs.get('global')!.stats.lastError = '修复上下文故障'
    await ctx.controller.refresh('global', true)
    assert.ok(before.compilations.some(item => item.repair && item.stage === 'request' && (item.messages as Array<{ content: string }>).some(message => message.content.includes('修复上下文故障'))))
    assert.ok(before.observations.at(-1)!.goals.every(goal => goal.execution?.state === 'running'), '提交脚本不算完成')
    const oldId = before.id, commandId = Object.keys(before.transcripts)[0]!
    await runtime.onSnapshot(snapshot({ sessionKey: 'next-battle', seq: 1 }))
    records.setSession(runtime.battleKey)
    records.close()
    records = new BattleRecords(root)
    const feedback = records.feedback(oldId, commandId, 'bad', '没有按预期行动')
    assert.equal(feedback.observed.find(event => event.stage === 'execution')!.execution!.state, 'running')
    records.feedback(oldId, commandId, 'partial', '补充说明：之后才开始执行')
    records.close()
    records = new BattleRecords(root)
    assert.equal(records.read(oldId)!.feedback.length, 2, '反馈修改保留历次意见')
    assert.equal(records.list().find(item => item.id === oldId)!.issues, 1)
    const summary = readFileSync(join(root, '.runtime/battles', oldId, 'summary.md'), 'utf8')
    assert.match(summary, /没有按预期行动/)
    assert.match(summary, /候选 2/)
    assert.equal(submitted.length, 0, '读档与反馈不会执行游戏动作')
  } finally { records.close(); rmSync(root, { recursive: true, force: true }) }
})

class Response extends EventEmitter {
  chunks: string[] = []; writableEnded = false; destroyed = false; status = 0
  writeHead(status: number) { this.status = status }
  end(value?: string) { if (value) this.chunks.push(value); this.writableEnded = true }
}
function request(url: string, method = 'GET', value?: unknown, origin?: string): IncomingMessage {
  return Object.assign(Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]), { url, method, headers: { host: '127.0.0.1:8787', ...(origin ? { origin } : {}) } }) as IncomingMessage
}

test('游戏未就绪时仍可查看旧命令和保存反馈，接口拒绝无效或跨来源写入', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-battle-api-'))
  const records = new BattleRecords(root)
  const api = new WorkbenchApi({ log: new CommandLog(), records, ready: () => false, status: async () => 'waiting', submit: async () => {} })
  try {
    records.event({ commandId: 'cmd-failed', source: 'sidebar', sessionKey: '', text: '测试', stage: 'received', at: 1, seq: 1 })
    records.event({ commandId: 'cmd-failed', source: 'sidebar', sessionKey: '', error: '请先进入对局', stage: 'failed', at: 2, seq: 2 })
    const battleId = records.list()[0]!.id
    const get = new Response()
    await api.handle(request(`/commander/records/${battleId}`), get as never)
    assert.equal(get.status, 200)
    assert.equal(JSON.parse(get.chunks.join('')).events[1].stage, 'failed')
    for (const [rating, commandId, origin, expected] of [['bad', 'cmd-failed', undefined, 200], ['invalid', 'cmd-failed', undefined, 400], ['bad', 'absent', undefined, 400], ['good', 'cmd-failed', 'https://elsewhere.test', 403]] as const) {
      const response = new Response()
      await api.handle(request('/commander/feedback', 'POST', { battleId, commandId, rating, note: '备注' }, origin), response as never)
      assert.equal(response.status, expected)
    }
    const current = new Response()
    await api.handle(request('/commander/commands'), current as never)
    assert.equal(current.status, 200)
    const view = JSON.parse(current.chunks.join(''))
    assert.equal(view.battleId, battleId)
    assert.equal(view.events.length, 2)
    assert.equal(view.feedback[0].note, '备注')
    assert.deepEqual(Object.keys(view).sort(), ['battleId', 'events', 'feedback', 'sessionKey', 'warning'], '侧栏只读取命令与反馈，不带归档正文或代码')
    records.setSession('new-battle')
    const next = new Response()
    await api.handle(request('/commander/commands'), next as never)
    assert.deepEqual(JSON.parse(next.chunks.join('')).events, [], '新局侧栏不载入旧局命令')
    assert.equal(records.read(battleId)!.feedback.length, 1, '移除历史 UI 不删除归档')
    const traversal = new Response()
    await api.handle(request('/commander/records/not-a-battle'), traversal as never)
    assert.equal(traversal.status, 404)
  } finally { api.close(); records.close(); rmSync(root, { recursive: true, force: true }) }
})

test('中断的末行保留备份并可继续追加，不吞掉后续反馈', () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-battle-tail-'))
  let records = new BattleRecords(root)
  try {
    records.event({ commandId: 'a', source: 'cli', sessionKey: 'old', text: '命令', stage: 'received', at: 1, seq: 1 })
    const id = records.list()[0]!.id
    records.close()
    appendFileSync(join(root, '.runtime/battles', id, 'events.jsonl'), '{"kind":')
    records = new BattleRecords(root)
    assert.equal(records.read(id)!.events.length, 1)
    records.feedback(id, 'a', 'bad', '保存后关闭游戏')
    records.close()
    records = new BattleRecords(root)
    assert.equal(records.read(id)!.feedback.length, 1)
    assert.equal(readFileSync(join(root, '.runtime/battles', id, 'events.jsonl.incomplete'), 'utf8'), '{"kind":')
  } finally { records.close(); rmSync(root, { recursive: true, force: true }) }
})

test('归档按侧栏相同规则汇总多目标状态，重启后的低序号事件仍能更新已完成', () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-summary-state-'))
  let records = new BattleRecords(root)
  const base = { commandId: 'multi', source: 'sidebar' as const, sessionKey: 'battle', at: 1 }
  try {
    records.event({ ...base, stage: 'received', text: '建设并探路', seq: 1 })
    records.event({ ...base, stage: 'bound', goalId: 'one', owner: 'global', seq: 2 })
    records.event({ ...base, stage: 'bound', goalId: 'two', owner: 'formation:A', seq: 3 })
    records.event({ ...base, stage: 'generating', owner: 'formation:A', seq: 4 })
    records.event({ ...base, stage: 'execution', goalId: 'one', execution: { state: 'completed' }, seq: 5 })
    records.event({ ...base, stage: 'execution', goalId: 'two', execution: { state: 'running' }, seq: 6 })
    const id = records.list()[0]!.id
    assert.match(records.markdown(records.read(id)!), /- 命令：执行中/)
    records.close()
    records = new BattleRecords(root)
    records.event({ ...base, stage: 'execution', goalId: 'two', execution: { state: 'completed', progress: { completed: 17, total: 17 } }, seq: 1 })
    records.close()
    const summary = readFileSync(join(root, '.runtime/battles', id, 'summary.md'), 'utf8')
    assert.match(summary, /- 命令：已完成/)
    assert.match(summary, /- two：已完成（17\/17）/)
    assert.doesNotMatch(summary, /- 命令：生成中/)
    assert.equal(records.read(id)!.events.length, 7, '修复只改派生摘要，不覆盖原始事件')
  } finally { records.close(); rmSync(root, { recursive: true, force: true }) }
})
