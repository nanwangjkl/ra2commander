import { fileURLToPath } from 'node:url'
import { BattleRecords } from '../src/battle-records.ts'
import { openBattleBundle } from '../src/battle-export.ts'
import { openBattleZip } from '../src/battle-zip.ts'

const records = new BattleRecords(fileURLToPath(new URL('../../../', import.meta.url)))
const [id, option] = process.argv.slice(2)
let opened: Awaited<ReturnType<typeof openBattleBundle>> | undefined
try {
  if (!id || id === '--list') process.stdout.write(`${JSON.stringify(records.list(), null, 2)}\n`)
  else {
    if (option && option !== '--summary') throw new Error('支持的选项为 --summary')
    if (id.endsWith('.gz')) opened = await openBattleBundle(id)
    if (id.endsWith('.zip')) opened = await openBattleZip(id)
    const source = opened?.records ?? records, key = opened?.id ?? id
    const output = option === '--summary' ? source.summary(key) : source.read(key)
    if (!output) throw new Error('找不到对局；用 pnpm records:read --list 查看 ID')
    process.stdout.write(typeof output === 'string' ? output : `${JSON.stringify(output, null, 2)}\n`)
  }
} catch (error) { process.stderr.write(`读取对局记录失败：${String(error)}\n`); process.exitCode = 1 }
finally { opened?.dispose() }
