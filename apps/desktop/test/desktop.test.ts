import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron as electron } from 'playwright'

const root = resolve(import.meta.dirname, '../../..')
const executable = createRequire(import.meta.url)('electron') as string
const entry = join(root, 'apps/desktop/src/main.mjs')
async function freePort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const { port } = server.address() as { port: number }
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}
async function until(check: () => Promise<unknown>, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { try { if (await check()) return } catch {} await delay(100) }
  throw new Error('等待客户端状态超时')
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 12_000)
  child.kill('SIGTERM')
  try { await exited } finally { clearTimeout(timer) }
}

test('Electron 内置 Node 可以加载识别库并运行隔离 QuickJS，不需要系统 Node 子进程', { timeout: 20_000 }, async () => {
  const code = `
    import { createRequire } from 'node:module';
    import { StepExecutor } from './packages/js-worker/src/index.ts';
    const require = createRequire(new URL('./packages/speech/package.json', import.meta.url));
    const sherpa = require('sherpa-onnx-node');
    if (typeof sherpa.OfflineRecognizer !== 'function') throw Error('识别库加载失败');
    const executor = new StepExecutor();
    try {
      const result = await executor.run('function step(s,m){return {actions:[],memory:{value:m.value+1}}}', {}, {value:1}, {allowedUnitIds:[],enemyIds:[],mapWidth:100,mapHeight:100}, 200);
      if (!result.ok || result.memory.value !== 2) throw Error(JSON.stringify(result));
      console.log('embedded-node-ok');
    } finally { await executor.dispose(); }
  `
  const child = spawn(executable, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  try { assert.equal((await once(child, 'exit'))[0], 0, output); assert.match(output, /embedded-node-ok/) }
  finally { await stop(child) }
})

for (const closeMethod of ['window', 'quit'] as const) test(`独立窗口保留设置和单实例，网页离开确认不阻塞${closeMethod === 'window' ? '关闭按钮' : '菜单退出'}`, { timeout: 60_000 }, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'ra2c desktop ')), game = join(folder, 'game')
  mkdirSync(game); mkdirSync(join(folder, '.runtime'), { recursive: true })
  writeFileSync(join(game, 'index.html'), '<!doctype html><title>模拟游戏</title><p>主选单 单机模式</p><canvas width="800" height="600"></canvas><script>window.addEventListener("beforeunload",event=>{event.preventDefault();event.returnValue=""})</script>')
  writeFileSync(join(folder, '.runtime/settings.json'), JSON.stringify({ version: 2, revision: 0, configuration: { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-never-used', model: 'fixture' } }))
  const cdp = await freePort(), http = await freePort(), command = await freePort()
  const env: NodeJS.ProcessEnv = { ...process.env, RA2C_CDP_PORT: String(cdp), RA2C_PORT: String(http), RA2C_CMD_PORT: String(command),
    RA2C_DATA_ROOT: folder, RA2C_GAME_DIR: game, RA2C_SPEECH_MODEL_DIR: join(folder, 'missing-model'), RA2C_DESKTOP_HIDDEN: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const launchEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  const application = await electron.launch({ executablePath: executable, args: [entry, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], cwd: root, env: launchEnv, timeout: 20_000 })
  const child = application.process(), context = application.context()
  // Electron 的离开确认不显示浏览器对话框；禁止调试器替用户自动处理它。
  context.on('dialog', () => {})
  let output = ''
  child.stdout?.on('data', bytes => { output = (output + bytes).slice(-6000) }); child.stderr?.on('data', bytes => { output = (output + bytes).slice(-6000) })
  try {
    await until(async () => {
      if (child.exitCode !== null) throw new Error(output)
      const page = context.pages()[0]
      return page?.url().includes('/commander/') && page.evaluate(() => fetch('/commander/status').then(response => response.ok))
    })
    const pages = context.pages()
    assert.equal(pages.length, 1)
    const page = pages[0]!; page.setDefaultTimeout(5000)
    assert.equal(new URL(page.url()).pathname, '/commander/')
    await page.frameLocator('#ra2c-game').getByText('主选单 单机模式').waitFor()
    await page.frameLocator('#ra2c-game').locator('canvas').click()
    assert.equal(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require), 'undefined')
    // Chromium 合成设备验证 Electron 采集链路，不访问用户麦克风，也不提交录音。
    await until(async () => (await page.locator('#voice-enable').getAttribute('aria-pressed')) === 'true', 5000)
    assert.equal(await page.locator('#say-input').isVisible(), false)
    await page.locator('#voice-enable').click()
    const frameIdentity = await page.frameLocator('#ra2c-game').locator('body').evaluate(body => { body.dataset.identity = 'same-game'; return body.dataset.identity })
    await page.locator('#tab-settings').click()
    await page.locator('#speech-key').selectOption('F9')
    await page.locator('#speech-form button[type="submit"]').click()
    await page.getByText('语音设置已保存，请重新启用麦克风').waitFor()
    assert.equal(JSON.parse(readFileSync(join(folder, '.runtime/speech/settings.json'), 'utf8')).key, 'F9')
    assert.equal(await page.frameLocator('#ra2c-game').locator('body').getAttribute('data-identity'), frameIdentity)
    // 再次启动仅激活原窗口，不创建第二宿主或第二个页面。
    const second = spawn(executable, [entry], { cwd: root, env, stdio: 'ignore' })
    try { assert.equal((await once(second, 'exit'))[0], 0); assert.equal(context.pages().length, 1) }
    finally { await stop(second) }
    await page.evaluate(() => window.addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = '' }))
    const exited = once(child, 'exit')
    // 走真实原生窗口关闭；调试协议的 page.close 会绕过网页的离开确认。
    await application.evaluate(({ app, BrowserWindow }, method) => {
      if (method === 'window') BrowserWindow.getAllWindows()[0]!.close()
      else app.quit()
    }, closeMethod)
    await Promise.race([exited, delay(12_000, undefined, { ref: false }).then(() => { throw new Error('关闭窗口后进程没有退出') })])
    await until(() => fetch(`http://127.0.0.1:${cdp}/json/version`, { signal: AbortSignal.timeout(500) }).then(() => false).catch(() => true))
    await until(() => new Promise<boolean>(resolve => {
      const server = createServer(); server.once('error', () => resolve(false)); server.listen(http, '127.0.0.1', () => server.close(() => resolve(true)))
    }))
    assert.equal(child.exitCode, 0, output)
    assert.doesNotMatch(output, /退出超时|无法读取或转换/)
    assert.match(output, /记录已保存/)
    assert.match(output, /指挥服务已停止/)
  } catch (error) { throw new Error(`${String(error)}\n${output}`) }
  finally { await stop(child); await application.close().catch(() => {}); rmSync(folder, { recursive: true, force: true }) }
})
