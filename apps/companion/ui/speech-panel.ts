import type { CommandEvent } from '../../../packages/contracts/src/command-log.ts'
import type { SpeechSettingsInput, SpeechSettingsView } from '../../../packages/contracts/src/speech.ts'
import { MicrophoneCapture } from './speech-audio.js'

interface SpeechMemory { view?: SpeechSettingsView; draft?: SpeechSettingsInput; dirty: boolean; enabled?: boolean }
interface Recording { id: string; kind: 'key' | 'pointer'; released: boolean; ready: Promise<void>; timer: ReturnType<typeof setTimeout> }
declare global { interface Window { __ra2cSpeech?: SpeechMemory } }

export function mountSpeechPanel() {
  const memory = window.__ra2cSpeech ??= { dirty: false }, lifetime = new AbortController(), signal = lifetime.signal
  memory.enabled ??= true
  const enable = document.querySelector<HTMLButtonElement>('#voice-enable')!, hold = document.querySelector<HTMLButtonElement>('#voice-hold')!
  const status = document.querySelector<HTMLElement>('#voice-status')!, field = document.querySelector<HTMLElement>('.composer-field')!
  const composer = document.querySelector<HTMLFormElement>('#say-form')!, input = document.querySelector<HTMLInputElement>('#say-input')!, send = document.querySelector<HTMLButtonElement>('#say-submit')!
  const textPlaceholder = input.placeholder
  const form = document.querySelector<HTMLFormElement>('#speech-form')!, device = document.querySelector<HTMLSelectElement>('#speech-device')!
  const key = document.querySelector<HTMLSelectElement>('#speech-key')!
  const settingsStatus = document.querySelector<HTMLElement>('#speech-settings-status')!, reload = document.querySelector<HTMLButtonElement>('#speech-reload')!
  const jobs = new Map<string, AbortController>()
  let microphone: MicrophoneCapture | undefined, active: Recording | undefined, enabling = false, message = '', connectionError = '', pollTimer: ReturnType<typeof setTimeout> | undefined
  const request = async (path: string, body?: BodyInit, own?: AbortSignal): Promise<any> => {
    const response = await fetch(path, { ...(body !== undefined ? { method: 'POST', body } : {}), cache: 'no-store', signal: AbortSignal.any([signal, ...(own ? [own] : []), AbortSignal.timeout(10_000)]) })
    const data = await response.json(); signal.throwIfAborted()
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
    return data
  }
  const local = (id: string, stage: CommandEvent['stage'], error?: string) => {
    document.dispatchEvent(new CustomEvent('ra2c-voice-event', { detail: { commandId: id, source: 'voice', stage, seq: 0, at: Date.now(), ...(error ? { error } : {}) } satisfies CommandEvent }))
  }
  const render = () => {
    if (signal.aborted) return
    const enabled = !!microphone || enabling
    composer.dataset.inputMode = enabled ? 'voice' : 'text'
    input.hidden = input.disabled = enabled
    send.hidden = send.disabled = enabled
    hold.hidden = !enabled
    enable.disabled = enabling
    const switchLabel = enabling ? '等待麦克风授权' : enabled ? '关闭麦克风' : '启用麦克风'
    enable.setAttribute('aria-label', switchLabel); enable.title = switchLabel
    enable.setAttribute('aria-pressed', String(enabled)); enable.setAttribute('aria-busy', String(enabling))
    hold.disabled = !microphone || memory.view?.engine.state !== 'ready'
    const recording = !!active && !active.released
    hold.classList.toggle('recording', recording); hold.setAttribute('aria-pressed', String(recording))
    const label = key.querySelector<HTMLOptionElement>(`option[value="${memory.view?.key || 'Backquote'}"]`)?.textContent || '录音键'
    const shortcut = !memory.view?.key || memory.view.key === 'Backquote' ? '`' : label
    hold.setAttribute('aria-label', recording ? '正在录音，松开下令' : '按住说话')
    hold.title = recording ? '正在录音，松开下令；Esc 取消' : `按住说话（${label}），松开下令`
    const warning = message || connectionError || memory.view?.engine.error || ''
    const speechState = warning ? 'error' : active ? 'recording' : jobs.size ? 'transcribing' : memory.view?.engine.state === 'loading' ? 'loading' : 'ready'
    const speechText = warning || (active ? '正在录音，松开下令' : jobs.size ? jobs.size === 1 ? '正在识别…' : `正在识别 ${jobs.size} 条语音…`
      : speechState === 'loading' ? '正在加载本地识别器…' : `按住右侧按钮或${shortcut}说话`)
    composer.dataset.voiceState = speechState
    status.textContent = enabled ? speechText : warning
    status.hidden = !enabled
    // 关闭麦克风时保留可编辑文字及草稿，异常在占位提示与悬停说明中呈现。
    input.placeholder = warning || textPlaceholder
    field.title = enabled ? speechText : warning
  }
  const cancel = (id: string, reason: string) => {
    const job = jobs.get(id)
    if (!job) return
    if (active?.id === id) { clearTimeout(active.timer); active = undefined; microphone?.cancel() }
    job.abort(); jobs.delete(id); local(id, 'cancelled', reason)
    // 不复用正在取消的请求信号，确保迟到 start/audio 在宿主也被取消。
    void fetch(`/commander/voice/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }), keepalive: true, signal: AbortSignal.timeout(5000) }).catch(() => {})
    render()
  }
  const cancelAll = (reason: string) => { for (const id of [...jobs.keys()]) cancel(id, reason) }
  const disable = (reason: string) => { cancelAll(reason); microphone?.close(); microphone = undefined; field.style.setProperty('--voice-level', '0%'); render() }
  const devices = async () => {
    const available = await navigator.mediaDevices?.enumerateDevices() ?? []
    if (signal.aborted) return
    const selected = device.value || memory.draft?.deviceId || memory.view?.deviceId || ''
    device.replaceChildren(new Option('系统默认麦克风', ''))
    for (const item of available.filter(item => item.kind === 'audioinput' && item.deviceId)) device.append(new Option(item.label || `麦克风 ${device.options.length}`, item.deviceId))
    if (selected && ![...device.options].some(option => option.value === selected)) device.append(new Option('已保存的麦克风（当前不可用）', selected))
    device.value = selected
  }
  const fill = () => {
    const value = memory.dirty ? memory.draft : memory.view
    if (!value) return
    device.value = value.deviceId; key.value = value.key
  }
  const load = async () => {
    clearTimeout(pollTimer)
    try {
      memory.view = await request('/commander/speech') as SpeechSettingsView
      connectionError = ''
      await devices(); if (signal.aborted) return
      fill(); settingsStatus.textContent = memory.view.warning || memory.view.engine.error || (memory.view.engine.state === 'ready' ? '本地识别已就绪' : '正在加载本地识别器…')
      if (memory.view.engine.state === 'loading') pollTimer = setTimeout(() => { void load() }, 800)
      render()
    } catch (error) { if (!signal.aborted) { settingsStatus.textContent = `语音模块连接失败：${String(error)}`; connectionError = '语音模块暂时不可用'; render() } }
  }
  const begin = (kind: Recording['kind']) => {
    if (active || !microphone || memory.view?.engine.state !== 'ready' || signal.aborted) return
    const id = `cmd-${crypto.randomUUID()}`, job = new AbortController()
    jobs.set(id, job); message = ''; local(id, 'recording')
    const recording: Recording = { id, kind, released: false, ready: Promise.resolve(), timer: setTimeout(() => cancel(id, '录音达到 30 秒，已取消，请分句下令'), 30_000) }
    active = recording; render()
    recording.ready = Promise.all([request(`/commander/voice/${id}/start`, '{}', job.signal), microphone.start(id, job.signal)]).then(() => {})
    void recording.ready.catch(error => {
      if (signal.aborted || job.signal.aborted) return
      cancel(id, '录音未能开始'); local(id, 'failed', String(error)); message = String(error); render()
    })
  }
  const release = async (kind: Recording['kind']) => {
    const recording = active
    if (!recording || recording.kind !== kind || recording.released) return
    recording.released = true; clearTimeout(recording.timer)
    const job = jobs.get(recording.id)!
    try {
      await recording.ready
      if (job.signal.aborted || signal.aborted) return
      const bytes = await microphone!.stop()
      if (job.signal.aborted || signal.aborted) return
      active = undefined; local(recording.id, 'transcribing'); render()
      await request(`/commander/voice/${recording.id}/audio`, bytes, job.signal)
    } catch (error) {
      if (signal.aborted || job.signal.aborted) return
      cancel(recording.id, '录音提交未确认，已取消'); local(recording.id, 'failed', String(error)); message = String(error); render()
    }
  }
  const activate = async () => {
    if (enabling || microphone || signal.aborted) return
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) { memory.enabled = false; message = '当前浏览器不支持麦克风采集'; render(); return }
    enabling = true; message = ''; render()
    const capture = new MicrophoneCapture(value => { if (!signal.aborted) field.style.setProperty('--voice-level', `${Math.round(Math.max(0, Math.min(1, value / 0.25)) * 100)}%`) }, () => { memory.enabled = false; message = '麦克风已断开，请重新启用'; disable('麦克风已断开，取消未提交语音') })
    try {
      await capture.enable(memory.view?.deviceId || '', signal)
      if (signal.aborted) { capture.close(); return }
      microphone = capture; memory.enabled = true; await devices()
    } catch (error) {
      if (!signal.aborted) {
        memory.enabled = false
        message = error instanceof DOMException && error.name === 'NotAllowedError' ? '麦克风权限被拒绝，请允许后重新启用'
          : error instanceof DOMException && ['NotFoundError', 'OverconstrainedError'].includes(error.name) ? '找不到所选麦克风，请在设置中重新选择' : `麦克风启用失败：${String(error)}`
      }
    } finally { enabling = false; render() }
  }
  enable.addEventListener('click', () => {
    if (enabling) return
    if (microphone) { memory.enabled = false; message = ''; disable('麦克风已关闭，取消未提交语音'); return }
    void activate()
  }, { signal })
  hold.addEventListener('pointerdown', event => { if (event.button !== 0 || hold.disabled) return; event.preventDefault(); hold.setPointerCapture(event.pointerId); begin('pointer') }, { signal })
  hold.addEventListener('pointerup', () => { void release('pointer') }, { signal })
  hold.addEventListener('pointercancel', () => cancelAll('触控操作中断，已取消语音'), { signal })
  hold.addEventListener('lostpointercapture', () => { if (active?.kind === 'pointer' && !active.released) cancel(active.id, '按住操作中断，已取消语音') }, { signal })

  const editing = (event: KeyboardEvent) => !!(event.target as Element | null)?.closest?.('input, textarea, select, [contenteditable="true"]')
  const down = (event: KeyboardEvent) => {
    if (event.code === 'Escape' && jobs.size) { event.preventDefault(); event.stopImmediatePropagation(); cancelAll('已按 Esc 取消语音'); return }
    if (event.code !== memory.view?.key || !microphone || hold.disabled || editing(event) || event.isComposing || event.metaKey || event.shiftKey
      || event.ctrlKey && event.code !== 'ControlRight' || event.altKey && event.code !== 'AltRight') return
    event.preventDefault(); event.stopImmediatePropagation()
    if (!event.repeat) begin('key')
  }
  const up = (event: KeyboardEvent) => {
    if (event.code !== memory.view?.key || !microphone || editing(event) && !active) return
    event.preventDefault(); event.stopImmediatePropagation(); void release('key')
  }
  window.addEventListener('keydown', down, { signal, capture: true }); window.addEventListener('keyup', up, { signal, capture: true })
  const frame = document.querySelector<HTMLIFrameElement>('#ra2c-game')!
  let frameLifetime: AbortController | undefined
  const attachFrame = () => {
    frameLifetime?.abort(); frameLifetime = new AbortController()
    try {
      const child = frame.contentWindow!
      child.addEventListener('keydown', down, { signal: frameLifetime.signal, capture: true })
      child.addEventListener('keyup', up, { signal: frameLifetime.signal, capture: true })
    } catch { message = '无法连接游戏内录音键，请使用侧栏按住说话'; render() }
  }
  frame.addEventListener('load', attachFrame, { signal }); attachFrame()
  window.addEventListener('blur', () => { queueMicrotask(() => { if (!signal.aborted && !document.hasFocus()) cancelAll('窗口失焦，已取消语音') }) }, { signal })
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAll('窗口已隐藏，取消语音') }, { signal })
  window.addEventListener('pagehide', () => disable('页面已离开，取消语音'), { signal })
  navigator.mediaDevices?.addEventListener('devicechange', () => { void devices().catch(() => {}) }, { signal })
  document.addEventListener('ra2c-command-event', event => {
    const command = (event as CustomEvent<CommandEvent>).detail
    if (command.source !== 'voice' || !jobs.has(command.commandId)) return
    if (!['recording', 'transcribing'].includes(command.stage)) {
      jobs.delete(command.commandId)
      if (['failed', 'cancelled'].includes(command.stage) && active?.id === command.commandId) { clearTimeout(active.timer); active = undefined; microphone?.cancel() }
      if (command.stage === 'failed') { message = command.error || '语音识别失败，请重试'; void load() }
    }
    render()
  }, { signal })
  const draft = () => {
    memory.dirty = true; memory.draft = { revision: memory.view?.revision ?? 0, deviceId: device.value, key: key.value as SpeechSettingsInput['key'] }
  }
  form.addEventListener('input', draft, { signal }); form.addEventListener('change', draft, { signal })
  form.addEventListener('submit', async event => {
    event.preventDefault(); draft(); memory.enabled = false; disable('语音设置正在更改，取消未提交语音')
    try {
      memory.view = await request('/commander/speech', JSON.stringify({ ...memory.draft, revision: memory.view?.revision ?? 0 }))
      if (signal.aborted) return
      memory.dirty = false; delete memory.draft; message = ''; fill(); settingsStatus.textContent = '语音设置已保存，请重新启用麦克风'; render()
      if (memory.view?.engine.state === 'loading') pollTimer = setTimeout(() => { void load() }, 800)
    } catch (error) { if (!signal.aborted) settingsStatus.textContent = String(error) }
  }, { signal })
  reload.addEventListener('click', async () => {
    memory.enabled = false; disable('识别器正在重载，取消未提交语音'); reload.disabled = true
    try { await request('/commander/speech/reload', '{}'); message = ''; await load() }
    catch (error) { if (!signal.aborted) settingsStatus.textContent = String(error) }
    finally { if (!signal.aborted) reload.disabled = false }
  }, { signal })
  fill(); render()
  void load().then(() => { if (memory.enabled && !signal.aborted) void activate() })
  return { show: () => { void load() }, dispose: () => {
    if (signal.aborted) return
    disable('侧栏重新连接，取消未提交语音'); lifetime.abort(); frameLifetime?.abort(); clearTimeout(pollTimer)
  } }
}
