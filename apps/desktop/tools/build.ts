import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { buildWorkbench, workbenchBuildVersion } from '../../companion/src/workbench.ts'
import { prepareGameResources, prepareGameSite } from '../../../packages/game-werhd/src/index.ts'
import { prepareSpeechModel } from '../../../packages/speech/src/index.ts'
// @ts-expect-error 构建工具共用原生 ESM 入口。
import { portableDependencies } from './portable-dependencies.mjs'

const root = resolve(import.meta.dirname, '../../..'), stage = join(root, 'dist/stage'), runtime = join(stage, 'runtime')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
await prepareGameResources(root, { progress: console.log })
await prepareGameSite(root, process.env.RA2C_GAME_DIR)
await prepareSpeechModel(root, { progress: console.log })
rmSync(stage, { recursive: true, force: true }); mkdirSync(runtime, { recursive: true })

// pnpm 按现有 lockfile 部署生产闭包，所有链接最终留在安装资源内部。
const deploy = join(root, 'dist/dependencies')
rmSync(deploy, { recursive: true, force: true })
function pnpm(args: string[], cwd = root) {
  const cli = process.env.npm_execpath
  if (cli) execFileSync(process.execPath, [cli, ...args], { cwd, stdio: 'inherit' })
  else if (process.platform !== 'win32') execFileSync('pnpm', args, { cwd, stdio: 'inherit' })
  else throw new Error('Windows 请通过 pnpm build 或 pnpm dist:win 启动构建')
}
if (process.platform !== 'linux') portableDependencies(root, deploy, runtime, pnpm)
else pnpm(['--filter', '@ra2c/companion', 'deploy', '--prod', '--frozen-lockfile', '--prefer-offline', deploy])
// pnpm 9 deploy 对本地工作区包仍会查询范围元数据；拒绝引入锁定安装之外的新版本。
function dependencyVersions(store: string): Set<string> {
  const versions = new Set<string>()
  for (const entry of readdirSync(store).filter(name => !name.startsWith('@ra2c+') && name !== 'node_modules')) {
    const modules = join(store, entry, 'node_modules')
    if (!existsSync(modules)) continue
    for (const name of readdirSync(modules)) {
      const folder = join(modules, name)
      const candidates = name.startsWith('@') ? readdirSync(folder).map(child => join(folder, child)) : [folder]
      for (const candidate of candidates) {
        const manifest = join(candidate, 'package.json')
        if (!existsSync(manifest)) continue
        const value = JSON.parse(readFileSync(manifest, 'utf8'))
        if (!value.name.startsWith('@ra2c/')) versions.add(`${value.name}@${value.version}`)
      }
    }
  }
  return versions
}
if (process.platform === 'linux') {
  const locked = dependencyVersions(join(root, 'node_modules/.pnpm'))
  for (const version of dependencyVersions(join(deploy, 'node_modules/.pnpm'))) {
    if (!locked.has(version)) throw new Error(`生产部署引入未锁定版本：${version}；请先核对 lockfile`)
  }
  cpSync(join(deploy, 'node_modules'), join(runtime, 'node_modules'), { recursive: true, verbatimSymlinks: true })
}

function compileTree(source: string, target: string) {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const input = join(source, entry.name), output = join(target, entry.name)
    if (entry.isDirectory()) { compileTree(input, output); continue }
    if (entry.name.endsWith('.d.ts')) continue
    if (entry.name.endsWith('.ts')) {
      const result = transpileModule(readFileSync(input, 'utf8'), { fileName: input,
        compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext, rewriteRelativeImportExtensions: true } })
      writeFileSync(output.replace(/\.ts$/, '.js'), result.outputText)
    } else if (/\.(?:mjs|js|json)$/.test(entry.name)) cpSync(input, output)
  }
}
for (const name of ['companion', 'desktop']) compileTree(join(root, 'apps', name, 'src'), join(runtime, 'apps', name, 'src'))
const packages = readdirSync(join(root, 'packages')).filter(name => existsSync(join(root, 'packages', name, 'package.json')))
for (const name of packages) {
  const source = join(root, 'packages', name), target = join(runtime, 'packages', name)
  compileTree(join(source, 'src'), join(target, 'src'))
  for (const file of readdirSync(source).filter(file => file.endsWith('.json'))) {
    const data = readFileSync(join(source, file), 'utf8')
    writeFileSync(join(target, file), file === 'package.json' ? data.replace(/\.ts"/g, '.js"') : data)
  }
  if (process.platform !== 'linux') {
    const alias = join(runtime, 'node_modules/@ra2c', name); mkdirSync(alias, { recursive: true })
    writeFileSync(join(alias, 'package.json'), JSON.stringify({ name: `@ra2c/${name}`, type: 'module', exports: './index.js' }))
    // 转发到唯一实现，避免复制工作区包造成两份模块状态，也不要求 Windows 开发者模式。
    writeFileSync(join(alias, 'index.js'), `export * from '../../../packages/${name}/src/index.js';\n`)
    continue
  }
  symlinkSync('../../node_modules/.pnpm/node_modules', join(target, 'node_modules'), 'dir')
  for (const base of [join(runtime, 'node_modules/@ra2c'), join(runtime, 'node_modules/.pnpm/node_modules/@ra2c')]) {
    mkdirSync(base, { recursive: true }); const link = join(base, name)
    rmSync(link, { force: true, recursive: true }); symlinkSync(relative(base, target), link, 'dir')
  }
}
if (process.platform === 'linux') for (const name of readdirSync(join(runtime, 'node_modules/.pnpm')).filter(name => name.startsWith('@ra2c+'))) rmSync(join(runtime, 'node_modules/.pnpm', name), { recursive: true, force: true })
// deploy 的根包自引用不是运行时依赖，入口直接位于 apps/companion/src。
rmSync(join(runtime, 'node_modules/.pnpm/node_modules/@ra2c/companion'), { force: true })
for (const name of ['prompts', 'skills', 'maps']) cpSync(join(root, name), join(runtime, name), {
  recursive: true, filter: file => !/\.(?:png|jpg|jpeg|py|pyc)$/.test(file) && !file.includes('__pycache__'),
})
for (const name of ['resources/game', 'resources/game-site', 'resources/speech/models']) cpSync(join(root, name), join(runtime, name), { recursive: true })
const ui = join(runtime, 'apps/companion/ui'); mkdirSync(ui, { recursive: true })
const files = buildWorkbench(root), names = new Set<string>()
for (const [path, file] of Object.entries(files)) {
  const name = path.slice('/commander/'.length) || 'index.html'
  names.add(name); cpSync(file, join(ui, name))
}
writeFileSync(join(ui, 'built.json'), JSON.stringify({ version: workbenchBuildVersion(), files: [...names] }))
cpSync(join(root, 'LICENSE'), join(runtime, 'LICENSE'))
writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: 'ra2commander-runtime', version: pkg.version, type: 'module' }))
writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'ra2commander', version: pkg.version, type: 'module',
  productName: 'RA2Commander', desktopName: 'ra2commander', description: pkg.description, main: 'main.mjs', author: 'RA2Commander contributors', license: 'MIT' }))
writeFileSync(join(stage, 'main.mjs'), `import { pathToFileURL } from 'node:url';\nimport { join } from 'node:path';\nawait import(pathToFileURL(join(process.resourcesPath, 'runtime/apps/desktop/src/main.mjs')).href);\n`)
writeFileSync(join(stage, 'build-info.json'), JSON.stringify({ version: pkg.version, platform: process.platform, arch: process.arch, builtAt: new Date().toISOString() }))
rmSync(deploy, { recursive: true, force: true })
console.log(`正式运行目录已生成：${runtime}`)
