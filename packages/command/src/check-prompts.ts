import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPrompts } from './prompt-loader.ts'

try {
  const [directory] = process.argv.slice(2)
  const prompts = readPrompts(directory ? pathToFileURL(resolve(directory) + sep) : undefined)
  console.log(`提示词模板、${prompts.game.roles().length} 个游戏角色、${prompts.tactics.ids().length} 个战术主题、${prompts.skills.ids().length} 个 Skill 校验通过：${prompts.version}`)
  console.log(`游戏目录：${prompts.game.id}@${prompts.game.version}；战术：${prompts.tactics.ids().join('、')}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
