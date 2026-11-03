import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { chromium, type Browser } from 'playwright'
import { buildWorkbench, refreshCommandPanel } from '../src/workbench.ts'
import { restoreBrowserDownloads } from '../src/browser-downloads.ts'
import type { CurrentCommands } from '../../../packages/contracts/src/index.ts'
import type { ModelSettingsView } from '../../../packages/contracts/src/index.ts'

interface TestUI {
  sources: Array<{ closed: boolean; onmessage: ((event: { data: string }) => void) | null }>
  timers: Set<number>
  hold: Set<string>
  pending: Array<{ path: string; resolve: (response: Response) => void }>
  requests: Array<{ path: string; body: string; bytes?: number }>
  legacyClicks: number
  micDenied?: boolean
  micPermissionPending?: boolean
  micGrant?: () => void
  micCalls?: number
  tracks?: MediaStreamTrack[]
}
declare global { interface Window { __uiTest: TestUI } }

const root = resolve(import.meta.dirname, '../../..')
let browser: Browser
test.before(async () => { browser = await chromium.launch({ headless: true }) })
test.after(async () => { await browser?.close() })

test('CDP 重连后下载使用原生文件名与目录，断连后文件保留', { timeout: 20_000 }, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'ra2c-native-download-')), profile = join(folder, 'profile'), downloads = join(folder, 'downloads')
  mkdirSync(join(profile, 'Default'), { recursive: true }); mkdirSync(downloads)
  writeFileSync(join(profile, 'Default/Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }))
  const native = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', args: ['--remote-debugging-port=0'] })
  const zip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex')
  const server = createServer((req, res) => {
    if (req.url === '/battle.zip') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="battle-test.zip"' }); res.end(zip)
    } else { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<a href="/battle.zip" download>下载</a>') }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  let attached: Browser | undefined
  try {
    const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]
    attached = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    await restoreBrowserDownloads(attached)
    const page = attached.contexts()[0]!.pages()[0]!
    page.setDefaultTimeout(5000)
    // 原生下载不经过页面 route；只访问独立本机服务，不访问真实游戏、归档或云服务。
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`)
    await page.getByRole('link', { name: '下载' }).click()
    const saved = join(downloads, 'battle-test.zip')
    for (let i = 0; i < 100 && !existsSync(saved); i++) await delay(50)
    assert.ok(existsSync(saved), '文件应以 ZIP 名称保存到浏览器配置目录，而非 Playwright GUID 临时文件')
    assert.deepEqual(readFileSync(saved), zip)
    await attached.close(); attached = undefined
    assert.deepEqual(readFileSync(saved), zip, 'Companion 断连不删除用户下载')
  } finally {
    server.closeAllConnections(); server.close()
    await attached?.close(); await native.close(); rmSync(folder, { recursive: true, force: true })
  }
})

async function fixture(legacy = false, withMicrophone = false) {
  const folder = mkdtempSync(join(tmpdir(), 'ra2c-ui-'))
  cpSync(join(root, 'apps/companion/ui'), join(folder, 'apps/companion/ui'), { recursive: true })
  const files = buildWorkbench(folder), context = await browser.newContext()
  let assets: ReturnType<typeof createServer> | undefined, origin = 'https://workbench.test'
  if (withMicrophone) {
    // AudioWorklet 的模块加载不经过页面 route，使用独立 loopback 静态服务。
    assets = createServer((req, res) => {
      const path = new URL(req.url || '/', 'http://localhost').pathname, file = files[path]
      if (!file) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-type': path.endsWith('.js') ? 'application/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' }); res.end(readFileSync(file))
    })
    assets.listen(0, '127.0.0.1'); await once(assets, 'listening')
    origin = `http://127.0.0.1:${(assets.address() as { port: number }).port}`
  }
  await context.addInitScript({ content: `
    window.__uiTest = { sources: [], timers: new Set(), hold: new Set(), pending: [], requests: [], legacyClicks: 0 };
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      window.__uiTest.requests.push({ path, body: typeof init?.body === 'string' ? init.body : '', bytes: init?.body instanceof ArrayBuffer ? init.body.byteLength : 0 });
      if (window.__uiTest.hold.has(path)) return new Promise(resolve => window.__uiTest.pending.push({ path, resolve }));
      return originalFetch(input, init);
    };
    window.EventSource = class {
      closed = false; onopen = null; onerror = null; onmessage = null;
      constructor() { window.__uiTest.sources.push(this); queueMicrotask(() => { if (!this.closed) this.onopen?.(); }); }
      close() { this.closed = true; }
    };
    const originalTimeout = window.setTimeout.bind(window), originalClear = window.clearTimeout.bind(window);
    window.setTimeout = (fn, delay, ...args) => {
      const id = originalTimeout(() => { window.__uiTest.timers.delete(id); fn(...args); }, delay);
      if (delay === 2000) window.__uiTest.timers.add(id);
      return id;
    };
    window.clearTimeout = id => { window.__uiTest.timers.delete(id); originalClear(id); };
  ` })
  if (withMicrophone) await context.addInitScript({ content: `
    window.__uiTest.micDenied = false; window.__uiTest.micCalls = 0; window.__uiTest.tracks = [];
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { value: async () => [{ deviceId: 'fixture-mic', kind: 'audioinput', label: '模拟麦克风' }] });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      window.__uiTest.micCalls++;
      if (window.__uiTest.micPermissionPending) await new Promise(resolve => { window.__uiTest.micGrant = resolve; });
      if (window.__uiTest.micDenied) throw new DOMException('fixture denied', 'NotAllowedError');
      const audio = new AudioContext({ sampleRate: 16000 }), oscillator = audio.createOscillator(), gain = audio.createGain(), destination = audio.createMediaStreamDestination();
      gain.gain.value = 0.1; oscillator.connect(gain); gain.connect(destination); oscillator.start(); void audio.resume();
      window.__uiTest.tracks.push(...destination.stream.getTracks()); return destination.stream;
    } });
  ` })
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const current: CurrentCommands = { battleId: 'battle-a', sessionKey: 'session-a', warning: '', feedback: [], events: Array.from({ length: 24 }, (_, i) => ({ commandId: `known-${i}`, source: 'sidebar', stage: 'understood', text: `已有命令 ${i}`, summary: '执行既有任务', seq: i + 1, at: Date.now() - i * 1000, sessionKey: 'session-a' })) }
  const model = { current, game: 'ready', htmlVersion: 0, failHtml: false, failCss: false, holdHtml: false, pendingHtml: [] as Array<() => Promise<void>> }
  let settings: ModelSettingsView = { revision: 0, warning: '', baseUrl: 'https://fixture.example/v1', model: 'old', hasKey: true }
  let htmlHeld = () => {}
  const holdHtml = () => { model.holdHtml = true; return new Promise<void>(resolve => { htmlHeld = resolve }) }
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (url.origin !== origin) { await route.abort(); return }
    if (path === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<body>模拟游戏文档<script>window.__fixtureToken=crypto.randomUUID();window.__nativeRequest=Element.prototype.requestFullscreen;window.__nativeExit=document.exitFullscreen;</script>' }); return
    }
    if (path === '/commander/status') { await route.fulfill({ json: { game: model.game } }); return }
    if (path === '/commander/commands') { await route.fulfill({ json: model.current }); return }
    if (path === '/commander/say') { await route.fulfill({ status: 202, json: {} }); return }
    if (path === '/commander/history') { await route.fulfill({ json: { records: [{ id: 'battle-fixture', sessionKey: 'old-game', startedAt: 1, commands: 3, feedback: 1 }], warning: '' } }); return }
    if (path === '/commander/settings') {
      if (route.request().method() === 'POST') {
        const input = route.request().postDataJSON()
        settings = { revision: settings.revision + 1, warning: '', baseUrl: input.baseUrl, model: input.model, hasKey: true }
      }
      await route.fulfill({ json: settings }); return
    }
    if (path === '/commander/settings/test') { await route.fulfill({ json: { ok: true } }); return }
    if (path === '/commander/speech' || path === '/commander/speech/reload') { await route.fulfill({ json: { revision: 0, deviceId: '', key: 'Backquote', modelDir: '/fixture-model', warning: '', engine: { state: 'ready', error: '' } } }); return }
    if (path.startsWith('/commander/voice/')) { await route.fulfill({ status: 202, json: { commandId: path.split('/')[3] } }); return }
    if (path === '/commander/feedback') {
      const value = route.request().postDataJSON()
      const feedback = { id: crypto.randomUUID(), at: Date.now(), ...value, observed: [] }
      model.current.feedback.push(feedback)
      await route.fulfill({ json: { feedback } }); return
    }
    const file = files[path]
    if (!file) { await route.fulfill({ status: 404 }); return }
    if (path.endsWith('.css') && model.failCss) { await route.fulfill({ status: 503 }); return }
    let body = readFileSync(file, 'utf8')
    if (path === '/commander/') {
      if (model.failHtml) { await route.fulfill({ status: 503 }); return }
      if (legacy) body = body.replace(/<script type="module"[^>]+><\/script>/, '')
      body = body.replace('输入指挥命令，回车提交', `模板-${++model.htmlVersion}`)
      if (model.holdHtml) { model.holdHtml = false; model.pendingHtml.push(() => route.fulfill({ body, contentType: 'text/html' }).catch(() => {})); htmlHeld(); return }
    }
    await route.fulfill({ body, contentType: path.endsWith('.js') ? 'application/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' })
  })
  await page.goto(`${origin}/commander/`)
  const ready = () => page.waitForFunction(() => document.querySelectorAll('.command-card').length === 24 && window.__uiTest.sources.filter(source => !source.closed).length === 1)
  if (!legacy) await ready()
  const remount = () => page.evaluate(async () => {
    const module = await import('/commander/workbench-lifecycle.js' as string)
    module.mountWorkbench()
  })
  return { page, model, errors, ready, remount, holdHtml, close: async () => { await context.close(); assets?.closeAllConnections(); assets?.close(); rmSync(folder, { recursive: true, force: true }) } }
}

test('反复更新只保留一份订阅与轮询，草稿、焦点、页签和游戏文档保留；卸载恢复全屏入口', { timeout: 20_000 }, async () => {
  const f = await fixture(), { page } = f
  try {
    const gameToken = await page.locator('#ra2c-game').evaluate(frame => Reflect.get((frame as HTMLIFrameElement).contentWindow!, '__fixtureToken'))
    await page.locator('#say-input').fill('未发送的新命令')
    const first = page.locator('[data-command="known-0"]')
    await first.locator('.feedback-toggle').click()
    await first.locator('[data-rating="partial"]').click()
    await first.locator('textarea').fill('未保存的反馈草稿')
    await first.locator('textarea').evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(2, 5))
    for (let i = 0; i < 3; i++) await refreshCommandPanel(page)
    assert.equal(await page.locator('#say-input').inputValue(), '未发送的新命令')
    assert.equal(await first.locator('textarea').inputValue(), '未保存的反馈草稿')
    assert.equal(await first.locator('[data-rating="partial"]').getAttribute('aria-pressed'), 'true')
    assert.deepEqual(await first.locator('textarea').evaluate(node => [document.activeElement === node, (node as HTMLTextAreaElement).selectionStart, (node as HTMLTextAreaElement).selectionEnd]), [true, 2, 5])
    await page.locator('#tab-settings').click(); await refreshCommandPanel(page)
    assert.equal(await page.locator('#tab-settings').getAttribute('aria-selected'), 'true')
    await page.locator('#tab-commands').click()
    await page.locator('#say-input').fill('只提交一次')
    await page.locator('#say-submit').click()
    await page.waitForFunction(() => window.__uiTest.requests.some(request => request.path === '/commander/say'))
    await page.locator('#command-cards').evaluate(node => { node.scrollTop = 250; node.dispatchEvent(new Event('scroll')) })
    await refreshCommandPanel(page)
    assert.equal(await page.evaluate(() => window.__uiTest.requests.filter(request => request.path === '/commander/say').length), 1, '刷新只同步记录，不重放命令')
    assert.equal(await page.locator('#command-cards').evaluate(node => node.scrollTop), 250)
    assert.equal(await page.locator('#ra2c-game').evaluate(frame => Reflect.get((frame as HTMLIFrameElement).contentWindow!, '__fixtureToken')), gameToken)
    await page.waitForFunction(() => window.__uiTest.timers.size === 1)
    assert.equal(await page.evaluate(() => window.__uiTest.sources.filter(source => !source.closed).length), 1)
    await page.locator('#toggle-sidebar').click()
    assert.equal(await page.locator('html').evaluate(node => node.classList.contains('sidebar-collapsed')), true)
    await page.locator('#toggle-sidebar').click()
    await page.evaluate(() => window.__ra2cWorkbench!.dispose())
    assert.deepEqual(await page.evaluate(() => [window.__uiTest.sources.filter(source => !source.closed).length, window.__uiTest.timers.size]), [0, 0])
    assert.equal(await page.locator('#ra2c-game').evaluate(frame => {
      const child = (frame as HTMLIFrameElement).contentWindow as Window & typeof globalThis
      return child.Element.prototype.requestFullscreen === Reflect.get(child, '__nativeRequest') && child.document.exitFullscreen === Reflect.get(child, '__nativeExit') && !Object.hasOwn(child.document, 'fullscreenElement')
    }), true)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test('默认启用语音，游戏内按住仅提交一次，权限失败可重试，重连释放旧麦克风并恢复语音', { timeout: 25_000 }, async () => {
  const f = await fixture(false, true), { page } = f
  try {
    await page.waitForFunction(() => window.__ra2cSpeech?.view?.engine.state === 'ready')
    await page.waitForFunction(() => !(document.getElementById('voice-hold') as HTMLButtonElement).disabled)
    assert.equal(await page.locator('#voice-enable').getAttribute('aria-pressed'), 'true', '打开页面即启用麦克风，无需先点击开关')
    assert.equal(await page.locator('#say-input').isHidden(), true)
    assert.equal(await page.locator('#voice-status').innerText(), '按住右侧按钮或`说话')
    assert.equal(await page.evaluate(() => window.__uiTest.requests.filter(r => r.path.startsWith('/commander/voice/')).length), 0, '启用麦克风不会自动录音或下令')
    await page.locator('#voice-enable').click()
    assert.equal(await page.locator('#speech-model-dir').count(), 0)
    assert.equal(await page.locator('#speech-form select').count(), 2)
    await page.locator('#say-input').fill('暂存的文字指令')
    const sendWidth = (await page.locator('#say-submit').boundingBox())!.width
    assert.equal(await page.locator('#voice-status').isHidden(), true)
    assert.equal(await page.locator('.composer-field #voice-status').count(), 1)
    assert.equal(await page.locator('#voice-level').count(), 0)
    assert.equal(await page.locator('#voice-enable').getAttribute('aria-pressed'), 'false')
    const composerHeight = (await page.locator('.composer').boundingBox())!.height
    await page.evaluate(() => { window.__uiTest.micDenied = true; window.__uiTest.micPermissionPending = true })
    await page.locator('#voice-enable').click()
    await page.waitForFunction(() => typeof window.__uiTest.micGrant === 'function')
    assert.equal(await page.locator('#voice-enable').getAttribute('aria-busy'), 'true')
    assert.equal(await page.locator('#voice-status').isVisible(), true)
    assert.equal((await page.locator('.composer').boundingBox())!.height, composerHeight, '等待授权只在开关内显示 loading，不撑高输入区')
    assert.notEqual(await page.locator('#voice-enable').evaluate(button => getComputedStyle(button, '::after').animationName), 'none')
    await page.evaluate(() => { window.__uiTest.micPermissionPending = false; window.__uiTest.micGrant!() })
    await page.waitForFunction(() => document.getElementById('voice-status')!.textContent!.includes('权限被拒绝'))
    assert.match(await page.locator('#say-input').getAttribute('placeholder') ?? '', /权限被拒绝/)
    assert.equal((await page.locator('.composer').boundingBox())!.height, composerHeight, '权限错误也不增加框外提示行')
    assert.equal(await page.evaluate(() => window.__uiTest.requests.filter(r => r.path.endsWith('/start')).length), 0)
    await page.evaluate(() => { window.__uiTest.micDenied = false })
    await page.locator('#voice-enable').click()
    await page.waitForFunction(() => !(document.getElementById('voice-hold') as HTMLButtonElement).disabled)
    assert.equal(await page.locator('#voice-enable').getAttribute('aria-pressed'), 'true')
    assert.equal(await page.locator('#say-input').isHidden(), true)
    assert.equal(await page.locator('#say-submit').isHidden(), true)
    assert.equal(await page.locator('#voice-status').isVisible(), true)
    assert.equal(await page.locator('#voice-status').innerText(), '按住右侧按钮或`说话')
    await page.waitForFunction(() => parseFloat((document.querySelector('.composer-field') as HTMLElement).style.getPropertyValue('--voice-level')) > 0)
    assert.equal(await page.locator('.composer-field').evaluate(node => parseFloat(getComputedStyle(node, '::before').height) === node.clientHeight), true, '音量填充覆盖输入区背景的完整高度')
    assert.equal((await page.locator('#voice-hold').boundingBox())!.width, sendWidth)
    await page.locator('#say-form').evaluate(form => (form as HTMLFormElement).requestSubmit())
    assert.equal(await page.evaluate(() => window.__uiTest.requests.filter(r => r.path === '/commander/say').length), 0, '语音模式不会误发保留的文字草稿')
    await page.locator('#voice-enable').click()
    assert.equal(await page.locator('#say-input').isVisible(), true)
    assert.equal(await page.locator('#say-input').inputValue(), '暂存的文字指令')
    assert.equal(await page.locator('#voice-status').isHidden(), true)
    await page.locator('#voice-enable').click()
    await page.waitForFunction(() => !(document.getElementById('voice-hold') as HTMLButtonElement).disabled)
    const game = page.frameLocator('#ra2c-game').locator('body')
    await game.click()
    await page.keyboard.down('Backquote'); await page.keyboard.down('Backquote')
    await page.waitForFunction(() => document.querySelector('.card-stage')!.textContent!.includes('录音中'))
    assert.match(await page.locator('#voice-status').innerText(), /正在录音/)
    assert.equal((await page.locator('.composer').boundingBox())!.height, composerHeight, '录音状态保留固定工具栏高度')
    await page.waitForTimeout(220)
    await page.keyboard.up('Backquote'); await page.keyboard.up('Backquote')
    await page.waitForFunction(() => window.__uiTest.requests.some(r => r.path.endsWith('/audio')))
    assert.match(await page.locator('#voice-status').innerText(), /正在识别/)
    assert.equal((await page.locator('.composer').boundingBox())!.height, composerHeight, '识别状态不把工具栏向上撑开')
    const calls = await page.evaluate(() => window.__uiTest.requests.filter(r => r.path.startsWith('/commander/voice/')))
    assert.equal(calls.filter(r => r.path.endsWith('/start')).length, 1)
    assert.equal(calls.filter(r => r.path.endsWith('/audio')).length, 1)
    assert.ok(calls.find(r => r.path.endsWith('/audio'))!.bytes! > 44)
    const id = calls.find(r => r.path.endsWith('/start'))!.path.split('/')[3]!
    await page.evaluate(id => {
      const source = window.__uiTest.sources.find(s => !s.closed)!
      source.onmessage!({ data: JSON.stringify({ commandId: id, source: 'voice', seq: 100, at: Date.now(), stage: 'received', text: '展开基地', sessionKey: 'session-a' }) })
    }, id)
    assert.match(await page.locator(`[data-command="${id}"] .card-text`).innerText(), /展开基地/)
    assert.equal(await page.locator(`[data-command="${id}"] .card-source`).innerText(), '语音')
    assert.equal(await page.locator('#voice-status').innerText(), '按住右侧按钮或`说话')
    await page.keyboard.down('Backquote')
    await page.waitForFunction(() => window.__uiTest.requests.filter(r => r.path.endsWith('/start')).length === 2)
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    await page.keyboard.up('Backquote')
    await page.waitForFunction(() => window.__uiTest.requests.some(r => r.path.endsWith('/cancel')))
    assert.equal(await page.evaluate(() => window.__uiTest.requests.filter(r => r.path.endsWith('/audio')).length), 1)
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }) })
    await game.click(); await page.keyboard.down('Backquote')
    await page.waitForFunction(() => window.__uiTest.requests.filter(r => r.path.endsWith('/start')).length === 3)
    const oldTrackCount = await page.evaluate(() => window.__uiTest.tracks!.length)
    await refreshCommandPanel(page); await page.keyboard.up('Backquote')
    await page.waitForFunction(count => window.__uiTest.tracks!.slice(0, count).every(track => track.readyState === 'ended'), oldTrackCount)
    await page.waitForFunction(() => !(document.getElementById('voice-hold') as HTMLButtonElement).disabled)
    assert.equal(await page.locator('#say-input').isHidden(), true)
    assert.equal(await page.locator('#say-input').inputValue(), '暂存的文字指令')
    assert.equal(await page.evaluate(() => window.__uiTest.requests.filter(r => r.path.endsWith('/audio')).length), 1)
    await page.locator('#voice-enable').click(); await refreshCommandPanel(page)
    assert.equal(await page.locator('#say-input').isVisible(), true, '手动关闭语音后重连仍保留文字模式')
    assert.equal(await page.evaluate(() => window.__uiTest.sources.filter(s => !s.closed).length), 1)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test('卸载后的状态、记录和反馈回执不能改写新界面，并发刷新只接受最新一次，失败保留原界面', { timeout: 20_000 }, async () => {
  const f = await fixture(), { page } = f
  try {
    await page.evaluate(() => { window.__uiTest.hold.add('/commander/status'); window.__uiTest.hold.add('/commander/commands') })
    await f.remount()
    await page.waitForFunction(() => window.__uiTest.pending.length === 2)
    f.model.game = 'waiting'
    await page.evaluate(() => window.__uiTest.hold.clear()); await f.remount(); await f.ready()
    await page.waitForFunction(() => document.querySelector('#connection-text')!.textContent === '等待进入对局')
    await page.evaluate(() => {
      for (const request of window.__uiTest.pending.splice(0)) request.resolve(new Response(JSON.stringify(request.path.endsWith('status') ? { game: 'ready' } : { battleId: 'old-battle', sessionKey: 'old-session', events: [], feedback: [], warning: '旧响应' })))
    })
    await f.ready()
    assert.equal(await page.locator('#connection-text').textContent(), '等待进入对局')
    assert.equal(await page.evaluate(() => window.__ra2cCommandPanelState!.current.battleId), 'battle-a')
    const first = page.locator('[data-command="known-0"]')
    await first.locator('.feedback-toggle').click(); await first.locator('[data-rating="bad"]').click()
    await first.locator('textarea').fill('旧反馈')
    await page.evaluate(() => window.__uiTest.hold.add('/commander/feedback'))
    await first.locator('[type="submit"]').click()
    await page.waitForFunction(() => window.__uiTest.pending.length === 1)
    await refreshCommandPanel(page)
    await page.evaluate(() => window.__uiTest.hold.clear())
    await first.locator('[data-rating="good"]').click(); await first.locator('textarea').fill('新反馈')
    await first.locator('[type="submit"]').click()
    await page.waitForFunction(() => document.querySelector('.feedback-saved')!.textContent!.includes('符合预期'))
    await page.evaluate(async () => {
      window.__uiTest.pending.pop()!.resolve(new Response(JSON.stringify({ feedback: { id: 'late', at: Date.now() + 60000, commandId: 'known-0', rating: 'bad', note: '旧反馈', observed: [] } })))
      await new Promise(resolve => setTimeout(resolve, 0))
      window.__uiTest.sources.find(source => !source.closed)!.onmessage!({ data: JSON.stringify({ commandId: 'known-0', source: 'sidebar', stage: 'understood', summary: '最新理解', seq: 100, at: Date.now(), sessionKey: 'session-a' }) })
    })
    assert.equal(await page.evaluate(() => window.__ra2cCommandPanelState!.drafts.get('known-0')!.saved!.rating), 'good')
    const entered = f.holdHtml()
    const old = refreshCommandPanel(page)
    await entered
    await refreshCommandPanel(page)
    const latest = await page.locator('#say-input').getAttribute('placeholder')
    await f.model.pendingHtml.pop()!(); await old
    assert.equal(await page.locator('#say-input').getAttribute('placeholder'), latest)
    f.model.failHtml = true
    await assert.rejects(refreshCommandPanel(page), /侧栏资源读取失败/)
    assert.equal(await page.locator('#say-input').getAttribute('placeholder'), latest)
    assert.equal(await page.evaluate(() => window.__uiTest.sources.filter(source => !source.closed).length), 1)
    f.model.failHtml = false
    f.model.failCss = true
    await assert.rejects(refreshCommandPanel(page), /侧栏样式读取失败/)
    assert.equal(await page.locator('#say-input').getAttribute('placeholder'), latest)
    assert.equal(await page.locator('link[rel="stylesheet"]').count(), 1, '失败的临时样式已清理，旧样式仍在')
    f.model.failCss = false
    const unloading = f.holdHtml(), pending = refreshCommandPanel(page)
    await unloading
    await page.evaluate(() => window.__ra2cWorkbench!.dispose())
    await f.model.pendingHtml.pop()!(); await pending
    assert.equal(await page.evaluate(() => window.__uiTest.sources.filter(source => !source.closed).length), 0, '卸载后迟到的模板不能自行恢复挂载')
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test('旧页面只换命令及页签，不叠加无法卸载的旧外壳监听或轮询', { timeout: 20_000 }, async () => {
  const f = await fixture(true), { page } = f
  try {
    await page.evaluate(async () => {
      document.documentElement.style.setProperty('--sidebar-width', '320px')
      document.getElementById('toggle-sidebar')!.addEventListener('click', () => { window.__uiTest.legacyClicks++ })
      setTimeout(() => {}, 2000)
      const module = await import('/commander/command-panel.js' as string)
      module.mountCommandPanel()
    })
    await f.ready()
    for (let i = 0; i < 3; i++) await refreshCommandPanel(page)
    await page.locator('#toggle-sidebar').click()
    assert.equal(await page.evaluate(() => window.__uiTest.legacyClicks), 1)
    assert.equal(await page.evaluate(() => window.__ra2cWorkbench!.legacyShell), true)
    assert.equal(await page.evaluate(() => window.__uiTest.sources.filter(source => !source.closed).length), 1)
    assert.equal(await page.evaluate(() => window.__uiTest.requests.filter(request => request.path === '/commander/status').length), 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test('设置页退出失败可重试，侧栏重连不重复提交退出请求', { timeout: 20_000 }, async () => {
  const f = await fixture(), { page } = f
  let requests = 0
  await page.route('**/commander/quit', route => route.fulfill({ status: ++requests === 1 ? 503 : 202, json: requests === 1 ? { error: '模拟退出失败' } : { ok: true } }))
  try {
    await page.locator('#tab-settings').click()
    await page.getByRole('button', { name: '退出游戏', exact: true }).click()
    await page.getByText('退出失败：Error: 模拟退出失败', { exact: true }).waitFor()
    assert.equal(await page.locator('#exit-game').isEnabled(), true)
    await refreshCommandPanel(page); await refreshCommandPanel(page)
    await page.getByRole('button', { name: '退出游戏', exact: true }).click()
    await page.waitForFunction(() => (document.getElementById('exit-game') as HTMLButtonElement).disabled)
    assert.equal(requests, 2)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test('历史页按需读取，模型草稿跨切页与重连保留；保存不回显 Key，迟到旧回调不能覆盖新状态', { timeout: 20_000 }, async () => {
  const f = await fixture(), { page } = f
  try {
    const token = await page.locator('#ra2c-game').evaluate(el => Reflect.get((el as HTMLIFrameElement).contentWindow!, '__fixtureToken'))
    await page.locator('#tab-history').click()
    await page.locator('.history-card').waitFor()
    assert.match(await page.locator('#history-list').innerText(), /3 条命令.*1 条反馈/)
    assert.equal(await page.locator('#history-refresh').count(), 0)
    assert.equal(await page.locator('#history-status').textContent(), '')
    const reads = await page.evaluate(() => window.__uiTest.requests.filter(r => r.path === '/commander/history').length)
    await page.locator('#tab-commands').click(); await page.locator('#tab-history').click()
    await page.waitForFunction(before => window.__uiTest.requests.filter(r => r.path === '/commander/history').length > before, reads)
    await page.locator('#tab-settings').click()
    await page.waitForFunction(() => (document.getElementById('model-model') as HTMLInputElement).value === 'old')
    await page.locator('#model-url').fill('https://new-fixture.example/v1')
    await page.locator('#model-model').fill('new-model')
    await page.locator('#model-key').fill('temporary-ui-secret')
    await page.locator('#tab-commands').click(); await page.locator('#tab-settings').click()
    await refreshCommandPanel(page)
    assert.equal(await page.locator('#model-url').inputValue(), 'https://new-fixture.example/v1')
    assert.equal(await page.locator('#model-key').inputValue(), 'temporary-ui-secret')
    await page.locator('#model-save').click()
    await page.waitForFunction(() => document.getElementById('model-status')!.textContent!.includes('已保存'))
    assert.equal(await page.locator('#model-key').inputValue(), '')
    assert.equal(await page.locator('#model-key').getAttribute('placeholder'), '已配置；留空保留，填写则替换')
    const payload = await page.evaluate(() => window.__uiTest.requests.filter(r => r.path === '/commander/settings' && r.body).at(-1)!.body)
    assert.equal(JSON.parse(payload).apiKey, 'temporary-ui-secret')
    assert.equal(await page.locator('#model-form input').count(), 3)
    assert.equal(await page.locator('#model-form select').count(), 0)
    assert.equal(await page.locator('#model-form button').count(), 2)
    const saves = await page.evaluate(() => window.__uiTest.requests.filter(r => r.path === '/commander/settings' && r.body).length)
    await page.locator('#model-model').fill('test-only-model')
    await page.locator('#model-test').click()
    await page.waitForFunction(() => document.getElementById('model-status')!.textContent === '连接成功')
    assert.equal(await page.locator('#model-model').inputValue(), 'test-only-model')
    assert.equal(await page.evaluate(() => window.__uiTest.requests.filter(r => r.path === '/commander/settings' && r.body).length), saves)
    await page.evaluate(() => window.__uiTest.hold.add('/commander/settings'))
    await page.locator('#model-model').fill('pending-model')
    await page.locator('#model-save').click()
    await page.waitForFunction(() => window.__uiTest.pending.some(r => r.path === '/commander/settings'))
    await refreshCommandPanel(page)
    await page.waitForFunction(() => window.__uiTest.pending.length >= 2)
    await page.evaluate(() => {
      window.__uiTest.hold.clear()
      const latest = window.__uiTest.pending.pop()!
      latest.resolve(new Response(JSON.stringify({ revision: 1, baseUrl: 'https://new-fixture.example/v1', model: 'new-model', hasKey: true, warning: '' })))
    })
    await page.locator('#model-model').fill('latest-model')
    await page.locator('#model-save').click()
    await page.waitForFunction(() => document.getElementById('model-status')!.textContent!.includes('已保存'))
    await page.evaluate(() => {
      for (const p of window.__uiTest.pending.splice(0)) p.resolve(new Response(JSON.stringify({ revision: 99, baseUrl: 'https://stale.example', model: 'stale', hasKey: true })))
    })
    await page.waitForTimeout(30)
    assert.match(await page.locator('#model-status').innerText(), /已保存/)
    assert.equal(await page.locator('#model-model').inputValue(), 'latest-model')
    assert.equal(await page.locator('#ra2c-game').evaluate(el => Reflect.get((el as HTMLIFrameElement).contentWindow!, '__fixtureToken')), token)
    assert.equal(await page.evaluate(() => window.__uiTest.sources.filter(s => !s.closed).length), 1)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
