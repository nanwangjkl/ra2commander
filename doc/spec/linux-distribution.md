# Linux 分发

目标为 Linux x86_64，提供 AppImage 与 tar.gz；Steam Deck 0.1.4 已于 2026-11-03 获用户实机验收。用户沿用个人键盘映射，不增加专用手柄层。

## 安装与数据

AppImage 可直接运行，也可执行 `--install` 安装；解压版运行 `ra2commander`，或用 `install.sh` 安装。示例中的版本替换为实际文件名：

```sh
chmod +x RA2Commander-0.1.4-linux-x86_64.AppImage
./RA2Commander-0.1.4-linux-x86_64.AppImage --install
```

用户级安装放在 `~/Applications/RA2Commander/` 并创建应用菜单入口。Steam 非 Steam 游戏指向稳定路径 `~/Applications/RA2Commander/RA2Commander.AppImage`。更新前关闭客户端，重新安装；`--uninstall` 或解压版 `uninstall.sh` 删除程序与菜单，保留用户数据。安装只替换带项目标记的目录，失败恢复旧程序。

用户数据默认在 `${XDG_DATA_HOME:-~/.local/share}/ra2commander/.runtime/`，保存配置、对局、证书和 Electron profile；`RA2C_DATA_ROOT` 可覆盖根。安装资源不写用户数据，不迁移开发资料，不打包开发者 Key、`.env` 或对局。

## 包与运行边界

包内有 Electron、编译宿主与工作进程、提示词、Skill、地图、基础资源和语音模型，用户无需另装 Node、pnpm 或浏览器。原生库和大资源在 ASAR 外，所有版本由清单校验；基础单机资源和冰天雪地随包，其他在线资源及云模型仍可能联网。

Linux 入口 `ra2commander` 在运行 `ra2commander.bin` 前只移除 `LD_PRELOAD` 中的 `gameoverlayrenderer.so` / `gameoverlayrenderer64.so`，保留其他环境和参数。原因是 Deck 实测 Steam 覆盖层导致 zygote 崩溃，清空预加载可恢复；不以关闭 GPU 或发行沙箱代替修复。AppImage 与解压版共用该入口。

## 构建验证

构建命令见 [AGENTS.md](../../AGENTS.md)。Docker 隔离 Linux x64 原生依赖，产物及 SHA256SUMS 写入 `dist/`，不自动发布。检查包括移出工程目录运行、原生识别、QuickJS、ZIP worker、首启资源、设置及退出重开，并解包比对实际两种发行档。容器检查不替代目标设备验收。

构建与安装实现：[apps/desktop/tools/](../../apps/desktop/tools/)、[install.mjs](../../apps/desktop/src/install.mjs)。FUSE 不可用可使用解压版，不要求修改 SteamOS 系统分区。
