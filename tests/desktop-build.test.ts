import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error Electron 主进程共用的原生 ESM。
import { windowSize } from '../apps/desktop/src/window-options.mjs'
// @ts-expect-error 原生构建入口。
import { portableDependencies } from '../apps/desktop/tools/portable-dependencies.mjs'

test('桌面使用默认工作区窗口，只有 Linux Steam Deck 使用固定尺寸', () => {
  const workArea = { width: 1920, height: 1080 }
  for (const platform of ['darwin', 'win32', 'linux']) assert.deepEqual(windowSize({ platform, env: {}, workArea }), { width: 1480, height: 960 })
  assert.deepEqual(windowSize({ platform: 'win32', env: { SteamDeck: '1' }, workArea: { width: 1366, height: 768 } }), { width: 1366, height: 768 })
  for (const productName of ['Jupiter\n', 'Galileo\n']) assert.deepEqual(windowSize({ platform: 'linux', env: {}, vendor: 'Valve\n', productName, workArea: { width: 1280, height: 752 } }), { width: 1280, height: 800 })
  assert.deepEqual(windowSize({ platform: 'linux', env: { SteamDeck: '1' }, workArea }), { width: 1280, height: 800 })
  assert.deepEqual(windowSize({ platform: 'linux', env: { SteamGamepadUI: '1' }, workArea }), { width: 1480, height: 960 })
})

test('桌面生产依赖保留真实文件，排除工作区链接并拒绝残留外部链接', () => {
  const folder = mkdtempSync(join(tmpdir(), 'ra2c windows deps ')), root = join(folder, 'source'), deploy = join(folder, 'deploy'), runtime = join(folder, 'runtime')
  try {
    for (const path of ['apps/companion', 'packages/contracts']) mkdirSync(join(root, path), { recursive: true })
    for (const path of ['package.json', 'apps/companion/package.json', 'packages/contracts/package.json']) writeFileSync(join(root, path), '{}')
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'original-lock'); writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: [apps/*, packages/*]')
    const install = () => {
      const modules = join(deploy, 'node_modules'); mkdirSync(join(modules, 'library/nested'), { recursive: true })
      writeFileSync(join(modules, 'library/nested/file.js'), 'portable')
      mkdirSync(join(modules, '@ra2c'), { recursive: true })
      symlinkSync(join(deploy, 'packages/contracts'), join(modules, '@ra2c/contracts'), 'junction')
    }
    portableDependencies(root, deploy, runtime, install)
    assert.equal(readFileSync(join(runtime, 'node_modules/library/nested/file.js'), 'utf8'), 'portable')
    assert.equal(existsSync(join(runtime, 'node_modules/@ra2c')), false)
    assert.equal(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'), 'original-lock')
    symlinkSync(root, join(deploy, 'node_modules/library/outside'), 'junction')
    assert.throws(() => portableDependencies(root, deploy, runtime, () => {}), /仍含链接/)
  } finally { rmSync(folder, { recursive: true, force: true }) }
})
