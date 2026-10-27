import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync, gzipSync } from 'node:zlib'
import { decodeObservation, encodeObservation } from '../apps/companion/src/battle-codec.ts'
import { compactBattle, exportBattle, logicalEntries, openBattleBundle } from '../apps/companion/src/battle-export.ts'
import { BattleJournal, type ArchiveEntry } from '../apps/companion/src/battle-storage.ts'
import { BattleRecords } from '../apps/companion/src/battle-records.ts'
import { activate, harness, outcome, production } from './helpers.ts'

function legacy(root: string) {
  const sessionKey = 'legacy-large', id = `battle-${createHash('sha256').update(sessionKey).digest('hex').slice(0, 24)}`, folder = join(root, '.runtime/battles', id)
  mkdirSync(join(folder, 'objects'), { recursive: true })
  const region = { id: 'floor1', name: '一楼', cells: Array.from({ length: 1800 }, (_, n) => [n % 100, Math.floor(n / 100)]) }
  const code = 'function step(s,m){return {actions:[],memory:m}}', prompt = '规则与操作说明🌨️'.repeat(300)
  const event = { commandId: 'cmd', sessionKey, stage: 'received', source: 'sidebar', text: '一楼造矿场', seq: 1, at: 1 }
  const entries: ArchiveEntry[] = [
    { kind: 'event', at: 1, value: event },
    { kind: 'transcript', at: 2, value: { requestId: 'cmd', text: event.text, sessionKey, messages: [{ role: 'system', content: prompt }], rawResponse: '{"summary":"一楼建造"}', goals: [{ id: 'goal', placementRegion: region }] } },
    { kind: 'compilation', at: 3, value: { id: 'compile', goalIds: ['goal'], commandId: 'cmd', owner: 'global', stage: 'validation', errors: ['候选脚本错误'], code } },
    { kind: 'event', at: 4, value: { ...event, seq: 2, stage: 'failed', error: '实际执行错误' } },
  ]
  for (let n = 0; n < 16; n++) entries.push({ kind: 'observation', at: 5 + n, value: {
    at: 5 + n, tick: n * 60, credits: 1000 - n, self: Array.from({ length: 40 }, (_, i) => ({ id: i, name: 'MTNK', rx: i, ry: 10, hitPoints: 100 - (i === n ? n : 0) })),
    goals: [{ id: 'goal', spec: { placementRegion: region }, activeSpec: { placementRegion: region }, execution: { state: n === 15 ? 'completed' : 'running' } }],
    production: [{ id: 'sent', goalId: 'goal', name: 'GAREFN', quantity: 2, observedIds: n > 10 ? [90] : [], placementRegion: region }],
  } })
  entries.push({ schemaVersion: 2, kind: 'observation', at: 23, value: { mode: 'delta', base: 15, patch: { credits: 500 }, removed: [] } })
  for (let n = 0; n < 2; n++) entries.push({ kind: 'feedback', at: 24 + n, value: { id: `feedback-${n}`, commandId: 'cmd', at: 24 + n, rating: n ? 'partial' : 'bad', note: n ? '补充反馈' : '没有执行', observed: [event] } })
  writeFileSync(join(folder, 'events.jsonl'), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
  writeFileSync(join(folder, 'meta.json'), JSON.stringify({ id, sessionKey, startedAt: 1, updatedAt: 25, commands: 1, feedback: 1, issues: 1, schemaVersion: 2 }))
  writeFileSync(join(folder, 'summary.md'), '旧派生摘要')
  writeFileSync(join(folder, 'objects', '0'.repeat(64) + '.txt'), '无引用的旧正文')
  return { id, folder, code, prompt }
}

test('动态列表只保存变化成员，成员加入删除、字段删除和重排都能准确恢复', () => {
  const initial = { self: Array.from({ length: 200 }, (_, id) => ({ id, name: 'MTNK', rx: id, ry: 20, hitPoints: 100, ammo: 4 })), credits: 1000 }
  const next = structuredClone(initial)
  next.self.splice(2, 1); next.self.push({ ...next.self[0]!, id: 201 }); next.self.reverse()
  next.self.find(unit => unit.id === 5)!.hitPoints = 25
  delete (next.self.find(unit => unit.id === 6)! as { ammo?: number }).ammo
  const delta = encodeObservation(initial, next, false, 1)
  assert.ok(delta.lists?.self)
  assert.equal(delta.lists.self.changes.length, 3)
  assert.ok(JSON.stringify(delta).length < JSON.stringify(next).length / 4, '单个成员变化不再重复整队信息')
  assert.deepEqual(decodeObservation(initial, delta, 1, 3), next)
  assert.throws(() => decodeObservation(initial, delta, 2, 3), /前序/)
  assert.throws(() => decodeObservation(initial, delta, 1, 2), /版本/)
})

test('旧大记录无损去重导出，错误、候选代码、全部观察及历次反馈在离线包中保留', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-export-test-')), target = mkdtempSync(join(tmpdir(), 'ra2c-compact-test-'))
  try {
    const fixture = legacy(root), path = join(fixture.folder, 'events.jsonl'), before = readFileSync(path)
    writeFileSync(join(root, '.env'), 'DO_NOT_BUNDLE_ROOT_CONFIG')
    const compacted = compactBattle(root, fixture.id, target)
    assert.ok(compacted.compactBytes < before.length / 4)
    assert.deepEqual([...logicalEntries(new BattleJournal(compacted.folder))].map(({ schemaVersion: _version, ...value }) => value),
      [...logicalEntries(new BattleJournal(fixture.folder))].map(({ schemaVersion: _version, ...value }) => value))
    const output = join(root, 'submission.ra2c.jsonl.gz'), result = await exportBattle(root, fixture.id, output)
    assert.ok(result.bundleBytes < before.length / 10)
    assert.deepEqual(readFileSync(path), before, '导出始终保留原档')
    assert.doesNotMatch(gunzipSync(readFileSync(output)).toString(), /DO_NOT_BUNDLE_ROOT_CONFIG|无引用的旧正文|旧派生摘要/)
    const bundle = readFileSync(output)
    rmSync(join(root, '.runtime'), { recursive: true }) // 开包无需本机原档、游戏或 Companion。
    const opened = await openBattleBundle(output)
    try {
      const record = opened.records.read(opened.id)!
      assert.equal(record.events.at(-1)!.error, '实际执行错误')
      assert.deepEqual(record.feedback.map(item => item.note), ['没有执行', '补充反馈'])
      assert.equal(record.compilations[0]!.code, fixture.code)
      assert.equal((record.transcripts.cmd!.messages as Array<{ content: string }>)[0]!.content, fixture.prompt)
      assert.equal(record.observations.length, 17)
      assert.equal(record.observations.at(-1)!.credits, 500)
      const summary = opened.records.summary(opened.id)!
      assert.match(summary, /没有执行/)
      assert.doesNotMatch(summary, /"cells"/, '人读摘要不再展开整份分区边界')
    } finally { opened.dispose() }
    writeFileSync(output, bundle.subarray(0, bundle.length - 8))
    await assert.rejects(openBattleBundle(output), /unexpected|不完整|校验|end of file/i)
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }) }
})

test('损坏旧记录和篡改提交包明确失败，原始记录与已有导出文件不会被覆盖', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-bad-export-'))
  try {
    const { id, folder } = legacy(root), output = join(root, 'submission.gz')
    await exportBattle(root, id, output)
    const before = readFileSync(output)
    await assert.rejects(exportBattle(root, id, output), /已存在/)
    assert.deepEqual(readFileSync(output), before)
    const rows = gunzipSync(before).toString().trimEnd().split('\n').map(row => JSON.parse(row))
    rows.find(row => row.type === 'object').name = '../../escape.txt'
    rows[rows.length - 1].sha256 = createHash('sha256').update(rows.slice(0, -1).map(row => JSON.stringify(row)).join('\n') + '\n').digest('hex')
    writeFileSync(output, gzipSync(rows.map(row => JSON.stringify(row)).join('\n') + '\n'))
    await assert.rejects(openBattleBundle(output), /正文名称非法/)
    const source = join(folder, 'events.jsonl'); appendFileSync(source, '{"kind":')
    const damaged = readFileSync(source)
    await assert.rejects(exportBattle(root, id, join(root, 'failed.gz')), /不完整末行/)
    assert.deepEqual(readFileSync(source), damaged)
    assert.equal(existsSync(join(root, 'failed.gz')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('反馈与关闭时相同观察不重复保存，反馈本身仍完整保留', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-noop-observation-')), records = new BattleRecords(root)
  try {
    const { runtime } = await harness({ run: async () => outcome() })
    activate(runtime, production())
    records.event({ commandId: 'cmd', source: 'cli', sessionKey: runtime.battleKey, stage: 'received', text: '生产', at: 1, seq: 1 })
    records.setSession(runtime.battleKey); records.observe(runtime)
    const id = records.currentId!, count = records.read(id)!.observations.length
    records.feedback(id, 'cmd', 'good', '符合预期'); records.close()
    assert.equal(records.read(id)!.observations.length, count)
    assert.equal(records.read(id)!.feedback.length, 1)
  } finally { records.close(); rmSync(root, { recursive: true, force: true }) }
})
