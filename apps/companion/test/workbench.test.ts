import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { buildWorkbench, refreshCommandPanel } from '../src/workbench.ts'
import type { CurrentCommands } from '../../../packages/contracts/src/index.ts'

interface TestUI {
  sources: Array<{ closed: boolean; onmessage: ((event: { data: string }) => void) | null }>
  timers: Set<number>
  hold: Set<string>
  pending: Array<{ path: string; resolve: (response: Response) => void }>
  requests: Array<{ path: string; body: string }>
  legacyClicks: number
}
declare global { interface Window { __uiTest: TestUI } }

const root = resolve(import.meta.dirname, '../../..')
let browser: Browser
test.before(async () => { browser = await chromium.launch({ headless: true }) })
test.after(async () => { await browser?.close() })

async function fixture(legacy = false) {
  const folder = mkdtempSync(join(tmpdir(), 'ra2c-ui-'))
  cpSync(join(root, 'apps/companion/ui'), join(folder, 'apps/companion/ui'), { recursive: true })
  const files = buildWorkbench(folder), context = await browser.newContext()
  await context.addInitScript({ content: `
    window.__uiTest = { sources: [], timers: new Set(), hold: new Set(), pending: [], requests: [], legacyClicks: 0 };
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      window.__uiTest.requests.push({ path, body: init?.body || '' });
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
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const current: CurrentCommands = { battleId: 'battle-a', sessionKey: 'session-a', warning: '', feedback: [], events: Array.from({ length: 24 }, (_, i) => ({ commandId: `known-${i}`, source: 'sidebar', stage: 'understood', text: `已有命令 ${i}`, summary: '执行既有任务', seq: i + 1, at: Date.now() - i * 1000, sessionKey: 'session-a' })) }
  const model = { current, game: 'ready', htmlVersion: 0, failHtml: false, failCss: false, holdHtml: false, pendingHtml: [] as Array<() => Promise<void>> }
  let htmlHeld = () => {}
  const holdHtml = () => { model.holdHtml = true; return new Promise<void>(resolve => { htmlHeld = resolve }) }
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (url.origin !== 'https://workbench.test') { await route.abort(); return }
    if (path === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<body>模拟游戏文档<script>window.__fixtureToken=crypto.randomUUID();window.__nativeRequest=Element.prototype.requestFullscreen;window.__nativeExit=document.exitFullscreen;</script>' }); return
    }
    if (path === '/commander/status') { await route.fulfill({ json: { game: model.game } }); return }
    if (path === '/commander/commands') { await route.fulfill({ json: model.current }); return }
    if (path === '/commander/say') { await route.fulfill({ status: 202, json: {} }); return }
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
  await page.goto('https://workbench.test/commander/')
  const ready = () => page.waitForFunction(() => document.querySelectorAll('.command-card').length === 24 && window.__uiTest.sources.filter(source => !source.closed).length === 1)
  if (!legacy) await ready()
  const remount = () => page.evaluate(async () => {
    const module = await import('/commander/workbench-lifecycle.js' as string)
    module.mountWorkbench()
  })
  return { page, model, errors, ready, remount, holdHtml, close: async () => { await context.close(); rmSync(folder, { recursive: true, force: true }) } }
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
