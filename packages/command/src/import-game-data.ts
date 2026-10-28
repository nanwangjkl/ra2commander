import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { importGameData, validateGameData } from './game-data.ts'

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
try {
  const game = process.argv[2] ?? process.env.RA2C_GAME_DIR ?? join(homedir(), 'my/code/ra2web.github.io')
  const out = process.argv[3] ?? join(root, 'prompts/games/catalogs/ra2web-gonghui.json')
  const data = importGameData(readFileSync(join(game, 'res/overlay/rules.ini')), readFileSync(join(game, 'res/overlay/ra2.csf')), process.argv[4] ?? 'ra2web-gonghui', readFileSync(join(game, 'res/overlay/art.ini')))
  validateGameData(data)
  mkdirSync(dirname(out), { recursive: true })
  // 每条事实一行，便于审阅导入后哪些项目发生变化。
  const { entries, ...meta } = data
  writeFileSync(out, JSON.stringify(meta, null, 2).replace(/\n}$/, ',\n  "entries": [\n') + entries.map(item => `    ${JSON.stringify(item)}`).join(',\n') + '\n  ]\n}\n')
  console.log(`已导入 ${entries.length} 个单位/建筑、${Object.keys(data.categories).length} 类前置、${data.countries.length} 个国家：${data.version}`)
} catch (error) { console.error(String(error)); process.exitCode = 1 }
