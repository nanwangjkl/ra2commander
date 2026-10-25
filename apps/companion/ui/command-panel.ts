import type { CommandEvent } from '../../../packages/contracts/src/command-log.ts'
import { applyCommandEvent, type CardData } from './command-card.js'
import { mountFeedback, type FeedbackDraft } from './command-feedback.js'
import type { CurrentCommands } from '../../../packages/contracts/src/battle-record.ts'

declare global { interface Window { __ra2cUnmountCommands?: () => void } }

const LABEL: Record<string, string> = {
  received: '已收到', understanding: '理解中', understood: '已理解', binding: '绑定目标',
  bound: '待生效', skipped: '部分未执行', generating: '生成脚本', merged: '等待合并版本',
  effective: '执行中', running: '执行中', continuous: '持续执行', completed: '已完成',
  partial: '部分执行', 'partial-completed': '部分完成', failed: '失败', cancelled: '已取消', blocked: '执行受阻', paused: '已暂停', faulted: '运行出错',
}

export function mountCommandPanel(): void {
  window.__ra2cUnmountCommands?.()
  const cards = document.querySelector<HTMLDivElement>('#command-cards')!
  const empty = document.querySelector<HTMLElement>('#empty-state')!
  const form = document.querySelector<HTMLFormElement>('#say-form')!
  const input = document.querySelector<HTMLInputElement>('#say-input')!
  const status = document.querySelector<HTMLElement>('#events-status')!
  const cardData = new Map<string, CardData>()
  const drafts = new Map<string, FeedbackDraft>()
  const lifetime = new AbortController()
  let current: CurrentCommands = { battleId: null, sessionKey: null, events: [], feedback: [], warning: '' }
  let localSeq = 0
  let initialized = false
  let refreshing: Promise<void> | undefined
  let queued: CommandEvent[] = []
  cards.replaceChildren()
  cards.hidden = true
  empty.hidden = false

  const escape = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
  function receive(event: CommandEvent) {
    const data = applyCommandEvent({ ...event, seq: ++localSeq }, cardData.get(event.commandId))
    cardData.set(event.commandId, data)
    let card = [...cards.children].find(child => (child as HTMLElement).dataset.command === event.commandId) as HTMLElement | undefined
    if (!card) {
      card = document.createElement('article'); card.dataset.command = event.commandId
      card.innerHTML = '<div class="card-content"></div><div class="card-feedback"></div>'
      const next = [...cards.children].find(child => (cardData.get((child as HTMLElement).dataset.command!)?.at ?? 0) < data.at)
      cards.insertBefore(card, next ?? null)
      const key = event.commandId
      let draft = drafts.get(key)
      if (!draft) {
        const feedback = current.feedback.filter(item => item.commandId === event.commandId).at(-1)
        draft = { note: feedback?.note ?? '', open: false, ...(feedback ? { rating: feedback.rating, saved: feedback } : {}) }; drafts.set(key, draft)
      }
      const cardBattle = current.battleId
      mountFeedback(card.querySelector('.card-feedback')!, event.commandId, () => cardBattle ?? current.battleId, draft, lifetime.signal)
    }
    card.className = `command-card ${data.stage}`
    const errors = [...new Set([data.error, ...[...data.goals.values()].flatMap(goal => [
      ...(['failed', 'cancelled'].includes(goal.stage) ? [goal.error] : []),
      ...(['faulted', 'blocked'].includes(goal.execution?.state ?? '') ? [goal.execution?.detail] : []),
    ])].filter((value): value is string => !!value))]
    const rows = [...data.goals.entries()].map(([id, goal]) => {
      const state = goal.execution?.state ?? goal.stage
      const progress = goal.execution?.progress
      return `<li data-goal="${escape(id)}"><span class="goal-choice">${escape(goal.choice)}${progress ? `<small class="goal-progress">已产出 ${progress.completed}/${progress.total}</small>` : ''}</span><span class="goal-status stage-${state}">${LABEL[state] ?? state}${goal.version !== undefined ? ` · v${goal.version}` : ''}</span></li>`
    }).join('')
    const completed = [...data.goals.values()].filter(goal => goal.execution?.state === 'completed').length
    const completion = completed && data.goals.size > 1 ? ` · ${completed}/${data.goals.size} 完成` : ''
    const expanded = card.querySelector<HTMLDetailsElement>('.card-error')?.open ?? false
    card.querySelector('.card-content')!.innerHTML = `<header class="card-head"><time>${new Date(data.at).toLocaleTimeString('zh-CN', { hour12: false })}</time><span class="card-source">${data.source === 'sidebar' ? '侧栏' : data.source === 'restored' ? '恢复记录' : '终端/TCP'}</span><span class="card-stage stage-${data.stage}">${LABEL[data.stage]}${completion}</span></header>
      <p class="card-text">“${escape(data.text)}”</p>
      ${data.summary ? `<p class="card-summary">理解：${escape(data.summary)}</p>` : ''}
      ${rows ? `<ul class="card-goals">${rows}</ul>` : ''}
      ${data.skipped.size ? `<ul class="card-skipped">${[...data.skipped].map(error => `<li>${escape(error)}</li>`).join('')}</ul>` : ''}
      ${errors.length ? `<details class="card-error" ${expanded ? 'open' : ''}><summary>${escape(errors[0]!.split('\n')[0]!.slice(0, 100))}</summary><p>${escape(errors.join('\n'))}</p></details>` : ''}`
    cards.hidden = false
    empty.hidden = true
  }

  const matchesCurrent = (event: CommandEvent) => event.sessionKey === undefined || event.sessionKey === current.sessionKey
  function refreshCurrent(): Promise<void> {
    if (refreshing) return refreshing
    refreshing = (async () => {
      try {
        const response = await fetch('/commander/commands', { cache: 'no-store', signal: lifetime.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const value = await response.json() as CurrentCommands
        if (value.battleId !== current.battleId) { cardData.clear(); cards.replaceChildren(); cards.hidden = true; empty.hidden = false }
        current = value
        // 重连只补齐当前局卡片；普通状态更新保留反馈表单和输入焦点。
        for (const event of current.events) receive(event)
        initialized = true
        status.textContent = value.warning || '文本模拟语音 · 真实录音尚未启用'
        const pending = queued; queued = []
        for (const event of pending) if (matchesCurrent(event)) receive(event)
      } catch (error) { if (!lifetime.signal.aborted) status.textContent = `命令记录连接失败：${String(error)}` }
      finally { refreshing = undefined }
    })()
    return refreshing
  }
  function live(event: CommandEvent) {
    if (refreshing) { queued.push(event); return }
    if (!initialized || !matchesCurrent(event) || (!current.battleId && event.sessionKey !== undefined)) {
      queued.push(event); void refreshCurrent(); return
    }
    receive(event)
  }

  const source = new EventSource('/commander/events')
  source.onopen = () => { void refreshCurrent() }
  source.onerror = () => { status.textContent = '命令反馈连接中，正在重连…' }
  source.onmessage = message => {
    try { live(JSON.parse(message.data) as CommandEvent) } catch { status.textContent = '命令反馈异常，等待后续更新' }
  }
  void refreshCurrent()

  form.addEventListener('submit', async event => {
    event.preventDefault()
    const text = input.value.trim()
    if (!text) return
    const commandId = `cmd-${crypto.randomUUID()}`
    input.value = ''
    // 输入期间即可继续下令；请求结束不改变当前焦点，也不覆盖后来输入的文字。
    receive({ commandId, text, stage: 'received', source: 'sidebar', seq: 0, at: Date.now() })
    try {
      const response = await fetch('/commander/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, commandId }), cache: 'no-store', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]) })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(detail.error ?? `HTTP ${response.status}`)
      }
    } catch (error) {
      if (lifetime.signal.aborted) return
      const current = cardData.get(commandId)
      // 已收到模型/脚本事件就说明宿主收到了命令，不能被迟到的提交错误覆盖。
      if (current && current.stage !== 'received') return
      receive({ commandId, stage: 'failed', source: 'sidebar', seq: 0.5, at: Date.now(), error: `命令提交未确认：${String(error)}。请查看后续反馈，避免重复下令。` })
      if (!input.value) input.value = text
    }
  }, { signal: lifetime.signal })
  window.__ra2cUnmountCommands = () => { lifetime.abort(); source.close() }
}
