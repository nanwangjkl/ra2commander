const path = require('node:path')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '../..')
module.exports = {
  appId: 'io.ra2commander.desktop', productName: 'RA2Commander', executableName: 'ra2commander',
  electronVersion: require('./package.json').devDependencies.electron,
  directories: { app: path.join(root, 'dist/stage'), output: path.join(root, 'dist') },
  files: ['main.mjs', 'package.json', 'build-info.json'],
  extraResources: [
    { from: path.join(root, 'dist/stage/runtime'), to: 'runtime' },
    // electron-builder 的普通文件复制会跳过根 node_modules，生产闭包须显式映射。
    { from: path.join(root, 'dist/stage/runtime/node_modules'), to: 'runtime/node_modules', filter: ['**/*'] },
  ],
  asar: true, npmRebuild: false,
  beforePack: async ({ electronPlatformName, arch }) => {
    const info = JSON.parse(fs.readFileSync(path.join(root, 'dist/stage/build-info.json'), 'utf8'))
    const targetArch = require('electron-builder').Arch[arch]
    if (info.platform !== electronPlatformName || info.arch !== targetArch) throw new Error(`运行目录为 ${info.platform}/${info.arch}，不能打包为 ${electronPlatformName}/${targetArch}；请在对应系统和架构运行构建命令`)
  },
  afterPack: async ({ appOutDir, electronPlatformName }) => {
    if (electronPlatformName !== 'linux') return
    const entry = path.join(appOutDir, 'ra2commander'), binary = `${entry}.bin`, launcher = `${entry}.launcher`
    execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-static', path.join(__dirname, 'linux/launcher.c'), '-o', launcher])
    if (!fs.existsSync(binary)) fs.renameSync(entry, binary)
    fs.renameSync(launcher, entry)
  },
  linux: { target: [{ target: 'AppImage', arch: ['x64'] }, { target: 'tar.gz', arch: ['x64'] }],
    extraFiles: [{ from: path.join(__dirname, 'linux'), to: '.', filter: ['*.sh'] }],
    category: 'Game', icon: path.join(root, 'resources/game-site/res/pwa/icon-512.png'),
    artifactName: 'RA2Commander-${version}-linux-x86_64.${ext}',
    syncDesktopName: true, desktop: { entry: { StartupWMClass: 'ra2commander', Keywords: 'Red Alert;RTS;Voice;' } },
  },
  mac: {
    target: ['zip'], category: 'public.app-category.games',
    icon: path.join(root, 'resources/game-site/res/pwa/icon-512.png'),
    artifactName: 'RA2Commander-${version}-mac-${arch}.${ext}',
    // 当前为本机分发：Apple Silicon 使用 ad-hoc 签名，不请求开发者证书或公证服务。
    identity: '-', hardenedRuntime: false,
    extendInfo: { NSMicrophoneUsageDescription: '使用麦克风识别你的语音指挥命令。' },
  },
  win: {
    target: ['zip'], icon: path.join(root, 'resources/game-site/res/pwa/icon-512.png'),
    artifactName: 'RA2Commander-${version}-windows-${arch}.${ext}',
  },
  publish: null,
}
