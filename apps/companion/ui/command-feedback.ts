import type { CommandFeedback, FeedbackRating } from '../../../packages/contracts/src/battle-record.ts'

export const FEEDBACK_LABEL = { good: '符合预期', partial: '部分达成', bad: '不符合预期' }
export interface FeedbackDraft { rating?: FeedbackRating; note: string; open: boolean; saved?: CommandFeedback }

/** 独立于卡片正文更新，执行状态变化不会吞掉正在输入的备注或焦点。 */
export function mountFeedback(container: HTMLElement, commandId: string, battle: () => string | null, draft: FeedbackDraft, signal: AbortSignal): void {
  const toggle = document.createElement('button')
  toggle.type = 'button'; toggle.className = 'feedback-toggle'; toggle.textContent = '反馈'
  const saved = document.createElement('span'); saved.className = 'feedback-saved'
  const panel = document.createElement('form'); panel.className = 'feedback-form'; panel.hidden = !draft.open
  panel.innerHTML = `<div class="feedback-ratings" role="group" aria-label="执行情况">${Object.entries(FEEDBACK_LABEL).map(([rating, label]) => `<button type="button" data-rating="${rating}" aria-pressed="false">${label}</button>`).join('')}</div><textarea aria-label="反馈备注" placeholder="哪里不对？希望如何执行？（选填）" maxlength="4000" rows="3"></textarea><div class="feedback-actions"><button type="submit">保存反馈</button><span role="status"></span></div>`
  const note = panel.querySelector('textarea')!
  const message = panel.querySelector<HTMLElement>('[role="status"]')!
  const submit = panel.querySelector<HTMLButtonElement>('[type="submit"]')!
  note.value = draft.note
  const update = () => {
    toggle.setAttribute('aria-expanded', String(!panel.hidden))
    saved.textContent = draft.saved ? `已反馈：${FEEDBACK_LABEL[draft.saved.rating]}` : ''
    for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-rating]')) button.setAttribute('aria-pressed', String(button.dataset.rating === draft.rating))
  }
  toggle.addEventListener('click', () => { panel.hidden = !panel.hidden; draft.open = !panel.hidden; update() }, { signal })
  note.addEventListener('input', () => { draft.note = note.value }, { signal })
  panel.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-rating]')
    if (button) { draft.rating = button.dataset.rating as FeedbackRating; update() }
  }, { signal })
  panel.addEventListener('submit', async event => {
    event.preventDefault()
    if (!draft.rating) { message.textContent = '先选择执行情况'; return }
    const battleId = battle()
    if (!battleId) { message.textContent = '记录尚未就绪，请稍后重试'; return }
    submit.disabled = true; message.textContent = '保存中…'
    try {
      const response = await fetch('/commander/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ battleId, commandId, rating: draft.rating, note: draft.note }), signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
      const result = await response.json() as { feedback?: CommandFeedback; error?: string }
      if (!response.ok || !result.feedback) throw new Error(result.error ?? `HTTP ${response.status}`)
      draft.saved = result.feedback
      message.textContent = '已保存到本地对局记录'; update()
    } catch (error) { if (!signal.aborted) message.textContent = `保存失败：${String(error)}，可重试` }
    finally { submit.disabled = false }
  }, { signal })
  update(); container.append(toggle, saved, panel)
}
