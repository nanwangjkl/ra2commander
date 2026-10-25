import { readFileSync } from 'node:fs'
import { readPrompts } from '@ra2c/command'
import { CAPABILITY_TYPES_FILE, generatedCapabilityTypes } from '../../../../packages/command/src/generate-capabilities.ts'
import { validateBindings } from './index.ts'

try {
  if (readFileSync(CAPABILITY_TYPES_FILE, 'utf8') !== generatedCapabilityTypes()) throw new Error('能力类型已过期，请运行 pnpm capabilities:generate')
  const prompts = readPrompts()
  validateBindings(prompts)
  for (const definition of prompts.capabilities.definitions()) console.log(`${definition.id}：已定义、已绑定、已接入终端与自然语言`)
  console.log(`${prompts.capabilities.definitions().length} 项能力检查通过；提示版本 ${prompts.version}`)
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
