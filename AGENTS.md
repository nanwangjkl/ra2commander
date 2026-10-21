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
pnpm test                 # 不访问云模型/真实游戏的冒烟、关键故障与地图数据检查
pnpm maps:check           # 读取并校验默认冰天雪地 17 区方案
```

原型阶段优先验证真实对局体验。自动化测试保留正常命令链路、已修复的关键故障和数据有效性检查；新增用例应针对具体故障或基本运行能力，避免用大量断言固定尚未定型的授权策略、命令参数和数值阈值。

分区读取与查询不需要原始游戏素材或图片。检查其他方案或查询指定格子：

```sh
pnpm maps:check maps/ice/schemes/nanwang-0.1.0.json 39 82
```

重新从标注图生成分区时，离线工具需要 Python 3 和 Pillow；纹理校准另需 cryptography。它们不属于伴随程序的运行时依赖。地图及图片路径可替换；地图和图片哈希、区域文字位置及校准修正保存在提取参数中。更换图片或地形时先重新核对参数，参见[分区规范](doc/spec/map-regions.md)。

```sh
python3 packages/maps/tools/verify_native_alignment.py --pack ~/Downloads/full-pack --map .runtime/maps/ice/mp32s8.map --image mp32s83.png --out .runtime/maps/ice/native-texture-check.json
python3 packages/maps/tools/import_regions.py --map .runtime/maps/ice/mp32s8.map --image mp32s83.png --annotations maps/ice/import/annotations.json --out maps/ice/schemes/nanwang-0.1.0.json --diagnostics .runtime/maps/ice/generated
```

运行伴随程序（MVP 文本命令版）：

```sh
pnpm companion
```

`pnpm companion` 会：本地 https 静态伺服游戏目录（默认 `https://127.0.0.1:8787/`，自签证书）→ 启动持久化 Chromium（profile 在 `.runtime/profile`，已 gitignore）→ CDN 代理转发 → 注入页面桥 → 自动处理启动对话框（音频授权、资源恢复等）。之后由玩家手动进入 单机模式 → 遭遇战，桥检测到 `window.werhd` 后即可调动部队。

命令有两个入口，命令集相同（`help` 查看）：

- 终端交互（TTY 前台运行时）：`ra2c>` 提示符直接输入。
- TCP 命令通道（始终可用，供自动化脚本）：`printf 'move all 50 60\n' | nc 127.0.0.1 8790`。

战斗任务须显式提供调试授权参数；生产数量和队列权限也独立于模型保存。例如（坐标须按当前地图选择）：

```text
form create 一队 tanks
task new 守区 @一队 --region=40,40,60,60 --retreat=0.6,20,20 守区，战损超过六成回撤
task stop 守区
produce MTNK 5 --pause-queues=2 优先生产
```

`--mode=hold` 为默认守区模式；`move` 只允许赶路，`assault` 额外允许区内攻击移动。`--retreat=比例,x,y` 只在任务原始成员阵亡比例严格超过阈值后允许回撤，触发后不自动返回。缺省无队列暂停/恢复权限；恢复仅限本任务实际暂停的队列，无法观测状态的队列会反馈限制。`--pause-queues` 编号为 0=建筑、1=防御、2=步兵、3=车辆、4=飞机、5=船。生产前置各授权一次，目标按数量累计，修复和重启不重置额度；不确定提交结果保留额度并报告。额外自然语言条件尚未形成通用授权解析器，当前支持显式地域和战损阈值；语音、地名绑定仍待实现。

终端与 TCP 在编译期间仍接收停止命令；`task list` 同时列出编译中的任务。TCP 按换行分帧，多条并发命令按完成顺序回显。`stop <ids|all>` 会撤销涉及单位的整项任务和待编译命令，然后停车。

持久化状态已升级为 v2（含独立对局 UUID、生产额度、战损身份与队列归属）。旧 v1 状态不自动恢复，启动时报告并要求重新下令。升级页面桥也会使旧授权失效；游戏与资源 profile 保留。

环境变量覆盖：`RA2C_GAME_DIR`、`RA2C_PACK`、`RA2C_PORT`、`RA2C_PROFILE`。

## 代码结构

```text
apps/companion/            # 启动器：静态伺服、自动导入、文本 CLI
packages/contracts/        # 桥契约、宿主动作校验 + vendored werhd API 类型声明
packages/game-werhd/       # 页面桥（bridge.js 注入 + 宿主侧 WerhdBridge）
packages/command/          # Acorn 语法/契约检查、生成与有限修复
packages/runtime/          # 命令代次、授权、编队、战损、生产额度和持久化
packages/js-worker/        # 独立子进程中的 QuickJS WASM 隔离执行器
packages/model-providers/  # 可取消的云模型接入
packages/maps/             # 分区方案读取、空间查询与离线提取工具
maps/ice/                  # 地图分区方案及提取参数
tests/                     # 命令冒烟、关键故障与地图数据检查
```

其余模块（speech、skills/）按架构设计在对应里程碑再建。运行时数据（profile、截图）在 `.runtime/`，已 gitignore。

