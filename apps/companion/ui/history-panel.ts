import type { BattleRecordInfo } from '../../../packages/contracts/src/battle-record.js'

interface Download { token: string; battleId: string; state: 'preparing' | 'ready' | 'failed'; error?: string; bytes?: number }
interface HistoryState { records: BattleRecordInfo[]; downloads: Map<string, Download>; notices: Map<string, string>; scroll: number }
declare global { interface Window { __ra2cHistory?: HistoryState } }

export function mountHistoryPanel() {
  const state = window.__ra2cHistory ??= { records: [], downloads: new Map(), notices: new Map(), scroll: 0 }
  const lifetime = new AbortController(), signal = lifetime.signal
  const list = document.querySelector<HTMLElement>('#history-list')!, status = document.querySelector<HTMLElement>('#history-status')!
  const page = document.querySelector<HTMLElement>('#page-history .page-content')!
  const polling = new Set<string>(), timers = new Set<ReturnType<typeof setTimeout>>()
  const starting = new Map<string, Download>()
  let loading = false
  const request = async (url: string, post = false): Promise<any> => {
    const response = await fetch(url, { ...(post ? { method: 'POST' } : {}), cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
    const data = await response.json()
    signal.throwIfAborted()
    if (!response.ok) throw new Error(data.error ?? '读取失败')
    return data
  }
  const render = () => {
    if (signal.aborted) return
    const scroll = page.scrollTop || state.scroll
    list.replaceChildren()
    for (const record of state.records) {
      const card = document.createElement('article'); card.className = 'history-card'; card.dataset.battle = record.id
      const title = document.createElement('div'); title.className = 'history-head'
      const time = document.createElement('time'); time.textContent = new Date(record.startedAt).toLocaleString('zh-CN'); time.dateTime = new Date(record.startedAt).toISOString()
      const outcome = document.createElement('span'); outcome.textContent = record.result ? record.result.outcome === 'victory' ? '胜利' : '失败' : '未记录'
      title.append(time, outcome)
      const detail = document.createElement('p'); detail.textContent = `${record.commands} 条命令 · ${record.feedback} 条反馈`
      const download = state.downloads.get(record.id), button = document.createElement('button')
      button.type = 'button'; button.textContent = download?.state === 'preparing' ? '准备调试包…' : '下载调试包'; button.disabled = download?.state === 'preparing'
      const note = document.createElement('p'); note.className = 'page-message'; note.textContent = state.notices.get(record.id) ?? download?.error ?? ''
      button.dataset.download = record.id
      card.append(title, detail, button, note); list.append(card)
    }
    if (!state.records.length) { const empty = document.createElement('p'); empty.className = 'page-message'; empty.textContent = '暂无历史对战记录'; list.append(empty) }
    page.scrollTop = scroll
  }
  const later = (callback: () => void) => {
    const timer = setTimeout(() => { timers.delete(timer); if (!signal.aborted) callback() }, 800)
    timers.add(timer)
  }
  const poll = async (id: string) => {
    if (signal.aborted || polling.has(id)) return
    const known = state.downloads.get(id)
    if (!known?.token || known.state !== 'preparing') return
    polling.add(id)
    try {
      const job = await request(`/commander/exports/${known.token}`) as Download
      state.downloads.set(id, job)
      if (job.state === 'ready') {
        const link = document.createElement('a'); link.href = `/commander/exports/${job.token}/download`; link.download = `${id}.zip`
        document.body.append(link); link.click(); link.remove()
        state.notices.set(id, `已开始下载${job.bytes ? `（${(job.bytes / 1024 / 1024).toFixed(2)} MB）` : ''}`)
      } else if (job.state === 'failed') state.notices.set(id, job.error ?? '导出失败，请重试')
      else later(() => { void poll(id) })
      render()
    } catch (error) {
      if (!signal.aborted) { state.downloads.delete(id); state.notices.set(id, String(error)); render() }
    } finally { polling.delete(id) }
  }
  const start = async (id: string) => {
    const pending: Download = { token: '', battleId: id, state: 'preparing' }
    starting.set(id, pending); state.downloads.set(id, pending); state.notices.delete(id); render()
    try {
      const job = await request(`/commander/records/${id}/export`, true) as Download
      state.downloads.set(id, { ...job, state: job.state === 'ready' ? 'preparing' : job.state })
      render(); void poll(id)
    } catch (error) {
      if (!signal.aborted) { state.downloads.delete(id); state.notices.set(id, String(error)); render() }
    } finally { starting.delete(id) }
  }
  const show = async () => {
    if (loading || signal.aborted) return
    loading = true
    try {
      const data = await request('/commander/history') as { records: BattleRecordInfo[]; warning: string }
      state.records = data.records; status.textContent = data.warning || ''; render()
      for (const record of state.records) void poll(record.id)
    } catch (error) { if (!signal.aborted) status.textContent = String(error) }
    finally { loading = false }
  }
  list.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-download]')
    if (button && !button.disabled) void start(button.dataset.download!)
  }, { signal })
  page.addEventListener('scroll', () => { if (page.getClientRects().length) state.scroll = page.scrollTop }, { signal })
  render()
  return { show: () => { void show() }, dispose: () => {
    for (const [id, pending] of starting) if (state.downloads.get(id) === pending) { state.downloads.delete(id); state.notices.set(id, '上次准备结果待确认，请重新下载') }
    lifetime.abort(); for (const timer of timers) clearTimeout(timer)
  } }
}
