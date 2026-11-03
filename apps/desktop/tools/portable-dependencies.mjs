import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** pnpm 9 deploy 的 hoisted 布局不完整；在独立工作区按原锁文件安装，不改开发目录。 */
export function portableDependencies(root, deploy, runtime, pnpm) {
  mkdirSync(deploy, { recursive: true })
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) cpSync(join(root, file), join(deploy, file))
  for (const group of ['apps', 'packages']) for (const name of readdirSync(join(root, group))) {
    const manifest = join(root, group, name, 'package.json')
    if (!existsSync(manifest)) continue
    const target = join(deploy, group, name); mkdirSync(target, { recursive: true })
    cpSync(manifest, join(target, 'package.json'))
  }
  pnpm(['install', '--prod', '--frozen-lockfile', '--prefer-offline', '--node-linker=hoisted'], deploy)
  const modules = join(deploy, 'node_modules')
  cpSync(modules, join(runtime, 'node_modules'), { recursive: true, filter: file => {
    // 工作区别名随后用 ESM 转发文件代替；发行包不携带机器相关的 Windows junction。
    if (file === join(modules, '@ra2c') || file === join(modules, '.pnpm') || file === join(modules, '.modules.yaml') || file.endsWith('/.bin') || file.endsWith('\\.bin')) return false
    if (lstatSync(file).isSymbolicLink()) throw new Error(`桌面生产依赖仍含链接：${file}`)
    return true
  } })
}
