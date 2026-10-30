import { mountCommandPanel } from './command-panel.js'

const html = document.documentElement
const game = document.querySelector<HTMLIFrameElement>('#ra2c-game')!
const sidebar = document.querySelector<HTMLElement>('#sidebar')!
const separator = document.querySelector<HTMLElement>('#resize-sidebar')!
const toggle = document.querySelector<HTMLButtonElement>('#toggle-sidebar')!
const connectionText = document.querySelector<HTMLElement>('#connection-text')!
const connectionDot = document.querySelector<HTMLElement>('#connection-dot')!
const notice = document.querySelector<HTMLElement>('#notice')!
const storageKey = 'ra2c-workbench-layout'
let width = 320
let collapsed = false
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as { width?: number; collapsed?: boolean }
  if (Number.isFinite(saved.width)) width = saved.width!
  collapsed = saved.collapsed === true
} catch { /* 布局存储不可用时使用默认值。 */ }

function layout() {
  width = Math.max(220, Math.min(width, 520, Math.max(220, window.innerWidth - 480)))
  html.style.setProperty('--sidebar-width', `${width}px`)
  html.classList.toggle('sidebar-collapsed', collapsed)
  sidebar.inert = collapsed
  toggle.textContent = collapsed ? '展开侧栏' : '收起侧栏'
  toggle.setAttribute('aria-expanded', String(!collapsed))
  separator.setAttribute('aria-valuenow', String(width))
  separator.setAttribute('aria-valuemin', '220')
  separator.setAttribute('aria-valuemax', String(Math.min(520, Math.max(220, window.innerWidth - 480))))
  separator.tabIndex = collapsed ? -1 : 0
}
function saveLayout() {
  try { localStorage.setItem(storageKey, JSON.stringify({ width, collapsed })) } catch { /* 不影响游戏。 */ }
}
function focusGame() { game.contentWindow?.focus() }
toggle.addEventListener('click', () => { collapsed = !collapsed; layout(); saveLayout(); focusGame() })
window.addEventListener('resize', layout)
layout()

let dragging: number | undefined
separator.addEventListener('pointerdown', event => {
  if (event.button !== 0) return
  event.preventDefault()
  dragging = event.pointerId
  separator.setPointerCapture(event.pointerId)
  html.classList.add('resizing')
})
separator.addEventListener('pointermove', event => {
  if (dragging !== event.pointerId) return
  width = window.innerWidth - event.clientX
  layout()
})
function endResize() {
  if (dragging === undefined) return
  dragging = undefined
  html.classList.remove('resizing')
  saveLayout()
  focusGame()
}
separator.addEventListener('pointerup', endResize)
separator.addEventListener('pointercancel', endResize)
separator.addEventListener('lostpointercapture', endResize)
window.addEventListener('blur', endResize)
separator.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
  event.preventDefault()
  width += event.key === 'ArrowLeft' ? 16 : -16
  layout()
  saveLayout()
})

function showNotice(message: string) { notice.textContent = message; notice.hidden = !message }
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await html.requestFullscreen()
    showNotice('')
    focusGame()
  } catch { showNotice('浏览器未允许全屏') }
}
function fullscreenKey(event: KeyboardEvent) {
  if (event.key !== 'F11') return
  event.preventDefault()
  event.stopImmediatePropagation()
  if (event.type === 'keydown' && !event.repeat) void toggleFullscreen()
}
document.addEventListener('keydown', fullscreenKey, true)
document.addEventListener('keyup', fullscreenKey, true)

// 游戏仍在自己的文档内运行；把其全屏请求转交外层，保持侧栏可见。
let removeFullscreenBridge = () => {}
function connectGameDocument() {
  removeFullscreenBridge()
  const child = game.contentWindow as (Window & typeof globalThis) | null
  if (!child) return
  try {
    const doc = child.document
    child.Element.prototype.requestFullscreen = options => html.requestFullscreen(options)
    doc.exitFullscreen = () => document.fullscreenElement ? document.exitFullscreen() : Promise.resolve()
    Object.defineProperty(doc, 'fullscreenElement', { configurable: true, get: () => document.fullscreenElement ? doc.documentElement : null })
    const changed = () => doc.dispatchEvent(new child.Event('fullscreenchange'))
    document.addEventListener('fullscreenchange', changed)
    doc.addEventListener('keydown', fullscreenKey, true)
    doc.addEventListener('keyup', fullscreenKey, true)
    removeFullscreenBridge = () => {
      document.removeEventListener('fullscreenchange', changed)
      doc.removeEventListener('keydown', fullscreenKey, true)
      doc.removeEventListener('keyup', fullscreenKey, true)
    }
  } catch { showNotice('游戏全屏入口暂不可用') }
}
game.addEventListener('load', connectGameDocument)
if (game.contentDocument?.readyState === 'complete') connectGameDocument()

async function updateConnection() {
  let text = '伴随程序未连接'
  let state = 'offline'
  try {
    const response = await fetch('/commander/status', { cache: 'no-store', signal: AbortSignal.timeout(3000) })
    if (!response.ok) throw new Error('status unavailable')
    const status = await response.json() as { game: 'loading' | 'waiting' | 'ready' }
    text = status.game === 'ready' ? '对局已连接' : status.game === 'waiting' ? '等待进入对局' : '游戏加载中'
    state = status.game === 'ready' ? 'ready' : ''
  } catch { /* 后端重启时只更新状态，不导航或刷新游戏。 */ }
  if (connectionText.textContent !== text) connectionText.textContent = text
  if (connectionDot.className !== `dot ${state}`) connectionDot.className = `dot ${state}`
  setTimeout(() => { void updateConnection() }, 2000)
}
void updateConnection()

mountCommandPanel()
