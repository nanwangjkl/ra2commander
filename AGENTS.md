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

## 设计原则

RTS 优先快速反应。能理解行动目标时，Agent 应结合当前战况选一个合理解释并执行，接受误选和次优结果，由玩家后续命令纠正。阵营、同类生产项目或执行细节存在多个候选，不应成为拒绝执行或等待确认的理由。选择应简短反馈；一部分暂时做不了时，先推进其余可执行部分。详见[命令解释决策](doc/decisions/007-action-first-command-interpretation.md)。

工作台、命令侧栏与语音输入按[分阶段计划](doc/roadmap/browser-workbench-and-voice.md)推进。计划已于 2026-10-23 获用户批准，阶段 1 已由用户验收通过，阶段 2 已获准在提交第一阶段后开始；用户于 2026-10-24 追加执行/完成状态和当前局记录衔接，2026-10-25 追加跨局归档与逐命令反馈（见[对局记录](doc/spec/battle-records.md)）。本机归档与逐命令反馈、侧栏精简已于 2026-10-25 由用户验收通过，不据此推定其他阶段整体验收；阶段 4 未开始。每阶段交付后等待用户明确验收通过，再进入下一阶段，不以自动检查或自行实机观察代替用户验收。

[基础能力、提示词与 Skill 改造](doc/roadmap/capabilities-prompts-and-skills.md)的阶段 A～C 已经用户验收，用户在启动 Companion 体验后确认 C（规则与战术拆分）效果良好并要求提交推送，用户于 2026-10-25 验收前轮修正并批准开始 D（探路 Skill）；用户于 2026-10-26 认可探路流程，继续按逐区 60% 微调并复核对局记录，后续阶段未启动。此批准不改变工作台与真实语音计划的阶段边界。

[运行时整理与响应速度改造](doc/roadmap/runtime-simplification.md)的阶段 1 已于 2026-10-26 由用户验收通过，阶段 2～4 已于 2026-10-27 由用户验收通过。阶段 4 已提交推送 `a7e87cb`。用户已于 2026-10-27 验收阶段 5A（建筑操作本机执行试点），5A 已提交推送 `789f1a3`。用户已于 2026-10-27 验收 5B（采矿与搬迁本机执行）并要求提交推送。本轮阶段 1～5 全部验收；本计划没有阶段 6，后续工作须明确新方向，不自动接入其他路线图。用户同日授权修正回溯发现的四处缺口，四处修正已提交推送 `2d34818`。按取消测试反馈补充的生产队列撤销已于 2026-10-27 由用户验收通过；不据此启动其他功能阶段。

## 开发环境

- Node >= 22、pnpm >= 9。
- 本地游戏静态站点默认 `~/my/code/ra2web.github.io`（参考快照 `7f6858a`）。
- 游戏资源默认 `~/Downloads/full-pack.7z`，导入一次后保存在 `.runtime/profile`。
- 环境覆盖：`RA2C_GAME_DIR`、`RA2C_PACK`、`RA2C_PORT`、`RA2C_PROFILE`。
- 建筑操作、采矿、搬迁默认本机执行；分别设置 `RA2C_BUILDING_EXECUTOR=script`、`RA2C_MINING_EXECUTOR=script`、`RA2C_RELOCATION_EXECUTOR=script` 后运行 `pnpm companion` 可回退对应能力，保留目标 ID 和实际进度并生成脚本接管。默认模式不迁移无标记的旧脚本目标。

```sh
pnpm install
pnpm playwright-install   # 首次下载 Chromium
pnpm companion
```

Companion 启动本地 HTTPS 服务和常驻 Chromium，导入资源、注入页面桥并打开 `https://127.0.0.1:8787/commander/`。左侧为游戏 iframe，右侧为命令侧栏。玩家手动进入单机 → 遭遇战；当前单图配置自动绑定冰天雪地分区。重启复用工作台和对局，不自动刷新 iframe；`quit` 只断连，`quit hard` 才关闭浏览器。

侧栏输入文本或终端 `say <原话>` 模拟语音；真实录音/识别尚未接入。终端 `help` 查看命令，TCP 入口为 `127.0.0.1:8790`。基础能力、运行行为、完成判定与显式调试参数见[运行时行为与调试入口](doc/architecture/runtime-control.md)。

## 修改与验证

```sh
pnpm typecheck
pnpm test                 # 不访问云模型或真实游戏
pnpm maps:check
pnpm prompts:check
pnpm capabilities:check
pnpm game-data:check
```

原型优先验证真实对局体验。自动测试保留正常命令链路、关键故障与数据有效性检查；新增用例针对具体故障或基本运行能力，避免大量断言固定实验中的参数和阈值。

实机由用户观看。除非用户明确要求，不自动截图、录屏、生成测试报告、添加游戏内测试提示或自动移动镜头。`pnpm scenario:voice` 会访问云模型并执行真实动作，必须有用户明确要求及只有基地车的新冰天雪地对局；同局续测用 `--resume`，不属于 `pnpm test`。

固定提示词在 `prompts/templates/`，能力在 `prompts/capabilities/`，目录与战术分别在 `prompts/games/`、`prompts/tactics/`，游戏 Skill 在 `skills/`。新命令捕获一份完整版本，同次理解、准备、编译与重试保持该版本；不热替换运行脚本。修改正文后跑 `pnpm prompts:check`。修改能力参数结构、默认值、ID 或绑定器时，还须先跑 `pnpm capabilities:generate`，再检查能力、类型和相关测试并重启；生成类型不手工编辑。目录、科技树导入命令及规则口径见[完整游戏目录](doc/spec/full-game-catalog.md)。

运行时检查点 `.runtime/state.json` 按当前快照证明同局后恢复；生产预留、真实产物、成员交接和进度不因重编/恢复重置。明确取消生产目标会停止追加并撤销其剩余队列，已造产物保留；撤销按实际队列确认并保存，重启不盲目重发。详见[生产取消](doc/spec/production-cancellation.md)。对局归档与运行恢复分离，读取归档不会重放任务。

## 对局记录与反馈

新命令只写 `.runtime/battles/<battle-id>/`：v2 `events.jsonl` 保存变化与引用，`objects/` 按哈希保存正文，`meta.json` 和 `summary.md` 为派生索引/复盘。反馈成功前同步正文和日志；保存失败保留输入供重试。旧 v1 日志与 `.runtime/transcripts/` 继续兼容读取，不批量覆盖历史。

```sh
pnpm records:read --list
pnpm records:read <battle-id>             # 展开引用输出完整 JSON，无需游戏或 Companion
pnpm records:read <battle-id> --summary
```

归档供玩家与开发 Agent 复盘。侧栏只保留当前局命令和反馈，不提供历史选择、导出或代码预览；如需归档 UI，另设页面与 URL。数据格式与接口见[对局记录](doc/spec/battle-records.md)。

## 地图工具

分区读取与查询不需要原始游戏素材或图片。检查其他方案或查询指定格子：

```sh
pnpm maps:check maps/ice/schemes/nanwang-0.1.0.json 39 82
```

重新从标注图生成分区时，离线工具需要 Python 3 和 Pillow；纹理校准另需 cryptography。它们不属于伴随程序的运行时依赖。地图及图片路径可替换；地图和图片哈希、区域文字位置及校准修正保存在提取参数中。更换图片或地形时先重新核对参数，参见[分区规范](doc/spec/map-regions.md)。

```sh
python3 packages/maps/tools/verify_native_alignment.py --pack ~/Downloads/full-pack --map .runtime/maps/ice/mp32s8.map --image mp32s83.png --out .runtime/maps/ice/native-texture-check.json
python3 packages/maps/tools/export_playable_area.py --map .runtime/maps/ice/mp32s8.map --map-id ra2:mp32s8 --out maps/ice/playable-area.json
python3 packages/maps/tools/import_regions.py --map .runtime/maps/ice/mp32s8.map --image mp32s83.png --annotations maps/ice/import/annotations.json --out maps/ice/schemes/nanwang-0.1.0.json --diagnostics .runtime/maps/ice/generated
```

## 代码入口

- `apps/companion/src/`：启动器、模型编排、能力绑定、记录、桥接与命令入口；`ui/` 为工作台。
- `packages/contracts/`：快照、动作、目标与命令契约。
- `packages/command/`：Markdown 加载、能力类型、理解/编译与干跑检查。
- `packages/runtime/`：控制对象协调、`goals/` 静态处理器、生产/归属与 v4 持久化。
- `packages/js-worker/`：独立 QuickJS WASM 子进程；编译检查与实战分别运行。
- `packages/game-werhd/`、`model-providers/`、`maps/`：游戏桥、云模型、地图数据。
- `skills/scout/`、`skills/repair-vehicle/`：两项已实现的游戏 Skill；语音模块待后续阶段。

运行数据在 `.runtime/`，已忽略；项目介绍与全部文档入口见 [README.md](README.md)。
