# Linux 分发

2026-11-02 用户批准 Linux x86_64 的 AppImage 与 tar.gz 分发，目标为 Steam Deck 的 SteamOS。此项属于客户端 3C；手柄录音键、小屏与休眠恢复仍按 3B 单独交付。构建和使用命令统一见 [AGENTS.md](../../AGENTS.md)。

## 程序与用户数据

安装资源包括 Electron、编译后的宿主与工作进程、预编译侧栏、独立生产依赖、提示词、Skill、分区、固定游戏站点、基础游戏资源、冰天雪地地图及本地语音模型。原生语音库采用 Linux x64 版本，保留所需动态库和许可文件。用户运行时无需 Node、pnpm、TypeScript 加载器、外部 Chromium、系统 OpenSSL 或另行下载模型。

正式入口从 `process.resourcesPath/runtime/` 读取资源，保持工作进程和 Markdown 的相对目录。生产依赖由 pnpm 按锁文件部署，内部工作区链接指向同一发行目录；electron-builder 显式复制生产依赖目录。大文件和原生库位于 ASAR 外，以支持原生文件读取与独立子进程。

默认用户数据根为 `${XDG_DATA_HOME:-~/.local/share}/ra2commander/`，其 `.runtime/` 中保存模型配置、语音偏好、对局、证书和 `desktop-profile/` 浏览器资料；开发入口继续使用项目 `.runtime/`，不自动迁移开发资料。`RA2C_DATA_ROOT` 可覆盖数据根。安装目录保持只读可用，重开与升级沿用用户资料。分发排除开发者 `.env`、Key、历史对局和 profile。

## 资源与首次使用

游戏静态站点采用 `packages/game-werhd/site-manifest.json` 的固定快照、大小及 SHA-256，只复制列出的当前版本资源。基础资源和语音模型继续使用原有清单，缺失或校验失败则停止构建；不将整个下载目录或 `.runtime/` 打包。

冰天雪地地图也固定大小与 SHA-256。游戏原地图加载器请求 `mp32s8.map` 时由本机提供；其他地图和线上服务沿用原来源，不把包称为全地图、全 MOD 离线版本。游戏单机所需基础资源和当前地图随包，云模型理解仍需用户配置和联网。

首次资源自动加载与默认音量、虚拟摇杆沿用[游戏资源](../assets/game-resources.md)和[预置设置](game-preferences.md)。本机 HTTPS 证书由应用依赖生成，每份用户资料独立保存私钥，私钥文件权限为 0600；浏览器只信任当前宿主的匹配证书。

## 安装、更新与卸载

AppImage 可直接运行；tar.gz 解压后运行 `ra2commander`，附 `install.sh`、`uninstall.sh`。正式程序也接受 `--install`、`--uninstall`，不会启动指挥宿主或打开游戏。

从 0.1.1 起，Linux 的 `ra2commander` 为静态链接启动器，先从 `LD_PRELOAD` 移除文件名为 `gameoverlayrenderer.so` 或 `gameoverlayrenderer64.so` 的 Steam 覆盖层，再原位执行同目录的 `ra2commander.bin`。其他预加载库、Steam 标识及命令行参数保留，不追加关闭沙箱或关闭 GPU 的参数。AppImage 的 AppRun 和解压版均使用同一入口；子进程继承清理后的环境。

此修正来自 Deck 实机反馈：同一次启动先出现覆盖层库内的 zygote SIGSEGV，约 86 秒后网络服务出现 SIGTRAP。第二份缺少 FATAL 正文，不能仅据地址断定独立原因。用户确认在 Steam 启动选项临时清空 `LD_PRELOAD` 后能正常打开；程序据此只排除已确认的覆盖层。上游有[相同形态的崩溃记录](https://github.com/ValveSoftware/steam-for-linux/issues/13552)。构建检查通过会在入口前失败的模拟库验证静态隔离，再向真实窗口注入仅在 zygote 初始化时报错的模拟覆盖层，检查自动隔离后正常启动。

用户级安装固定到 `~/Applications/RA2Commander/`，在 `${XDG_DATA_HOME:-~/.local/share}/applications/` 创建菜单入口，使用稳定的可执行文件路径，便于添加为 Steam 非 Steam 游戏。AppImage 安装时复制原 AppImage；解压版复制完整程序目录。安装需要先关闭正在运行的客户端，只替换带本项目标记的目录，拒绝覆盖其他内容；升级使用临时目录准备并在失败时恢复旧程序。卸载删除程序与菜单入口，保留用户设置、浏览器资料和对局。

## 构建与检查

Linux x64 Docker 环境固定基础镜像与 pnpm 版本，按 lockfile 安装目标平台依赖。构建目录与 macOS 的 node_modules 隔离，生成 AppImage、tar.gz 和 SHA256SUMS；产物在项目 `dist/`，不自动上传或发布。

归档检查读取 AppImage 的 ELF x86_64 标记和 SquashFS 边界，通过解包工具读取正文；不修改发行文件，也不要求 ARM 主机的 x64 仿真器识别 AppImage 外壳。解包后逐文件及逐链接对照已检查程序，实际 AppImage 和 tar.gz 还可在新的干净容器中复查。AppRun 的 AppImage 安装分支检查复制后的文件与原包相同。

完整离线回归在开发机运行。跨架构容器串行检查安装、预置、资源校验、模型设置与模型资源，再将正式程序移出工程目录检查链接闭包、原生中文识别、QuickJS、历史 ZIP 工作进程及真实游戏首次启动、设置保存、退出与重开。检查使用临时资料、官方样例音频、软件渲染与虚拟显示；不进入对局或发送模型请求。容器运行检查的 Chromium 沙箱参数仅属于测试，发行程序保留默认沙箱。

Docker 中的 Linux x64 检查不等于 Deck 实机验收。普通 AppImage 挂载、Steam 游戏模式、实体麦克风、GPU 表现和系统休眠仍需在设备上验证。AppImage 的 FUSE 不可用时可采用解压版，不要求修改 SteamOS 系统分区。
