import { app, BrowserWindow, dialog, Menu, screen } from 'electron'
import { fork } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { installLinux, uninstallLinux } from './install.mjs'
import { windowSize } from './window-options.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const packaged = app.isPackaged || process.env.RA2C_PACKAGED === '1'
const dataHome = process.platform === 'linux' ? process.env.XDG_DATA_HOME || join(app.getPath('home'), '.local/share') : app.getPath('appData')
const dataRoot = resolve(process.env.RA2C_DATA_ROOT || (packaged ? join(dataHome, 'ra2commander') : root))
const profile = join(dataRoot, '.runtime/desktop-profile')
const debugPort = Number(process.env.RA2C_CDP_PORT || await new Promise((resolve, reject) => {
  const server = createServer(); server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(error => error ? reject(error) : resolve(port)) })
}))
if (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535) throw new Error('客户端连接端口无效')

app.setName('RA2Commander')
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
app.commandLine.appendSwitch('remote-debugging-port', String(debugPort))

let window, host, origin = '', readyTimer, quitting = false, stopped = false, showingError = false

console.log('[desktop] 正在启动独立窗口')
const installMode = process.argv.find(value => ['--install', '--uninstall'].includes(value))
if (!app.requestSingleInstanceLock()) { console.log(installMode ? '[desktop] 请先关闭正在运行的 RA2Commander 再安装或卸载' : '[desktop] 已有客户端实例，激活原窗口'); app.exit(installMode ? 1 : 0) }
else if (installMode) {
  void app.whenReady().then(() => {
    if (!packaged || process.platform !== 'linux') throw new Error('安装命令仅用于正式 Linux 分发包')
    const options = { home: app.getPath('home'), dataHome: process.env.XDG_DATA_HOME || join(app.getPath('home'), '.local/share') }
    if (installMode === '--uninstall') { uninstallLinux(options); console.log('RA2Commander 已卸载，用户设置和对局记录保留') }
    else {
      const result = installLinux({ ...options, executable: process.execPath, appImage: process.env.APPIMAGE,
        icon: join(root, 'resources/game-site/res/pwa/icon-512.png'), version: app.getVersion() })
      console.log(`RA2Commander 已安装：${result.entry}\n可在应用菜单中打开，或将此程序添加为 Steam 非 Steam 游戏。`)
    }
    app.exit(0)
  }).catch(error => { console.error(String(error)); app.exit(1) })
}
else {
  app.on('second-instance', () => { if (window && !window.isDestroyed() && process.env.RA2C_DESKTOP_HIDDEN !== '1') { if (window.isMinimized()) window.restore(); window.show(); window.focus() } })
  app.on('before-quit', event => {
    if (stopped) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    void stopHost().finally(() => {
      stopped = true
      // 记录和工作进程已清理；游戏页面的 beforeunload 不能再次否决应用退出。
      if (window && !window.isDestroyed()) window.destroy()
      app.quit()
    })
  })
  process.on('SIGINT', () => app.quit())
  process.on('SIGTERM', () => app.quit())
  // ESM 入口必须先完成求值，再由 ready 创建窗口，避免顶层等待 ready 自身。
  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
      { label: app.name, submenu: [{ role: 'quit', label: '退出 RA2Commander' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    ]) : null)
    const area = screen.getPrimaryDisplay().workAreaSize
    const dmi = name => { try { return process.platform === 'linux' ? readFileSync(`/sys/class/dmi/id/${name}`, 'utf8') : '' } catch { return '' } }
    window = new BrowserWindow({
      title: 'RA2Commander', ...windowSize({ platform: process.platform, env: process.env, workArea: area, productName: dmi('product_name'), vendor: dmi('sys_vendor') }),
      minWidth: 960, minHeight: 600, show: false, backgroundColor: '#0c1015', autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    })
    const contents = window.webContents, session = contents.session
    const local = url => { try { return !!origin && new URL(url).origin === origin } catch { return false } }
    // 本机证书只对当前宿主源生效，不关闭整个浏览器的证书或同源检查。
    app.on('certificate-error', (event, webContents, url, _error, certificate, callback) => {
      let trusted = false
      try { trusted = webContents === contents && local(url)
        && new X509Certificate(certificate.data).fingerprint256 === new X509Certificate(readFileSync(join(dataRoot, '.runtime/certs/cert.pem'))).fingerprint256 }
      catch {}
      if (trusted) event.preventDefault()
      callback(trusted)
    })
    const normalPermission = permission => ['fullscreen', 'pointerLock', 'keyboardLock', 'clipboard-sanitized-write'].includes(permission)
    session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => webContents === contents && local(requestingOrigin)
      && (normalPermission(permission) || permission === 'media' && ['audio', 'unknown'].includes(details.mediaType)))
    session.setPermissionRequestHandler((webContents, permission, callback, details) => callback(webContents === contents && local(details.requestingUrl)
      && (normalPermission(permission) || permission === 'media' && details.mediaTypes?.length > 0 && details.mediaTypes.every(type => type === 'audio'))))
    // CDN 回包补头由窗口拥有，宿主断线期间仍能继续读取游戏资源。
    const cdnHosts = ['wangerhuoda.cn', 'bun.sh.cn', 'k0s.cn', 'ra2web.com', 'ra2web.github.io']
    session.webRequest.onHeadersReceived({ urls: ['https://*/*'] }, (details, callback) => {
      const hostname = new URL(details.url).hostname
      callback(cdnHosts.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
        ? { responseHeaders: { ...Object.fromEntries(Object.entries(details.responseHeaders ?? {}).filter(([name]) => name.toLowerCase() !== 'access-control-allow-origin')), 'Access-Control-Allow-Origin': ['*'] } } : {})
    })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => { if (!local(url)) event.preventDefault() })
    contents.on('page-title-updated', event => event.preventDefault())
    contents.on('did-finish-load', () => { if (local(contents.getURL()) && !quitting && process.env.RA2C_DESKTOP_HIDDEN !== '1') window.show() })
    window.on('close', event => { if (!stopped) { event.preventDefault(); app.quit() } })
    app.on('window-all-closed', () => app.quit())
    await window.loadURL('about:blank')
    startHost()
  }).catch(error => {
    console.error(`[desktop] 窗口启动失败：${String(error)}`)
    if (process.env.RA2C_DESKTOP_HIDDEN !== '1') dialog.showErrorBox('客户端启动失败', String(error))
    app.quit()
  })
}

function startHost() {
  if (quitting || host) return
  let diagnostic = '', handled = false
  const child = host = fork(join(root, `apps/companion/src/main.${packaged ? 'js' : 'ts'}`), [], {
    execPath: process.execPath, execArgv: packaged ? [] : ['--import', 'tsx'], cwd: packaged ? dataRoot : root,
    env: { ...process.env, ...(packaged ? { RA2C_PACKAGED: '1' } : {}), ELECTRON_RUN_AS_NODE: '1', RA2C_BROWSER: 'electron', RA2C_DATA_ROOT: dataRoot, RA2C_CDP_PORT: String(debugPort) },
    stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
  })
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-2400); process.stderr.write(bytes) })
  child.on('message', message => {
    if (host !== child || quitting) return
    if (message?.type === 'ra2c-listening') {
      const url = new URL(message.url)
      if (url.protocol === 'https:' && url.hostname === '127.0.0.1') origin = url.origin
    }
    if (message?.type === 'ra2c-ready') { clearTimeout(readyTimer); console.log('[desktop] 指挥服务已就绪') }
  })
  const failed = async message => {
    if (handled || host !== child || quitting) return
    handled = true; clearTimeout(readyTimer)
    await stopHost()
    if (quitting || showingError) return
    if (process.env.RA2C_DESKTOP_HIDDEN === '1') { console.error(`[desktop] ${message}\n${diagnostic}`); app.exit(1); return }
    showingError = true
    try {
      const { response } = await dialog.showMessageBox(window, { type: 'error', title: '指挥服务未连接', message,
        detail: diagnostic.trim().slice(-1200) || '可以重试连接；窗口内已有对局不会重新加载。', buttons: ['重试连接', '退出'], defaultId: 0, cancelId: 1 })
      if (response === 0 && !quitting) startHost()
      else app.quit()
    } finally { showingError = false }
  }
  child.on('error', error => { void failed(`指挥服务无法启动：${error.message}`) })
  child.on('exit', (code, signal) => {
    if (host !== child || quitting) return
    if (code === 0) { host = undefined; clearTimeout(readyTimer); app.quit() }
    else void failed(`指挥服务已退出（${signal || code}）`)
  })
  readyTimer = setTimeout(() => { void failed('指挥服务启动超时') }, 90_000)
}

async function stopHost() {
  clearTimeout(readyTimer)
  const child = host
  host = undefined
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise(resolve => {
    const timer = setTimeout(() => { console.error('[desktop] 指挥服务退出超时，正在终止进程'); child.kill('SIGKILL') }, 8000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    if (child.connected) child.send({ type: 'ra2c-stop' }, error => { if (error) child.kill() })
    else child.kill()
  })
}
