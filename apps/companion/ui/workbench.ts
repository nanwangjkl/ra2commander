export {}

const html = document.documentElement
const game = document.querySelector<HTMLIFrameElement>('#ra2c-game')!
const sidebar = document.querySelector<HTMLElement>('#sidebar')!
const separator = document.querySelector<HTMLElement>('#resize-sidebar')!
const toggle = document.querySelector<HTMLButtonElement>('#toggle-sidebar')!
const fullscreen = document.querySelector<HTMLButtonElement>('#fullscreen')!
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
fullscreen.addEventListener('click', () => { void toggleFullscreen() })
document.addEventListener('fullscreenchange', () => { fullscreen.textContent = document.fullscreenElement ? '退出全屏' : '全屏' })
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
  } catch { showNotice('请从顶部按钮进入工作台全屏') }
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

// ---- 命令卡片与事件流（阶段 2）----
interface CommandEvent {
  commandId: string
  seq: number
  at: number
  stage: string
  source: string
  text?: string
  summary?: string
  goalId?: string
  choice?: string
  error?: string
  owner?: string
}

const STAGE_LABEL: Record<string, string> = {
  received: '已收到', understanding: '理解中', understood: '已理解', binding: '绑定中',
  bound: '生成脚本', skipped: '部分未执行', generating: '生成脚本',
  effective: '已生效 · 执行中', failed: '失败', cancelled: '已取消',
}
const cards = document.querySelector<HTMLDivElement>('#command-cards')!
const emptyState = document.querySelector<HTMLElement>('#empty-state')!
const sayForm = document.querySelector<HTMLFormElement>('#say-form')!
const sayInput = document.querySelector<HTMLInputElement>('#say-input')!

interface CardData {
  stage: string
  source: string
  at: number
  text: string
  summary: string
  goals: Map<string, { choice: string; status: string }>
  skipped: string[]
  error: string
}
const cardData = new Map<string, CardData>()

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function renderCard(commandId: string) {
  const data = cardData.get(commandId)
  if (!data) return
  let card = cards.querySelector<HTMLElement>(`[data-command="${commandId}"]`)
  if (!card) {
    card = document.createElement('article')
    card.className = 'command-card'
    card.dataset.command = commandId
    cards.prepend(card)
  }
  const failed = data.stage === 'failed'
  card.className = `command-card${failed ? ' failed' : ''}`
  const goalRows = [...data.goals.entries()].map(([goalId, goal]) =>
    `<li data-goal="${goalId}"><span class="goal-choice">${escapeHtml(goal.choice)}</span><span class="goal-status">${escapeHtml(goal.status)}</span></li>`).join('')
  card.innerHTML = `
    <header class="card-head">
      <time>${timeLabel(data.at)}</time>
      <span class="card-source">${data.source === 'sidebar' ? '侧栏' : '终端/TCP'}</span>
      <span class="card-stage stage-${escapeHtml(data.stage)}">${escapeHtml(STAGE_LABEL[data.stage] ?? data.stage)}</span>
    </header>
    <p class="card-text">“${escapeHtml(data.text)}”</p>
    ${data.summary ? `<p class="card-summary">理解：${escapeHtml(data.summary)}</p>` : ''}
    ${goalRows ? `<ul class="card-goals">${goalRows}</ul>` : ''}
    ${data.skipped.length ? `<ul class="card-skipped">${data.skipped.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>` : ''}
    ${data.error ? `<p class="card-error">${escapeHtml(data.error)}</p>` : ''}
  `
  emptyState.hidden = cards.children.length > 0
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)
}

function applyEvent(event: CommandEvent) {
  let data = cardData.get(event.commandId)
  if (!data) {
    data = { stage: 'received', source: event.source, at: event.at, text: event.text ?? '', summary: '', goals: new Map(), skipped: [], error: '' }
    cardData.set(event.commandId, data)
  }
  switch (event.stage) {
    case 'received': data.text = event.text ?? data.text; data.at = event.at; data.stage = 'received'; break
    case 'understanding': data.stage = 'understanding'; break
    case 'understood': data.summary = event.summary ?? ''; data.stage = 'understood'; break
    case 'bound':
      data.stage = 'generating'
      data.goals.set(event.goalId ?? '', { choice: event.choice ?? '', status: '待生效' })
      break
    case 'skipped': data.skipped.push(event.error ?? '无法执行'); break
    case 'generating': data.stage = 'generating'; break
    case 'effective':
      data.stage = 'effective'
      if (event.owner) for (const goal of data.goals.values()) goal.status = '已生效'
      break
    case 'failed':
      data.stage = 'failed'
      if (event.goalId && data.goals.has(event.goalId)) data.goals.get(event.goalId)!.status = '失败'
      if (event.error) data.error = event.error
      break
    case 'cancelled':
      data.stage = 'cancelled'
      if (event.error) data.error = event.error
      break
  }
  renderCard(event.commandId)
}

function connectEvents() {
  const source = new EventSource('/commander/events')
  source.onmessage = (message: MessageEvent<string>) => {
    try { applyEvent(JSON.parse(message.data) as CommandEvent) } catch { /* 忽略异常事件。 */ }
  }
}
connectEvents()

sayForm.addEventListener('submit', async event => {
  event.preventDefault()
  const text = sayInput.value.trim()
  if (!text) return
  sayInput.value = ''
  sayInput.disabled = true
  try {
    const response = await fetch('/commander/say', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }), cache: 'no-store',
    })
    if (!response.ok) {
      const detail = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string }
      showNotice(detail.error ?? `命令提交失败（HTTP ${response.status}）`)
      sayInput.value = text // 提交失败保留原话，便于重发。
    }
  } catch (error) {
    showNotice(`命令提交失败：${String(error)}`)
    sayInput.value = text
  } finally {
    sayInput.disabled = false
    sayInput.focus()
  }
})
