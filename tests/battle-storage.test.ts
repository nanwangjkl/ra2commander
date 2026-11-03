import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BattleJournal } from '../apps/companion/src/battle-storage.ts'

test('归档持久化可在 Windows 只读句柄不允许 fsync 时完成', () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-battle-storage-'))
  try {
    const folder = join(root, 'battle-test')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'meta.json'), '{"schemaVersion":3}')
    const journal = new BattleJournal(folder)
    journal.objects.pack({ code: 'x'.repeat(600) })
    journal.append({ kind: 'event', at: 1, value: { stage: 'received' } })
    journal.flush(true)
    assert.equal(journal.entries().next().value?.kind, 'event')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
