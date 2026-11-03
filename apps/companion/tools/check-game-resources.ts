import { resolve } from 'node:path'
import { defaultGameResourcesDir, verifyGameResources } from '@ra2c/game-werhd'

const root = resolve(import.meta.dirname, '../../..')
const result = await verifyGameResources(process.env.RA2C_GAME_RESOURCES_DIR ? resolve(process.env.RA2C_GAME_RESOURCES_DIR) : defaultGameResourcesDir(root))
console.log(`游戏资源校验通过：${result.files} 个文件，${result.bytes} 字节\n${result.folder}`)
