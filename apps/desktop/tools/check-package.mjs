import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join, resolve, sep } from 'node:path'
import { mkdtempSync, readFileSync, realpathSync, readdirSync, lstatSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'

const appDir = realpathSync(resolve(process.argv[2])), mac = process.platform === 'darwin', linux = process.platform === 'linux'
const runtime = join(appDir, mac ? 'Contents/Resources/runtime' : 'resources/runtime')
const executable = mac ? join(appDir, 'Contents/MacOS', readdirSync(join(appDir, 'Contents/MacOS'))[0]) : join(appDir, linux ? 'ra2commander' : 'ra2commander.exe')
const load = path => import(pathToFileURL(join(runtime, path)).href)
const temporary = mkdtempSync(join(tmpdir(), 'ra2c-installed-check-'))
const seen = new Set()
function audit(folder) {
  const actual = realpathSync(folder)
  assert.ok(actual === runtime || actual.startsWith(runtime + sep), `外部链接：${folder}`)
  if (seen.has(actual)) return
  seen.add(actual)
  if (!lstatSync(actual).isDirectory()) return
  for (const item of readdirSync(actual)) {
    assert.ok(!['.env', '.runtime', 'tsx', 'typescript'].includes(item), `不应分发的文件：${join(actual, item)}`)
    audit(join(actual, item))
  }
}
let recognizer, downloads, application
try {
  assert.ok(['darwin', 'linux', 'win32'].includes(process.platform)); assert.ok(['arm64', 'x64'].includes(process.arch))
  audit(runtime)
  const { loadPrompts } = await load('packages/command/src/index.js')
  assert.ok(loadPrompts().version)
  const { verifyGameSite, verifyGameResources } = await load('packages/game-werhd/src/index.js')
  verifyGameSite(runtime); await verifyGameResources(join(runtime, 'resources/game/ra2web-base-0.87.0-1'))
  const { StepExecutor } = await load('packages/js-worker/src/index.js')
  const executor = new StepExecutor()
  try { assert.equal((await executor.run('function step(snapshot,memory){return {actions:[],memory:{ok:true}}}', {}, {}, { allowedUnitIds: [], enemyIds: [], mapWidth: 200, mapHeight: 200 }, 200)).memory?.ok, true) }
  finally { await executor.dispose() }
  const { LocalSpeechRecognizer, decodeSpeechWave, defaultSpeechModelDir, verifySpeechModel } = await load('packages/speech/src/index.js')
  const model = defaultSpeechModelDir(runtime)
  await verifySpeechModel(model)
  recognizer = new LocalSpeechRecognizer(model); await recognizer.start()
  const audio = decodeSpeechWave(readFileSync(join(model, 'test_wavs/zh.wav')))
  const speech = await recognizer.transcribe(audio.samples, AbortSignal.timeout(45_000))
  assert.ok(speech.text.length > 5); recognizer.close(); recognizer = undefined
  console.log(`[package] ${process.platform}/${process.arch} 原生语音、模型、QuickJS 和发行资源检查通过`)

  const { BattleRecords } = await load('apps/companion/src/battle-records.js')
  const records = new BattleRecords(temporary); records.setSession('package-check')
  records.event({ commandId: 'cmd-package-check', seq: 1, source: 'sidebar', stage: 'received', text: '离线归档样例', at: Date.now(), sessionKey: 'package-check' })
  records.flush(); const battle = records.currentId; records.close()
  const { BattleDownloads } = await load('apps/companion/src/battle-downloads.js')
  downloads = new BattleDownloads(temporary); const job = downloads.start(battle)
  for (let i = 0; i < 200 && downloads.status(job.token)?.state === 'preparing'; i++) await delay(50)
  assert.equal(downloads.status(job.token)?.state, 'ready', downloads.status(job.token)?.error)
  const zip = downloads.acquire(job.token); assert.equal(readFileSync(zip.path).subarray(0, 2).toString(), 'PK'); zip.release(); downloads.close(); downloads = undefined
  console.log('[package] 打包后的历史 ZIP 工作进程检查通过')

  const { _electron } = createRequire(join(runtime, 'package.json'))('playwright')
  // 模拟 Steam 只在 Chromium zygote 初始化时出错的覆盖层，用真实窗口检查入口隔离。
  const overlaySource = join(temporary, 'steam-overlay.c'), overlay = join(temporary, 'gameoverlayrenderer.so')
  if (linux) {
    writeFileSync(overlaySource, '#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\n__attribute__((constructor)) static void init(void){char args[8192]={0};FILE *f=fopen("/proc/self/cmdline","rb");if(!f)return;size_t n=fread(args,1,sizeof(args)-1,f);fclose(f);for(size_t i=0;i<n;i++)if(!args[i])args[i]=32;if(strstr(args,"--type=zygote"))_exit(86);}\n')
    execFileSync('cc', ['-shared', '-fPIC', overlaySource, '-o', overlay])
  }
  const blocked = new Set(), requested = new Set()
  const data = join(temporary, 'user-data'); mkdirSync(data)
  const freePort = async () => {
    const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return String(port)
  }
  const ports = { RA2C_PORT: await freePort(), RA2C_CMD_PORT: await freePort() }
  async function start() {
    const env = { ...process.env, ...ports, ...(linux ? { LD_PRELOAD: overlay } : {}), RA2C_DATA_ROOT: data, RA2C_DESKTOP_HIDDEN: '1' }
    delete env.ELECTRON_RUN_AS_NODE; delete env.RA2C_PACKAGED
    const appRun = join(appDir, 'AppRun')
    if (existsSync(appRun)) {
      env.APPDIR = appDir
      if (process.env.RA2C_CHECK_APPIMAGE) env.APPIMAGE = process.env.RA2C_CHECK_APPIMAGE
    }
    // 容器检查单独关闭 Chromium 沙箱；发行程序不附加这些测试参数。
    application = await _electron.launch({ executablePath: existsSync(appRun) ? appRun : executable, args: [...(linux ? ['--no-sandbox'] : []), ...(mac ? [] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']), '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], cwd: temporary, env, timeout: 45_000 })
    let diagnostic = ''
    for (const stream of [application.process().stdout, application.process().stderr]) stream?.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-5000) })
    if (linux) assert.equal(await application.evaluate(() => process.env.LD_PRELOAD), undefined, 'Electron 应在覆盖层预加载已移除的环境中运行')
    const context = application.context(); context.on('dialog', () => {})
    await context.addInitScript(() => {
      window.__resourcePromptSeen = false
      new MutationObserver(() => { if (document.querySelector('.game-res-box .recovery-actions')) window.__resourcePromptSeen = true }).observe(document, { childList: true, subtree: true })
    })
    const page = await application.firstWindow()
    const bounds = await application.evaluate(({ BrowserWindow, screen }) => ({ actual: BrowserWindow.getAllWindows()[0].getSize(), area: screen.getPrimaryDisplay().workAreaSize }))
    // Steam Deck 的专用尺寸由独立检查覆盖；其他桌面保持当前工作区内的默认窗口。
    if (!linux) assert.deepEqual(bounds.actual, [Math.min(1480, bounds.area.width), Math.min(960, bounds.area.height)])
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.pathname.startsWith('/ra2c-game-resources/')) requested.add(url.pathname)
      if (/\/map\/mp32s8\.map$/i.test(url.pathname)) return route.fallback()
      if (['http:', 'https:'].includes(url.protocol) && !['localhost', '127.0.0.1'].includes(url.hostname)) { blocked.add(url.hostname); return route.abort() }
      return route.continue()
    })
    for (let i = 0; i < 120; i++) {
      const frame = page.frames().find(frame => frame !== page.mainFrame() && frame.url().startsWith('https://127.0.0.1'))
      if (frame && /主选单/.test(await frame.locator('body').innerText({ timeout: 1000 }).catch(() => ''))) return { page, frame }
      await delay(500)
    }
    throw new Error(`打包后的游戏未进入主菜单：${JSON.stringify(await Promise.all(page.frames().map(async frame => ({ url: frame.url(), text: (await frame.locator('body').innerText({ timeout: 1000 }).catch(() => '')).slice(-1500) }))))}\n阻止的外部请求：${[...blocked]}\n${diagnostic}`)
  }
  async function close() {
    const child = application.process(), exited = once(child, 'exit')
    await application.evaluate(({ app }) => app.quit())
    await Promise.race([exited, delay(15_000, undefined, { ref: false }).then(() => { throw new Error('打包程序退出超时') })])
    assert.equal(child.exitCode, 0); await application.close().catch(() => {}); application = undefined
  }
  const first = await start()
  let speechView
  for (let i = 0; i < 120; i++) {
    speechView = await first.page.evaluate(() => fetch('/commander/speech').then(response => response.json()))
    if (speechView.engine.state !== 'loading') break
    await delay(500)
  }
  assert.equal(speechView.modelDir, model, '实际宿主应使用随包模型，而不是用户数据或开发目录')
  assert.equal(speechView.engine.state, 'ready', JSON.stringify(speechView.engine))
  await first.page.waitForFunction(() => document.querySelector('#voice-enable')?.getAttribute('aria-pressed') === 'true')
  assert.equal(await first.page.locator('#voice-status').innerText(), '按住右侧按钮或`说话')
  const defaults = await first.frame.evaluate(() => ({ mixer: localStorage.getItem('_r_mixer_v3'), joystick: localStorage.getItem('ra2web.mobileJoystickLite.enabled'), prompt: window.__resourcePromptSeen }))
  assert.equal(defaults.prompt, false); assert.equal(defaults.joystick, '0'); assert.ok(defaults.mixer.includes('0,0.2') && defaults.mixer.includes('5,0'))
  await first.frame.getByText('单机模式', { exact: true }).click()
  await first.frame.getByText('遭遇战', { exact: true }).click()
  await first.frame.locator('.player-name').first().waitFor()
  assert.match(await first.frame.locator('body').innerText(), /利比亚[\s\S]*AI-简单\s+法国/)
  assert.equal(await first.frame.evaluate(() => localStorage.getItem('_r_lastMap')), 'mp32s8.map')
  // 游戏可以从 VFS/缓存读图；菜单预览正常生成即可，不要求额外发出 HTTP 请求。
  await first.frame.locator('canvas[data-r-tooltip]').first().waitFor()
  const mapBytes = await first.frame.evaluate(async () => Array.from(new Uint8Array(await (await fetch('https://gmap.wangerhuoda.cn/map/mp32s8.map')).arrayBuffer())))
  assert.equal(createHash('sha256').update(Buffer.from(mapBytes)).digest('hex'), 'df5419036db3cdfb39de5a6fb9a09c7737a60aad79dbda9431193d92ca460bc1')
  await first.frame.evaluate(() => { localStorage.setItem('_r_mixer_v3', '0,0.6;5,0.1'); localStorage.setItem('ra2web.mobileJoystickLite.enabled', '1') })
  await first.page.locator('#tab-settings').click(); await first.page.locator('#speech-key').selectOption('F9')
  await first.page.locator('#speech-form button[type="submit"]').click(); await first.page.getByText('语音设置已保存，请重新启用麦克风').waitFor()
  const settings = JSON.parse(readFileSync(join(data, '.runtime/speech/settings.json'), 'utf8')); assert.equal(settings.key, 'F9')
  await close()
  const second = await start()
  const restored = await second.frame.evaluate(() => ({ mixer: localStorage.getItem('_r_mixer_v3'), joystick: localStorage.getItem('ra2web.mobileJoystickLite.enabled') }))
  assert.deepEqual(restored, { mixer: '0,0.6;5,0.1', joystick: '1' })
  assert.equal(JSON.parse(readFileSync(join(data, '.runtime/speech/settings.json'), 'utf8')).key, 'F9')
  await close(); assert.ok(requested.size >= 4)
  console.log('[package] 干净资料首启、本机地图、设置保存、退出与重开检查通过')
  if (linux) {
    const installEnv = { ...process.env, XDG_DATA_HOME: join(temporary, 'xdg'), RA2C_DATA_ROOT: join(temporary, 'installer-data') }
    delete installEnv.ELECTRON_RUN_AS_NODE
    for (const option of ['--install', '--install', '--uninstall']) {
      const result = spawnSync(join(appDir, 'ra2commander'), ['--no-sandbox', option], { env: installEnv, encoding: 'utf8', timeout: 60_000 })
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
      if (option === '--install') {
        assert.ok(existsSync(join(homedir(), 'Applications/RA2Commander/ra2commander')))
        const preferences = join(installEnv.XDG_DATA_HOME, 'ra2commander/.runtime')
        mkdirSync(preferences, { recursive: true }); writeFileSync(join(preferences, 'settings.json'), 'keep')
      }
    }
    assert.equal(existsSync(join(homedir(), 'Applications/RA2Commander')), false)
    assert.equal(readFileSync(join(installEnv.XDG_DATA_HOME, 'ra2commander/.runtime/settings.json'), 'utf8'), 'keep')
    console.log('[package] 正式程序安装、重复安装与保留数据卸载检查通过')
  }
} finally {
  recognizer?.close(); downloads?.close()
  if (application) { application.process().kill('SIGTERM'); await application.close().catch(() => {}) }
  rmSync(temporary, { recursive: true, force: true })
}
