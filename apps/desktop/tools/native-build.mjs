import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dirname, '../../..'), target = process.argv[2]
const platform = { mac: 'darwin', win: 'win32' }[target]
if (!platform || process.platform !== platform || !['arm64', 'x64'].includes(process.arch) || process.argv.length !== 3) {
  throw new Error(`请在目标系统本机运行 pnpm dist:${target}（支持 x64/arm64），本机为 ${process.platform}/${process.arch}；Linux 使用 pnpm dist:linux`)
}
const cli = process.env.npm_execpath
if (!cli) throw new Error('请通过 pnpm dist:mac 或 pnpm dist:win 启动构建')
function run(executable, args, env = process.env) {
  const result = spawnSync(executable, args, { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`构建步骤失败，退出码 ${result.status}: ${args.join(' ')}`)
}
const pnpm = args => run(process.execPath, [cli, ...args])
pnpm(['typecheck'])
pnpm(['build'])
const builder = ['exec', 'electron-builder', '--config', 'apps/desktop/electron-builder.cjs']
// 先检查未压缩的真实程序，通过后再产生可分发归档。
pnpm([...builder, `--${target}`, `--${process.arch}`, '--dir', '--publish', 'never'])
const folder = target === 'mac' ? join(root, `dist/mac${process.arch === 'arm64' ? '-arm64' : ''}/ra2commander.app`) : join(root, `dist/win${process.arch === 'arm64' ? '-arm64' : ''}-unpacked`)
const temporary = mkdtempSync(join(tmpdir(), 'ra2c package ')), isolated = join(temporary, basename(folder))
try {
  // 移出工程树检查，不能靠开发目录的 node_modules 偶然补齐发行依赖。
  cpSync(folder, isolated, { recursive: true, verbatimSymlinks: true })
  const executable = target === 'mac' ? join(isolated, 'Contents/MacOS', readdirSync(join(isolated, 'Contents/MacOS'))[0]) : join(isolated, 'ra2commander.exe')
  run(executable, [join(root, 'apps/desktop/tools/check-package.mjs'), isolated], { ...process.env, ELECTRON_RUN_AS_NODE: '1', RA2C_PACKAGED: '1' })
} finally { rmSync(temporary, { recursive: true, force: true }) }
pnpm([...builder, '--prepackaged', folder, `--${target}`, `--${process.arch}`, '--publish', 'never'])
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const artifacts = [`RA2Commander-${version}-${target === 'mac' ? 'mac' : 'windows'}-${process.arch}.zip`]
if (target === 'mac') run(process.execPath, [join(root, 'apps/desktop/tools/verify-mac.mjs'), folder, ...artifacts.map(file => join(root, 'dist', file))])
const checksumFile = join(root, 'dist/SHA256SUMS')
const lines = existsSync(checksumFile) ? readFileSync(checksumFile, 'utf8').split('\n').filter(line => line && !artifacts.some(file => line.endsWith(`  ${file}`))) : []
for (const file of artifacts) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(join(root, 'dist', file))) hash.update(bytes)
  lines.push(`${hash.digest('hex')}  ${file}`)
}
writeFileSync(checksumFile, lines.sort().join('\n') + '\n')
// 受限沙箱可能把构建产物标成低完整性，Electron 从这种目录启动会崩溃；校验和不受标签影响。
if (target === 'win') {
  const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')
  const result = spawnSync(icacls, [join(root, 'dist'), '/setintegritylevel', 'Medium', '/T'], { stdio: 'ignore' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`构建产物完整性级别重置失败，退出码 ${result.status}`)
  console.log('已将 dist 的完整性级别重置为 Medium')
}
console.log(`构建完成：${artifacts.join('、')}（dist/）`)
