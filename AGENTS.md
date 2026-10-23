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

工作台、命令侧栏与语音输入按[分阶段计划](doc/roadmap/browser-workbench-and-voice.md)推进。计划已于 2026-10-23 获用户批准，阶段 1 已由用户验收通过，阶段 2 已获准在提交第一阶段后开始；阶段 3–4 未开始。每阶段交付后等待用户明确验收通过，再进入下一阶段，不以自动检查或自行实机观察代替用户验收。

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

实机测试由用户自行观看。除非用户明确要求，不自动截图、录屏、生成测试报告，也不添加游戏内测试提示或自动移动镜头。

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

`pnpm companion` 会：本地 https 静态伺服游戏目录（默认 `https://127.0.0.1:8787/`，自签证书）→ 启动持久化 Chromium（profile 在 `.runtime/profile`，已 gitignore）→ CDN 代理转发 → 注入页面桥 → 打开 `https://127.0.0.1:8787/commander/` 工作台并处理游戏启动对话框。左侧为游戏 iframe，右侧为命令侧栏：卡片实时显示原话、理解摘要、实际选择与错误（阶段 2），底部输入框可提交文本模拟语音；录音将在后续阶段接入。玩家手动进入 单机模式 → 遭遇战，桥检测到游戏 frame 的 `window.werhd` 后即可调动部队。

侧栏可拖动边界调宽、收起；顶部全屏按钮及 F11 对整个工作台生效，保留侧栏。界面静态资产启动时从 `apps/companion/ui/` 编译至 `.runtime/ui/`。Companion 重启复用已有工作台和游戏 frame，不自动刷新页面；仍在进行的旧版独立游戏页会保留，结束旧对局后再打开工作台。刷新整个工作台会重载游戏，重连不需要刷新。`eval` 在游戏 frame 求值，手动 `shot` 截取整个工作台；没有自动截图。

模拟语音入口使用 `say <文字>`，将文字作为语音转写结果：先由当前云模型解析目标，再走同一脚本生成与替换流程；真实录音与识别尚未接入。支持展开基地、生产并编队、前往已绑定地名、明确要求的持续补电，以及已有作战编队全图进攻。解析提示在 `apps/companion/src/transcript.ts`，脚本生成提示在 `packages/command/src/script-contract.ts`，原话、模型解析及目标保存在 `.runtime/transcripts/`。

地名使用前须在当前对局执行 `map use ice`，显式选择冰天雪地默认方案；该绑定换局失效，不通过地图尺寸猜测地图名称。地名移动使用分区内部候选格，是否可达以实际位置确认。`say 制造间谍卫星，保持电量健康` 会分别建立卫星生产和持续补电目标；未指定电力余量时，本轮测试默认至少留100，已提交电厂在完成前计入待补电量，避免重复下单。补电目标持续到取消。

六句实机测试需要一个只有基地车的新冰天雪地对局：

```sh
pnpm scenario:voice
pnpm scenario:voice --resume  # 同局续测，已完成项目不重放
```

测试定义在 `tests/scenarios/voice-six-commands.json`，按原话依次调用模型；读取实际建造、产出、编队、分区位置、电力与敌方败北状态，在终端反馈进度。补电同时检查过程缺电，最终健康但曾缺电会标记部分达标；已确认败北的玩家可能不再是combatant。执行器仅在 `.runtime/voice-six/progress.json` 保存续测所需的步骤、指令响应和末次败北状态，不采集画面或生成报告；`--resume` 也可读取旧版 `result.json` 迁移进度。本测试访问已配置云模型并会执行真实游戏动作，不属于 `pnpm test`。首次实机结果见[六句测试记录](doc/roadmap/voice-six-commands.md)。

命令有两个入口，命令集相同（`help` 查看）：

- 终端交互（TTY 前台运行时）：`ra2c>` 提示符直接输入。
- TCP 命令通道（始终可用，供自动化脚本）：`printf 'move all 50 60\n' | nc 127.0.0.1 8790`。

战斗任务须显式提供调试授权参数；生产数量和队列权限也独立于模型保存。例如（单位 ID 用 `units` 查询，坐标须按当前地图选择；建队目标完成后再给该队下令）：

```text
form create 一队 101,102
task new 守区 @一队 --region=40,40,60,60 --retreat=0.6,20,20 守区，战损超过六成回撤
task stop 守区
produce MTNK 5 --pause-queues=2 优先生产
goal list
reinforce @一队 MTNK 6
```

`--mode=hold` 为默认守区模式；`move` 只允许赶路，`assault` 额外允许区内攻击移动。`--retreat=比例,x,y` 只在任务原始成员阵亡比例严格超过阈值后允许回撤，触发后不自动返回。缺省无队列暂停/恢复权限；恢复仅限本任务实际暂停的队列，无法观测状态的队列会反馈限制。`--pause-queues` 编号为 0=建筑、1=防御、2=步兵、3=车辆、4=飞机、5=船。生产前置各授权一次，目标按数量累计，修复和重启不重置额度；不确定提交结果保留额度并报告。任意自然语言条件尚未形成通用授权解析器，当前条件任务支持显式地域和战损阈值；录音识别仍待实现。

每队独立一份脚本，全局一份脚本。`produce`、`form create/transfer/dissolve`、`reinforce` 和 `rally` 都更新全局目标并整体替换其代码；`task new <标签> @编队 ...` 仅替换对应编队代码。`form create` 也支持单位 ID、范围或兵种筛选。编队成员变更停车提交确认后交接，`form list` 查看实际归属。

`goal list` 显示目标状态、待生效变更和生产提交记录；`goal edit <生产目标ID> <总量>` 保留已提交进度；`goal cancel <目标ID>` 立即停止该目标的后续执行，其余全局目标继续。`global pause/resume` 控制全局脚本，`task stop/pause/resume @编队` 控制编队，旧任务标签也可解析到对应编队。普通改令失败时旧目标继续，新增目标显示待生效及失败原因。

`reinforce @编队 <兵种名> <维持数量> [--source=@来源编队]` 持续补员，缺省只使用未编队单位，不额外生产；`rally <ids|all> <x> <y>` 给未编队单位建立集结目标。底层 `move/amove/gather/attack` 仅供调试，涉及活动脚本或待编译命令管理的单位时先停止对应控制对象。

生产提交与实际完成分开记录；`submitted` 表示进入游戏 API 调用，不保证已经成功入队。游戏缺少完整产物出生事件，同名目标按已有提交顺序观察；不会因已造单位阵亡再次下单。不确定或静默未入队的提交先保留额度，人工核对后可用 `goal resolve <提交ID> sent|not-sent` 修正，仅在确认未发送时释放额度。

终端与 TCP 在编译期间仍接收停止命令；`task list` 同时列出全局与编队的脚本版本和编译状态。TCP 按换行分帧，多条并发命令按完成顺序回显。`stop <ids|all>` 会撤销相关编队任务、待编译版本和涉及这些单位的全局管理目标，然后停车。

持久化状态已升级为 v3（目标与当前脚本分离，包含生产记录、战损基准、队列与交接归属）。v1/v2 状态不自动合并，首次写入新格式前保留旧文件备份；核对已有游戏队列后重新下令。v3 等到当前快照确认同局才恢复，预留未决记录不自动重放。升级页面桥也会使旧授权失效；游戏与资源 profile 保留。

环境变量覆盖：`RA2C_GAME_DIR`、`RA2C_PACK`、`RA2C_PORT`、`RA2C_PROFILE`。

## 代码结构

```text
apps/companion/            # 启动器：静态伺服、自动导入、文本 CLI
packages/contracts/        # 桥契约、宿主动作校验 + vendored werhd API 类型声明
packages/game-werhd/       # 页面桥（bridge.js 注入 + 宿主侧 WerhdBridge）
packages/command/          # Acorn 语法/契约检查、生成与有限修复
packages/runtime/          # 控制对象、目标、脚本切换、生产记录、归属与 v3 持久化
packages/js-worker/        # 独立子进程中的 QuickJS WASM 隔离执行器
packages/model-providers/  # 可取消的云模型接入
packages/maps/             # 分区方案读取、空间查询与离线提取工具
maps/ice/                  # 地图分区方案及提取参数
tests/                     # 命令冒烟、关键故障与地图数据检查
```

其余模块（speech、skills/）按架构设计在对应里程碑再建。运行时数据（profile、截图）在 `.runtime/`，已 gitignore。

