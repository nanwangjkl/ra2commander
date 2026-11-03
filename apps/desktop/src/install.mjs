import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const id = 'io.ra2commander.desktop'
const marker = '.ra2commander-install.json'
function owned(target) {
  if (lstatSync(target).isSymbolicLink()) throw new Error('安装目录不能是符号链接')
  try { if (JSON.parse(readFileSync(join(target, marker), 'utf8')).id === id) return } catch {}
  throw new Error(`目录已有其他内容，未修改：${target}`)
}
const quote = value => `"${value.replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%')}"`

/** 用户级安装：只替换自己拥有的程序目录，不读取或移动用户数据。 */
export function installLinux({ home, dataHome, executable, appImage, icon, version }) {
  const applications = join(home, 'Applications'), target = join(applications, 'RA2Commander')
  const desktop = join(dataHome, 'applications/ra2commander.desktop')
  mkdirSync(applications, { recursive: true })
  if (existsSync(target)) owned(target)
  const scratch = mkdtempSync(join(applications, '.ra2c-install-'))
  let backup
  try {
    let entry
    if (appImage) { entry = 'RA2Commander.AppImage'; cpSync(appImage, join(scratch, entry)); chmodSync(join(scratch, entry), 0o755) }
    else {
      if (!['ra2commander', 'ra2commander.bin'].includes(basename(executable)) || !existsSync(join(dirname(executable), 'resources/app.asar'))) throw new Error('未找到正式 Linux 程序目录')
      cpSync(dirname(executable), scratch, { recursive: true, verbatimSymlinks: true }); entry = 'ra2commander'
    }
    cpSync(icon, join(scratch, 'icon.png'))
    writeFileSync(join(scratch, marker), JSON.stringify({ id, version, entry }))
    if (existsSync(target)) { backup = mkdtempSync(join(applications, '.ra2c-previous-')); renameSync(target, join(backup, 'app')) }
    renameSync(scratch, target)
    try {
      mkdirSync(dirname(desktop), { recursive: true })
      writeFileSync(`${desktop}.tmp`, `[Desktop Entry]\nType=Application\nName=RA2Commander\nComment=红警语音指挥\nExec=${quote(join(target, entry))}\nIcon=${join(target, 'icon.png')}\nTerminal=false\nCategories=Game;\nStartupWMClass=ra2commander\n`)
      renameSync(`${desktop}.tmp`, desktop)
    } catch (error) {
      rmSync(target, { recursive: true, force: true })
      if (backup) renameSync(join(backup, 'app'), target)
      throw error
    }
    return { target, entry: join(target, entry), desktop }
  } catch (error) {
    if (backup && existsSync(join(backup, 'app')) && !existsSync(target)) renameSync(join(backup, 'app'), target)
    throw error
  } finally { rmSync(scratch, { recursive: true, force: true }); if (backup) rmSync(backup, { recursive: true, force: true }) }
}
export function uninstallLinux({ home, dataHome }) {
  const target = join(home, 'Applications/RA2Commander')
  if (existsSync(target)) { owned(target); rmSync(target, { recursive: true, force: true }) }
  rmSync(join(dataHome, 'applications/ra2commander.desktop'), { force: true })
}
