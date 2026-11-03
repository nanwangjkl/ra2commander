import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

// 开发入口只选择空闲的窗口连接端口；游戏服务端口保持稳定，以复用资源缓存。
const debugPort = process.env.RA2C_CDP_PORT || await new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(error => error ? reject(error) : resolve(String(port))) })
})
const env = { ...process.env, RA2C_CDP_PORT: debugPort }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [fileURLToPath(new URL('../src/main.mjs', import.meta.url))], { stdio: 'inherit', env })
process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
child.on('error', error => { console.error(`客户端启动失败：${error.message}`); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
