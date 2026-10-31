declare global { interface Window { __ra2cUnmountSidebarTabs?: () => void } }

/** 页签只改变中间内容的可见性，保留命令订阅、输入和反馈草稿。 */
export function mountSidebarTabs(onSelect: () => void = () => {}): () => void {
  window.__ra2cUnmountSidebarTabs?.()
  const sidebar = document.querySelector<HTMLElement>('#sidebar')!
  const tabs = [...sidebar.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const lifetime = new AbortController()
  const select = (tab: HTMLButtonElement) => {
    sidebar.dataset.activePage = tab.dataset.page!
    for (const item of tabs) {
      const selected = item === tab
      item.setAttribute('aria-selected', String(selected))
      item.tabIndex = selected ? 0 : -1
      document.getElementById(item.getAttribute('aria-controls')!)!.hidden = !selected
    }
    onSelect()
  }
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => select(tab), { signal: lifetime.signal })
    tab.addEventListener('keydown', event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined
      if (next === undefined) return
      event.preventDefault()
      select(tabs[next]!)
      tabs[next]!.focus()
    }, { signal: lifetime.signal })
  }
  select(tabs.find(tab => tab.dataset.page === sidebar.dataset.activePage) ?? tabs[0]!)
  const dispose = () => {
    lifetime.abort()
    if (window.__ra2cUnmountSidebarTabs === dispose) delete window.__ra2cUnmountSidebarTabs
  }
  window.__ra2cUnmountSidebarTabs = dispose
  return dispose
}
