import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPrompts } from './prompt-loader.ts'

try {
  const [directory] = process.argv.slice(2)
  const prompts = readPrompts(directory ? pathToFileURL(resolve(directory) + sep) : undefined)
  console.log(`4 份提示词模板校验通过：${prompts.version}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
