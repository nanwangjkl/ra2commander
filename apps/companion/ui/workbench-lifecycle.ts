import { commandPanelState, mountCommandPanel } from './command-panel.js'
import { mountSidebarTabs } from './sidebar-tabs.js'
import { mountWorkbenchShell } from './workbench-shell.js'
import { mountHistoryPanel } from './history-panel.js'
import { mountModelSettings } from './model-settings-panel.js'
import { mountSpeechPanel } from './speech-panel.js'

declare global {
  interface Window {
    __ra2cWorkbench?: { dispose: () => void; legacyShell: boolean }
    __ra2cWorkbenchRefresh?: AbortController
  }
}

/** 一次挂载拥有全部可清理资源；旧页面的外壳只沿用，不再注册第二份监听和轮询。 */
export function mountWorkbench(options: { legacyShell?: boolean; onReady?: () => void } = {}): () => void {
  const previous = window.__ra2cWorkbench
  const legacyShell = options.legacyShell ?? previous?.legacyShell ?? false
  if (previous) previous.dispose()
  else { window.__ra2cUnmountCommands?.(); window.__ra2cUnmountSidebarTabs?.() }
  const cleanup: Array<() => void> = []
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    if (window.__ra2cWorkbench?.dispose === dispose) window.__ra2cWorkbenchRefresh?.abort()
    for (const stop of cleanup.splice(0).reverse()) stop()
  }
  window.__ra2cWorkbench = { dispose, legacyShell }
  try {
    if (!legacyShell) cleanup.push(mountWorkbenchShell())
    cleanup.push(mountCommandPanel(options.onReady))
    const history = mountHistoryPanel(), settings = mountModelSettings(), speech = mountSpeechPanel()
    cleanup.push(history.dispose, settings.dispose, speech.dispose)
    cleanup.push(mountExitGame())
    cleanup.push(mountSidebarTabs(() => {
      const cards = document.querySelector<HTMLElement>('#command-cards')!
      cards.scrollTop = commandPanelState().scrollTop
      const page = document.querySelector<HTMLElement>('#sidebar')!.dataset.activePage
      if (page === 'history') history.show()
      if (page === 'settings') { settings.show(); speech.show() }
    }))
  } catch (error) { dispose(); throw error }
  return dispose
}

function mountExitGame(): () => void {
  const lifetime = new AbortController(), signal = lifetime.signal
  const button = document.querySelector<HTMLButtonElement>('#exit-game')!, status = document.querySelector<HTMLElement>('#exit-status')!
  button.addEventListener('click', () => {
    if (button.disabled) return
    button.disabled = true; button.textContent = '正在退出…'; status.textContent = ''
    void (async () => {
      try {
        const response = await fetch('/commander/quit', { method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
        if (!response.ok) { const data = await response.json(); throw new Error(data.error || '退出请求失败') }
      } catch (error) {
        if (signal.aborted) return
        button.disabled = false; button.textContent = '退出游戏'; status.textContent = `退出失败：${String(error)}`
      }
    })()
  }, { signal })
  return () => lifetime.abort()
}

/** 样式也先加载成功，失败或取消时保留旧样式与界面。 */
function prepareStyle(current: HTMLLinkElement, version: string, signal: AbortSignal): Promise<HTMLLinkElement> {
  return new Promise((resolve, reject) => {
    const next = current.cloneNode(false) as HTMLLinkElement
    next.href = `/commander/workbench.css?v=${version}`
    next.media = 'not all'
    const cleanup = () => { next.onload = next.onerror = null; signal.removeEventListener('abort', cancel) }
    const cancel = () => { cleanup(); next.remove(); reject(signal.reason) }
    next.onload = () => { cleanup(); resolve(next) }
    next.onerror = () => { cleanup(); next.remove(); reject(new Error('侧栏样式读取失败')) }
    if (signal.aborted) cancel()
    else { signal.addEventListener('abort', cancel, { once: true }); document.head.append(next) }
  })
}

/** 新资源准备成功后才替换侧栏；整个过程不导航或替换游戏 iframe。 */
export async function refreshWorkbench(version: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(`/commander/?v=${version}`, { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
  if (!response.ok) throw new Error('侧栏资源读取失败')
  const text = await response.text()
  if (signal.aborted) return
  const template = new DOMParser().parseFromString(text, 'text/html')
  const heading = template.querySelector<HTMLElement>('.sidebar-heading')
  const status = template.querySelector<HTMLElement>('.status-bar')
  const content = template.querySelector<HTMLElement>('#sidebar')
  if (!heading || !status || !content || !template.getElementById('say-input') || !template.getElementById('command-cards')) throw new Error('侧栏模板不完整')
  const css = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')!
  const preparedStyle = await prepareStyle(css, version, AbortSignal.any([signal, AbortSignal.timeout(10_000)]))
  if (signal.aborted) { preparedStyle.remove(); return }

  const state = commandPanelState()
  const sidebar = document.querySelector<HTMLElement>('#sidebar')!
  const input = document.querySelector<HTMLInputElement>('#say-input')!
  const cards = document.querySelector<HTMLElement>('#command-cards')!
  if (cards.getClientRects().length) state.scrollTop = cards.scrollTop
  const draft = input.value
  const focused = document.activeElement as HTMLElement | null
  const focusedId = focused?.id
  const commandId = focused?.closest<HTMLElement>('[data-command]')?.dataset.command
  const field = focused?.tagName === 'TEXTAREA' ? 'textarea' : focused?.dataset.rating ? `[data-rating="${focused.dataset.rating}"]` : focused?.matches('.feedback-toggle') ? '.feedback-toggle' : undefined
  const selection = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] as const : undefined
  const legacyShell = window.__ra2cWorkbench?.legacyShell ?? !!document.documentElement.style.getPropertyValue('--sidebar-width')
  let focusRestored = false
  const restoreView = () => {
    document.querySelector<HTMLElement>('#command-cards')!.scrollTop = state.scrollTop
    if (focusRestored) return
    const active = document.activeElement
    if (active !== document.body && active !== focused) { focusRestored = true; return }
    const card = commandId ? [...document.querySelectorAll<HTMLElement>('[data-command]')].find(card => card.dataset.command === commandId) : undefined
    const target = focusedId ? document.getElementById(focusedId) : field ? card?.querySelector<HTMLElement>(field) : undefined
    if (!target) return
    target.focus({ preventScroll: true })
    if (selection && selection[0] !== null && selection[1] !== null && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) target.setSelectionRange(selection[0], selection[1], selection[2] ?? undefined)
    focusRestored = true
  }

  // 资源已齐，当前刷新进入同步交接；普通卸载仍会中止尚未完成的刷新。
  if (window.__ra2cWorkbenchRefresh?.signal === signal) delete window.__ra2cWorkbenchRefresh
  if (window.__ra2cWorkbench) window.__ra2cWorkbench.dispose()
  else { window.__ra2cUnmountCommands?.(); window.__ra2cUnmountSidebarTabs?.() }
  // 旧外壳仍引用这些节点。新外壳也复用它们，保持状态栏和布局节点身份稳定。
  for (const id of ['toggle-sidebar', 'connection-dot', 'connection-text', 'notice']) {
    const current = document.getElementById(id), target = heading.querySelector(`#${id}`) ?? status.querySelector(`#${id}`)
    if (current && target) {
      if (id === 'toggle-sidebar') for (const name of ['aria-label', 'title']) current.setAttribute(name, target.getAttribute(name)!)
      target.replaceWith(current)
    }
  }
  sidebar.setAttribute('aria-label', content.getAttribute('aria-label')!)
  sidebar.replaceChildren(...Array.from(content.childNodes))
  document.querySelector('.sidebar-heading')?.remove()
  document.querySelector('.status-bar')?.remove()
  document.querySelector('.toolbar')?.remove()
  sidebar.before(heading); sidebar.after(status)
  document.querySelector<HTMLInputElement>('#say-input')!.value = draft
  preparedStyle.media = css.media
  css.remove()
  mountWorkbench({ legacyShell, onReady: restoreView })
  restoreView()
}
