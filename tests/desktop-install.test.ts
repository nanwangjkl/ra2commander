import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// @ts-expect-error 安装入口为 Electron 原生 ESM，同一实现由 Node 检查。
import { installLinux, uninstallLinux } from '../apps/desktop/src/install.mjs'

test('用户级安装与升级创建稳定入口，卸载保留设置和记录，拒绝覆盖其他目录', () => {
  const folder = mkdtempSync(join(tmpdir(), 'ra2c install ')), home = join(folder, 'player home'), dataHome = join(home, '.local/share')
  mkdirSync(home); const appImage = join(folder, 'source.AppImage'), icon = join(folder, 'icon.png')
  writeFileSync(appImage, 'version-one'); writeFileSync(icon, 'icon')
  const userData = join(dataHome, 'ra2commander/.runtime'); mkdirSync(userData, { recursive: true }); writeFileSync(join(userData, 'settings.json'), 'keep')
  const options = { home, dataHome, appImage, icon, executable: '/unused', version: '0.1.0' }
  try {
    const first = installLinux(options)
    assert.equal(readFileSync(first.entry, 'utf8'), 'version-one')
    assert.ok(readFileSync(first.desktop, 'utf8').includes(`Exec="${first.entry}"`))
    writeFileSync(appImage, 'version-two'); const second = installLinux({ ...options, version: '0.1.1' })
    assert.equal(second.entry, first.entry); assert.equal(readFileSync(second.entry, 'utf8'), 'version-two')
    uninstallLinux(options)
    assert.equal(existsSync(first.target), false); assert.equal(existsSync(first.desktop), false)
    assert.equal(readFileSync(join(userData, 'settings.json'), 'utf8'), 'keep')
    mkdirSync(first.target); writeFileSync(join(first.target, 'other-file'), 'owned by player')
    assert.throws(() => installLinux(options), /已有其他内容/)
    assert.equal(readFileSync(join(first.target, 'other-file'), 'utf8'), 'owned by player')
  } finally { rmSync(folder, { recursive: true, force: true }) }
})
