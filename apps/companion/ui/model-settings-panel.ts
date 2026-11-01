import type { ModelSettingsInput, ModelSettingsView } from '../../../packages/contracts/src/workbench-settings.js'

interface State { view?: ModelSettingsView; draft?: ModelSettingsInput; dirty: boolean; message: string; scroll?: number }
declare global { interface Window { __ra2cModelSettings?: State } }

export function mountModelSettings() {
  const state = window.__ra2cModelSettings ??= { dirty: false, message: '' }
  const lifetime = new AbortController(), signal = lifetime.signal
  const form = document.querySelector<HTMLFormElement>('#model-form')!, page = document.querySelector<HTMLElement>('#page-settings .page-content')!
  const url = document.querySelector<HTMLInputElement>('#model-url')!, model = document.querySelector<HTMLInputElement>('#model-model')!, key = document.querySelector<HTMLInputElement>('#model-key')!
  const status = document.querySelector<HTMLElement>('#model-status')!
  const test = document.querySelector<HTMLButtonElement>('#model-test')!
  let busy = false, loading = false, testingRequest = false
  const message = (value: string) => { state.message = value; if (!signal.aborted) status.textContent = value }
  const render = () => {
    if (signal.aborted) return
    url.value = state.draft?.baseUrl ?? ''; model.value = state.draft?.model ?? ''; key.value = state.draft?.apiKey ?? ''
    key.placeholder = state.view?.hasKey ? '已配置；留空保留，填写则替换' : '填写 API Key'
    status.textContent = state.message || state.view?.warning || ''
    page.scrollTop = state.scroll ?? 0
  }
  const collect = () => {
    state.draft = { baseUrl: url.value, model: model.value, apiKey: key.value, revision: state.view?.revision ?? 0 }
    state.dirty = true
    return state.draft
  }
  const controls = (disabled: boolean) => { for (const el of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) el.disabled = disabled }
  const request = async <T = ModelSettingsView>(input?: ModelSettingsInput, testing = false): Promise<T> => {
    const response = await fetch(`/commander/settings${testing ? '/test' : ''}`, { ...(input ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : {}), cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(testing ? 20_000 : 10_000)]) })
    const data = await response.json(); signal.throwIfAborted()
    if (!response.ok) throw new Error(data.error ?? '请求失败')
    return data as T
  }
  const useView = (view: ModelSettingsView) => { state.draft = { baseUrl: view.baseUrl, model: view.model, apiKey: '', revision: view.revision }; state.dirty = false }
  const load = async () => {
    if (loading || busy || signal.aborted) return
    loading = true
    try {
      state.view = await request()
      if (!state.dirty || !state.draft) { useView(state.view); state.message = '' }
      render()
    } catch (error) { if (!signal.aborted) message(String(error)) }
    finally { loading = false }
  }
  const submit = async (testing = false) => {
    if (busy || !form.reportValidity()) return
    const input = collect(); busy = true; testingRequest = testing; controls(true); message(testing ? '正在测试连接…' : '保存中…')
    try {
      if (testing) { await request<{ ok: boolean }>(input, true); message('连接成功') }
      else { state.view = await request(input); useView(state.view); render(); message('已保存，后续新请求使用此模型') }
    } catch (error) { if (!signal.aborted) message(String(error)) }
    finally { busy = false; if (!signal.aborted) controls(false) }
  }
  form.addEventListener('input', collect, { signal })
  form.addEventListener('submit', event => { event.preventDefault(); void submit() }, { signal })
  test.addEventListener('click', () => { void submit(true) }, { signal })
  page.addEventListener('scroll', () => { if (page.getClientRects().length) state.scroll = page.scrollTop }, { signal })
  render()
  return { show: () => { void load() }, dispose: () => {
    if (busy) state.message = testingRequest ? '上次连接测试已中断，可重新测试' : '上次保存结果待确认，输入已保留；可切换页签确认'
    lifetime.abort()
  } }
}
