# macOS 与 Windows 分发

2026-11-02 用户要求增加 macOS、Windows build 选项，普通桌面使用默认窗口尺寸，Steam Deck 保持 1280×800。构建和运行命令见 [AGENTS.md](../../AGENTS.md)，Linux 现有安装行为见 [Linux 分发](linux-distribution.md)。

## 目标与窗口

macOS 和 Windows 均仅提供当前机器架构的 ZIP 解压版：macOS 解压后直接运行 `.app`，Windows 解压后运行 `ra2commander.exe`。支持 x64、arm64，以运行构建命令的 Node 架构为准；分别在目标操作系统安装锁定依赖并构建，不从 macOS 生产依赖直接生成 Windows 或 Linux 包。构建元数据和打包目标不一致时停止。

普通桌面沿用 1480×960 默认窗口，宽高分别不超过当前显示器工作区，允许玩家调整窗口。Linux 上 `SteamDeck=1` 或 Valve 的 Jupiter/Galileo 硬件标识使用 1280×800，不被桌面任务栏缩小；可用 `RA2C_STEAM_DECK=1/0` 覆盖。普通 Linux 桌面也使用默认窗口。尺寸策略不新增游戏分辨率设置或手柄映射。

## 运行目录和依赖

沿用预编译运行目录、固定游戏与地图资源、SenseVoice 模型、独立宿主和相同工作台。原生库由目标系统本机安装，运行资源放在 ASAR 外。Linux 启动器和安装 shell 文件只出现在 Linux 包中。

macOS 和 Windows 在临时工作区使用原锁文件安装 hoisted 生产依赖，避免 pnpm 9 deploy 的不完整 hoisted 输出、macOS 签名递归遍历目录链接和 Windows 绝对 junction 随包失效。发行依赖必须是实际文件；工作区别名通过 ESM 转发到 `runtime/packages/` 的唯一编译实现，不要求启用 Windows 开发者模式或管理员权限。构建不改写工程的包布局。

正式用户数据根为 macOS 的 `~/Library/Application Support/ra2commander/`、Windows 的 `%APPDATA%/ra2commander/`；两者仍以 `.runtime/` 保存设置、归档及浏览器资料。Linux 原路径和开发入口保持原约定。`RA2C_DATA_ROOT` 继续可覆盖，不向程序目录写用户数据。更换或删除解压目录不会删除用户资料。

## 检查和分发边界

本机构建先生成未压缩应用，将其复制到工程目录外，使用该应用内置 Node 检查依赖链接闭包、原生中文识别、QuickJS 与历史 ZIP 工作进程，再用独立隐藏窗口及合成麦克风验证游戏首启、默认窗口尺寸、设置保存和退出重开。检查使用临时用户资料与独立端口，不提交云模型命令或进入对局。通过后生成 ZIP 与 SHA256SUMS；macOS 还会实际解压 ZIP，逐文件核对已检查应用。不自动上传。

macOS 使用 ad-hoc 签名并包含麦克风用途声明；当前无 Developer ID 和 Apple 公证。Windows 未配置代码签名证书。这是本机分发方案，正式公开发行的签名另行配置。Windows 程序和实体设备上的麦克风、GPU、游戏体验仍需在对应系统验收。
