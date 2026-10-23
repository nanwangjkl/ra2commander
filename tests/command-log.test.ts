import test from 'node:test'
import assert from 'node:assert/strict'
import { CommandLog } from '../apps/companion/src/command-log.ts'

test('命令记录按序推送并支持断线补齐', () => {
  const log = new CommandLog()
  const seen: string[] = []
  const unsubscribe = log.subscribe((event) => seen.push(event.stage))
  log.emit({ commandId: 'a', stage: 'received', source: 'sidebar', text: '展开基地' })
  log.emit({ commandId: 'a', stage: 'understanding', source: 'sidebar' })
  unsubscribe()
  log.emit({ commandId: 'a', stage: 'understood', source: 'sidebar', summary: '展开' })
  assert.deepEqual(seen, ['received', 'understanding'])
  // 订阅结束后的事件只能通过 since 补齐。
  assert.deepEqual(log.since(2).map((event) => event.stage), ['understood'])
  assert.equal(log.lastSeq(), 3)
})

test('事件总量有上限，保留最新', () => {
  const log = new CommandLog()
  for (let i = 0; i < 2100; i++) log.emit({ commandId: 'a', stage: 'received', source: 'sidebar' })
  const kept = log.since(0)
  assert.ok(kept.length <= 2000)
  assert.equal(kept[kept.length - 1]?.seq, log.lastSeq())
})

test('同屏多命令事件按各自 commandId 区分', () => {
  const log = new CommandLog()
  log.emit({ commandId: 'a', stage: 'received', source: 'sidebar', text: '命令一' })
  log.emit({ commandId: 'b', stage: 'received', source: 'cli', text: '命令二' })
  log.emit({ commandId: 'a', stage: 'understood', source: 'sidebar', summary: 'x' })
  const byCommand = log.since(0).reduce<Record<string, number>>((acc, event) => {
    acc[event.commandId] = (acc[event.commandId] ?? 0) + 1
    return acc
  }, {})
  assert.equal(byCommand['a'], 2)
  assert.equal(byCommand['b'], 1)
})
