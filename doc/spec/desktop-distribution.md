# macOS 与 Windows 分发

两者只提供当前机器架构的 ZIP 解压版：macOS 运行 `.app`，Windows 运行 `ra2commander.exe`。必须在对应系统与架构安装依赖并构建，不能跨平台混装原生语音库。构建命令集中在 [AGENTS.md](../../AGENTS.md)。

普通桌面窗口默认 1480×960，并按当前显示器工作区缩小；Steam Deck 采用 1280×800。`RA2C_STEAM_DECK=1/0` 可显式覆盖 Deck 判定，不新增游戏内分辨率设置或输入映射。

正式用户数据位于 macOS 的 `~/Library/Application Support/ra2commander/.runtime/`、Windows 的 `%APPDATA%/ra2commander/.runtime/`。资源只读，升级或删除程序目录不删除设置和对局；`RA2C_DATA_ROOT` 可覆盖用户数据根。

发行依赖须是自包含文件，不含指向工程的目录链接；资源、原生库和 worker 可在包外工作。构建在移出工程的临时目录检查依赖、识别、QuickJS、ZIP worker、首启、设置与退出，再生成 ZIP 和校验和，不自动上传。

macOS Apple Silicon 已完成实际构建检查，使用 ad-hoc 签名，未提供 Developer ID 或公证；Windows 未签名，目标系统上的实际构建和运行尚未验证。其他架构不因入口存在就视为已验收。

实现：[native-build.mjs](../../apps/desktop/tools/native-build.mjs)、[electron-builder.cjs](../../apps/desktop/electron-builder.cjs)、[window-options.mjs](../../apps/desktop/src/window-options.mjs)。Linux 安装与入口区别见[Linux 分发](linux-distribution.md)。
