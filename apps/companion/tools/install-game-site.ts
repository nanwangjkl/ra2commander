import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { prepareGameSite, GAME_SITE } from '@ra2c/game-werhd'
await prepareGameSite(resolve(import.meta.dirname, '../../..'), process.env.RA2C_GAME_DIR ?? join(homedir(), 'my/code/ra2web.github.io'))
console.log(`游戏站点与冰天雪地已校验：${GAME_SITE.version}`)
