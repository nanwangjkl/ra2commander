import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CapabilityCall } from '../packages/command/src/index.ts'
import type { CommandContext } from '../apps/companion/src/commands.ts'
import { handleCommand } from '../apps/companion/src/commands.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { CommandLog } from '../apps/companion/src/command-log.ts'
import { runTranscript } from '../apps/companion/src/transcript.ts'
import { applyCommandEvent, type CardData } from '../apps/companion/ui/command-card.ts'
import { code, deferred, harness, outcome, snapshot } from './helpers.ts'

const result = (text: string) => ({ text, model: 'fixture', durationMs: 0 })
const build = (target: string): CapabilityCall => ({ capability: 'production.produce', params: { target, quantity: 1 } })
const move = (x: number): CapabilityCall => ({ capability: 'combat.move', params: { formationId: 'A', x, y: 8 } })
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-concurrent-'))
  const executor = { run: async () => outcome() }, env = await harness(executor)
  const requests = new Map<string, { started: ReturnType<typeof deferred<void>>; reply: ReturnType<typeof deferred<ReturnType<typeof result>>> }>()
  const request = (text: string) => {
    if (!requests.has(text)) requests.set(text, { started: deferred<void>(), reply: deferred<ReturnType<typeof result>>() })
    return requests.get(text)!
  }
  const provider = { generate: async ({ messages }: { messages: Array<{ content: string }> }) => {
    const input = JSON.parse(messages[1]!.content)
    if (!('text' in input)) return result(code)
    const pending = request(input.text); pending.started.resolve()
    // 故意不遵守 AbortSignal，验证网络迟到结果仍会被宿主挡住。
    return pending.reply.promise
  } }
  const log = new CommandLog()
  const ctx = { ...env, commandLog: log, currentProvider: () => provider,
    controller: new ProgramController({ runtime: env.runtime, executor, provider: () => provider as never }),
    bridge: { rules: async (name: string, type: number) => ({ name, type, power: 200, prerequisite: [] }), submit: async () => ({ ok: true }) },
  } as unknown as CommandContext
  const say = (text: string) => { const promise = runTranscript(text, ctx, root); void promise.catch(() => {}); return promise }
  const complete = (text: string, operations: CapabilityCall[]) => request(text).reply.resolve(result(JSON.stringify({ summary: text, operations })))
  const card = (text: string) => {
    let value: CardData | undefined
    const id = log.since(0).find(event => event.text === text)!.commandId
    for (const event of log.since(0).filter(event => event.commandId === id)) value = applyCommandEvent(event, value)
    return value!
  }
  return { ...env, ctx, log, say, complete, card, ready: (text: string) => request(text).started.promise,
    dispose: () => { ctx.transcripts?.cancelAll(); log.flushEvents(); rmSync(root, { recursive: true, force: true }) } }
}

test('空指部与探路式独立请求同时理解，后返回的前序命令仍先绑定，三个建设目标全部保留', async () => {
  const f = await fixture()
  try {
    const first = f.say('造空指部'), second = f.say('探路前建兵营'), third = f.say('造电厂')
    await Promise.all([f.ready('造空指部'), f.ready('探路前建兵营'), f.ready('造电厂')])
    f.complete('探路前建兵营', [build('GAPILE')]); f.complete('造电厂', [build('GAPOWR')])
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.runtime.goals.size, 0, '后序理解已经返回，但还不能越过前序绑定')
    assert.equal(f.card('探路前建兵营').stage, 'queued')
    f.complete('造空指部', [build('GAAIRC')])
    await Promise.all([first, second, third])
    assert.deepEqual([...f.runtime.goals.values()].map(goal => goal.spec.kind === 'production' && goal.spec.target), ['GAAIRC', 'GAPILE', 'GAPOWR'])
    assert.equal(f.log.since(0).some(event => event.stage === 'cancelled'), false)
  } finally { f.dispose() }
})

test('同队移动理解乱序返回仍以后下达的目的地为准，前序失败也不堵住队列', async () => {
  const f = await fixture()
  try {
    const first = f.say('A先去20'), second = f.say('A再去30')
    await Promise.all([f.ready('A先去20'), f.ready('A再去30')])
    f.complete('A再去30', [move(30)]); f.complete('A先去20', [move(20)])
    await Promise.all([first, second])
    const goalId = f.runtime.programs.get('formation:A')!.goalIds[0]!
    const spec = f.runtime.goals.get(goalId)!.spec
    assert.equal(spec.kind === 'combat' && spec.destination?.x, 30)
    const invalid = f.say('无法解析'), later = f.say('之后造电厂')
    await Promise.all([f.ready('无法解析'), f.ready('之后造电厂')])
    f.complete('之后造电厂', [build('GAPOWR')]); f.complete('无法解析', [])
    await Promise.all([invalid, later])
    assert.ok([...f.runtime.goals.values()].some(goal => goal.spec.kind === 'production'))
  } finally { f.dispose() }
})

test('停止全部越过未返回的理解，晚到旧结果不生效，停止之后的新命令正常执行', async () => {
  const f = await fixture()
  try {
    const old = f.say('尚未理解的建设')
    await f.ready('尚未理解的建设')
    const stop = f.say('全部停止')
    await f.ready('全部停止'); f.complete('全部停止', [{ capability: 'control.stop', params: { scope: 'all' } }])
    await stop
    f.complete('尚未理解的建设', [build('GAAIRC')])
    await assert.rejects(old, /中止|停止|取消/)
    assert.equal(f.runtime.goals.size, 0)
    const next = f.say('停止后新造电厂')
    await f.ready('停止后新造电厂'); f.complete('停止后新造电厂', [build('GAPOWR')]); await next
    assert.equal(f.runtime.goals.size, 1)
  } finally { f.dispose() }
})

test('停止一个编队只屏蔽旧命令中的该队行动，建设继续；CLI取消同样拦住迟到生产', async () => {
  const f = await fixture()
  try {
    const old = f.say('建设并移动A')
    await f.ready('建设并移动A')
    const stop = f.say('只停止A')
    await f.ready('只停止A'); f.complete('只停止A', [{ capability: 'control.stop', params: { scope: 'formation', formationId: 'A' } }]); await stop
    f.complete('建设并移动A', [build('GAAIRC'), move(20)]); await old
    assert.deepEqual([...f.runtime.goals.values()].map(goal => goal.spec.kind), ['production'])
    const late = f.say('晚到的追加空指部')
    await f.ready('晚到的追加空指部')
    await handleCommand(`goal cancel ${[...f.runtime.goals.keys()][0]}`, f.ctx)
    f.complete('晚到的追加空指部', [build('GAAIRC')]); await late
    assert.equal(f.runtime.goals.size, 1, '取消目标后旧的同项目追加理解不能复活生产')
  } finally { f.dispose() }
})

test('混合停止与移动命令中停止优先，普通移动仍排在更早的移动之后', async () => {
  const f = await fixture()
  try {
    const old = f.say('较早的A移动'), mixed = f.say('暂停全局然后A去30')
    await Promise.all([f.ready('较早的A移动'), f.ready('暂停全局然后A去30')])
    f.complete('暂停全局然后A去30', [{ capability: 'control.pause', params: { scope: 'global' } }, move(30)])
    await new Promise(resolve => setImmediate(resolve))
    f.complete('较早的A移动', [move(20)])
    await Promise.all([old, mixed])
    const goal = f.runtime.goals.get(f.runtime.programs.get('formation:A')!.goalIds[0]!)!
    assert.equal(goal.spec.kind === 'combat' && goal.spec.destination?.x, 30)
    assert.equal([...f.runtime.goals.values()].filter(goal => goal.spec.kind === 'combat').length, 2)
  } finally { f.dispose() }
})

test('切换对局释放旧绑定队列，即使旧模型晚返回也不能向新局写入目标', async () => {
  const f = await fixture()
  try {
    const old = f.say('旧局的建设')
    await f.ready('旧局的建设')
    await f.runtime.onSnapshot(snapshot({ sessionKey: 'new-battle', seq: 1 }))
    const next = f.say('新局的建设')
    await f.ready('新局的建设'); f.complete('新局的建设', [build('GAPOWR')]); await next
    f.complete('旧局的建设', [build('GAAIRC')]); await assert.rejects(old, /变化|作废/)
    assert.equal(f.runtime.goals.size, 1)
  } finally { f.dispose() }
})

test('尚未创建的编队也可先停止，迟到生产保留，旧移动与后来掩护待命不能恢复行动', async () => {
  const f = await fixture()
  try {
    const old = f.say('造坦克编入1队再出发')
    await f.ready('造坦克编入1队再出发')
    const stop = f.say('1队停止')
    await f.ready('1队停止'); f.complete('1队停止', [{ capability: 'control.stop', params: { scope: 'formation', formationId: '一队' } }]); await stop
    f.complete('造坦克编入1队再出发', [
      { capability: 'production.produce', params: { target: 'MTNK', quantity: 1, formationId: '1队' } },
      { capability: 'combat.move', params: { formationId: '1队', x: 30, y: 8 } },
    ]); await old
    assert.equal(f.runtime.programs.get('formation:1队')!.status, 'stopped')
    assert.deepEqual([...f.runtime.goals.values()].map(goal => goal.spec.kind), ['production'])
    f.formations.create('1队', [3, 4])
    f.runtime.setCover('1队', { runId: 'late-cover', version: '1', escortIds: [4], gap: 4, resumeGap: 2, retryTicks: 90 })
    await f.runtime.onSnapshot(snapshot({ seq: 2 }))
    assert.equal(f.runtime.programs.get('formation:1队')!.status, 'stopped')
    assert.equal(f.submitted.length, 0)
  } finally { f.dispose() }
})
