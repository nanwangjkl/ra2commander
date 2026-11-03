import { resolve } from 'node:path'
import { prepareGameResources } from '@ra2c/game-werhd'

const root = resolve(import.meta.dirname, '../../..')
const result = await prepareGameResources(root, { progress: console.log,
  ...(process.env.RA2C_GAME_RESOURCES_DIR ? { target: resolve(process.env.RA2C_GAME_RESOURCES_DIR) } : {}) })
console.log(`游戏资源已就绪：${result.files} 个文件，${result.bytes} 字节\n${result.folder}`)
