import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { exportBattle } from '../src/battle-export.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url)), args = process.argv.slice(2), [id, option, path] = args
try {
  if (!id || args.length !== 1 && (args.length !== 3 || option !== '--out' || !path)) throw new Error('用法：pnpm records:export <battle-id> [--out <文件路径>]')
  const output = path ? resolve(path) : join(root, '.runtime/record-exports', `${id}-${Date.now()}.ra2c.jsonl.gz`)
  const result = await exportBattle(root, id, output)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} catch (error) { process.stderr.write(`导出对局记录失败：${String(error)}\n`); process.exitCode = 1 }
