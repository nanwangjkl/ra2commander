# ra2commander - Agent 指南

本项目基于 [ra2web](https://github.com/ra2web/ra2web.github.io) 设计独立的本机语音指挥伴随程序。

## 文档结构

项目 README 放在仓库根目录，作为项目介绍与文档入口；其余项目文档统一放在 `doc/` 下，按类型分目录。当前约定的结构：

| 目录 | 用途 | 说明 |
|------|------|------|
| `doc/spec/` | 设计规范 | 做什么、怎么设计 |
| `doc/decisions/` | 决策记录（ADR） | 为什么这么定，考虑过哪些被否的方案 |
| `doc/architecture/` | 技术架构 | 模块划分、技术选型、代码地图 |
| `doc/assets/` | 资产规范 | 美术/音频/字体的命名、规格、授权来源 |
| `doc/roadmap/` | 路线图 | 开发阶段规划、首版范围 |

约定：

- 新增文档时，按类型放入对应目录，不要散落到项目其他位置。目录暂未创建时，需要用到再建，不必提前建空目录。
- 修改既有设计时，同步更新对应文档，保持文档与实现一致。
- 决策记录以编号开头命名，如 `001-选择引擎.md`，每条决策一个文件。
- 环境搭建、构建运行等说明直接写在本文件（AGENTS.md）中，不单独建目录。
- 路线图放 `doc/roadmap/`。

## 文档入口

项目文档入口为 [README.md](README.md)。领域术语统一维护在 [doc/spec/CONTEXT.md](doc/spec/CONTEXT.md)，架构决策索引见 [doc/decisions/README.md](doc/decisions/README.md)。

## 开发环境

前置要求：

- Node >= 22、pnpm >= 9
- 本地游戏实例：ra2web 静态站点 clone（参考快照 `7f6858a`，默认路径 `~/my/code/ra2web.github.io`）
- 游戏资源包 `full-pack.7z`（默认路径 `~/Downloads/full-pack.7z`；导入一次后保存在浏览器 profile 中）

安装与检查：

```sh
pnpm install
pnpm playwright-install   # 首次需要，下载 Playwright Chromium
pnpm typecheck
```

运行伴随程序（MVP 文本命令版）：

```sh
pnpm companion
```

`pnpm companion` 会：本地 https 静态伺服游戏目录（默认 `https://127.0.0.1:8787/`，自签证书）→ 启动持久化 Chromium（profile 在 `.runtime/profile`，已 gitignore）→ CDN 代理转发 → 注入页面桥 → 自动处理启动对话框（音频授权、资源恢复等）。之后由玩家手动进入 单机模式 → 遭遇战，桥检测到 `window.werhd` 后即可调动部队。

命令有两个入口，命令集相同（`help` 查看）：

- 终端交互（TTY 前台运行时）：`ra2c>` 提示符直接输入。
- TCP 命令通道（始终可用，供自动化脚本）：`printf 'move all 50 60\n' | nc 127.0.0.1 8790`。

环境变量覆盖：`RA2C_GAME_DIR`、`RA2C_PACK`、`RA2C_PORT`、`RA2C_PROFILE`。

## 代码结构

```text
apps/companion/            # 启动器：静态伺服、自动导入、文本 CLI
packages/contracts/        # 桥契约类型 + vendored werhd API 类型声明
packages/game-werhd/       # 页面桥（bridge.js 注入 + 宿主侧 WerhdBridge）
```

其余包（command/runtime/js-worker/speech/model-providers、maps/、skills/）按架构设计在对应里程碑再建。运行时数据（profile、截图）在 `.runtime/`，已 gitignore。

