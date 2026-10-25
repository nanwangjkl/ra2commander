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
pnpm prompts:check        # 严格检查磁盘中的全部提示词模板，不回退缓存
pnpm capabilities:check   # 检查能力定义、生成类型与绑定器接线
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
python3 packages/maps/tools/export_playable_area.py --map .runtime/maps/ice/mp32s8.map --map-id ra2:mp32s8 --out maps/ice/playable-area.json
python3 packages/maps/tools/import_regions.py --map .runtime/maps/ice/mp32s8.map --image mp32s83.png --annotations maps/ice/import/annotations.json --out maps/ice/schemes/nanwang-0.1.0.json --diagnostics .runtime/maps/ice/generated
```

运行伴随程序（MVP 文本命令版）：

```sh
pnpm companion
```

`pnpm companion` 会：本地 https 静态伺服游戏目录（默认 `https://127.0.0.1:8787/`，自签证书）→ 启动持久化 Chromium（profile 在 `.runtime/profile`，已 gitignore）→ CDN 代理转发 → 注入页面桥 → 打开 `https://127.0.0.1:8787/commander/` 工作台并处理游戏启动对话框。左侧为游戏 iframe，右侧为命令侧栏：卡片实时显示原话、理解摘要、实际选择、执行状态与错误，底部输入框可提交文本模拟语音；录音将在后续阶段接入。玩家手动进入 单机模式 → 遭遇战，桥检测到游戏 frame 的 `window.werhd` 后即可调动部队。

侧栏可拖动边界调宽、收起；顶部全屏按钮及 F11 对整个工作台生效，保留侧栏。界面静态资产启动时从 `apps/companion/ui/` 编译至 `.runtime/ui/`；重连已有工作台时只更新侧栏模块和样式，不重建游戏 iframe。工作台就绪后清理启动时已有、仍为空文档的多余 `about:blank` 占位页。Companion 重启复用已有工作台和游戏 frame，不自动刷新页面；仍在进行的旧版独立游戏页会保留，结束旧对局后再打开工作台。刷新整个工作台会重载游戏，重连不需要刷新。`eval` 在游戏 frame 求值，手动 `shot` 截取整个工作台；没有自动截图。

侧栏按目标区分执行中、持续执行、已完成、受阻、暂停和运行出错；一条命令多个目标全部完成才标为已完成，完成卡片弱化显示。生产按实际观察到的产物、展开按建造厂出现确认完成，移动按部队主体抵达目的地附近确认完成。持续补电与守区不自动标为完成。状态只在改变时推送；重启恢复原命令 ID，不重放命令。

每条卡片的“反馈”可选择符合预期／部分达成／不符合预期并填写备注。反馈归档用于玩家与开发 Agent 复盘，Companion 只保留当前局命令及反馈，不提供历史选择、导出或代码预览；目前不建设归档查看页面，未来如需 UI 应使用独立页面与 URL。资料由 Node 直接保存在 `.runtime/battles/<battle-id>/`：`events.jsonl` 追加保留原话、理解请求与响应、提示版本、脚本生成/校验/修复/生效版本、关键执行事实和历次用户反馈，`meta.json` 为索引，`summary.md` 整理供复盘。反馈文件同步后才确认成功，关闭游戏不会删除文件；不依赖浏览器存储、数据库或云同步。记录只读，不恢复历史任务；无截图、录屏或额外模型调用。旧转写尽力迁入，无法补回原先丢失的代码与成果。详见[对局记录规范](doc/spec/battle-records.md)。

模拟语音入口使用 `say <文字>`，将文字作为语音转写结果：先由当前云模型解析目标，再走同一脚本生成与替换流程；真实录音与识别尚未接入。支持展开基地、现有单位编队、生产并编队、前往已绑定地名、指定编队的区域清敌、明确要求的持续补电，以及已有作战编队全图进攻。固定模型提示统一放在 `prompts/templates/`，由 `packages/command/src/prompt-loader.ts` 在新命令或编译请求边界加载、校验并计算内容版本；同一条转写命令的理解与各控制对象编译固定使用同一套模板，不在逐 tick 执行中重读。原话、模型原始解析、校正后的操作、目标及实际请求提示版本保存在 `.runtime/transcripts/`。侧栏主要理解摘要来自实际绑定计划。“5个坦克编入1队”操作现有未编队坦克，“所有坦克编入1队”合并现有匹配单位；不足时执行可用部分并反馈，不擅自生产。

提示词维护：`interpret.md` 控制文字理解，`compile.md` 控制全局与编队脚本生成，`repair.md` 和 `validation-feedback.md` 分别接受 `{{error}}`、`{{errors}}`。编辑后执行 `pnpm prompts:check`；模板在下一条新命令或新修复请求生效，同次请求的异步准备、重新绑定及校验重试固定使用原版本。模板出错时打印具体文件错误，当前进程沿用上一套完整可用模板；首次加载无可用版本则明确报错。校验命令始终严格读取磁盘，可附模板目录参数。终端及自动修复在请求时输出提示版本；生效脚本的 `script.promptVersion` 随 v3 状态保存，旧状态缺少该字段仍可恢复。修改提示文件不替换已经运行的脚本。

21 项玩家能力统一在 `prompts/capabilities/*.md` 声明名称、参数、默认值与说明；`interpret.md` 的 `{{capabilities}}` 由加载器组合该目录。停止、暂停、恢复、转编、解散、守区、补员、集结、目标取消与改总量均可经 `say`/侧栏调用。绑定后的摘要来自共用执行计划；直接控制无需额外生成脚本。`cap list` 查看能力，`cap <能力ID> <JSON参数>` 直接调用，原有玩家 CLI 语法也是同一入口的适配器。开发定义与完整接线表见[玩家基础能力](doc/spec/player-capabilities.md)。

修改能力正文或参数说明在下一条命令生效。修改参数结构、默认值、ID 或绑定器时，先运行 `pnpm capabilities:generate`，再运行 `pnpm capabilities:check`、`pnpm typecheck` 和相关测试，并重启 Companion；生成文件 `packages/command/src/capability-types.generated.ts` 不手工编辑。新增能力还须实现绑定器。模板、能力、游戏目录、战术和 Skill 共同参与提示版本，类型不一致或重载出错保留上一套完整定义。检查命令可从其他目录启动；指定自定义模板目录时，其同级须有 `capabilities/`。

游戏目录集中在 `prompts/games/current-mod.md`：当前配置为共和国之辉，包含盟军、苏军、中国的候选、角色别名及前置类别；候选已核对本地规则，但实际前置、可造性、队列、电力与角色标记以对局 API 为准。战术在 `prompts/tactics/` 按目标选择通用、生产、作战、管理主题，修复/校验重试再加入恢复主题。基础 `compile.md` 只保留脚本契约。目录、战术修改也在下一条命令生效并参与同一提示版本；自定义模板目录使用 `<根>/prompts/templates/`，携带同级 `capabilities/`、`games/`、`tactics/` 以及 `<根>/skills/`。`pnpm prompts:check` 严格检查全部内容，详见[规则与战术规范](doc/spec/game-rules-and-tactics.md)。

运行时提供生产目标的 `productionPlan`，包含缺失前置、已提交待完成前置、本步可造候选与就绪建筑；模型按这些动态事实执行。引擎确认目标可造时，不再等待历史缺项或额外补造旧前置。名称选择、坦克筛选与前置类别共用当前游戏目录；同次规则准备复用查询，使用命令捕获的目录版本。侦察犬也可通过首个 `scout` Skill 执行探路，见下文。

`say 探路` 默认优先使用现有未编队侦察犬（最多三条），没有时才新造并建立独立侦察队；`say 用五条狗探路` 覆盖数量，`say 用已有狗探路` 使用现有成员、不追加生产。首名成员实际停车交接完成即可出发，其余后续加入。按分区内多个落点分散探索，宿主分批读取实际揭开格子，排除原生地形与引擎边界确定的图外格子，每个目标分区的有效范围分别达到至少 60% 才达标，全部目标分区达标后完成；达标区不再分配落点。侧栏显示达标分区数和未达标区的实际覆盖。优先区域中心及中心附近未知有效格子，成员独立并行，原地停滞才换点；覆盖继续增长时恢复尝试额度，收尾对暂缓区额外换点重试一轮。无法继续如实显示部分完成/失败，不无限补狗。`say 取消探路` 停止本次后续步骤；给侦察队改令后旧 Skill 不再接管。Skill 版本和探索进度随 v4 保存，同局重启不重复生产。定义、覆盖口径和开发入口见[探路 Skill](doc/spec/scouting-skills.md)。

执行器与宿主共用生产队列调度：多个目标共享本步空位，按脚本动作顺序先推进能放下的数量，其余留到下一步，不因重复使用同一空位而整批暂停；项目、目标额度及实际前置校验继续保留。

同名明确建设目标与共享前置的新提交统一归账：其他目标先建出的兵营、重工也计入当时尚未完成的明确建设目标，避免替换脚本后再造一份。建筑 `no-spot/cannot-place` 保留就绪项目并持续重试放置，不取消或重造。旧有建筑和新增目标之前的提交不抵消玩家后来明确追加的数量。

“所有战斗单位”使用共用 `combat` 选择器，按本局武器和角色排除矿车、基地车、工程师及建筑，包含坦克、IFV 等作战成员；`vehicles` 仍包含矿车。同句向同一队的多个选择合并去重，编队与后续移动按原顺序绑定；新队尚在建立/交接时，移动目标等待真实成员就绪，不因暂未注册而跳过。新编队生效后再初始化真实成员基准。后续改令正常替换旧任务时，卡片显示新命令及替换原因。

IFV/FV/多功能步兵车作为目录候选在开局尚未解锁时就可绑定，再按实际规则补齐前置。同句话同队多个移动合并成一个有序路线目标；`combat.move` 的 `patrol=true` 允许途中交战，明确终点的路线走完一次结束，不默认无限循环。“基地附近”按当前己方建造厂或基地车位置绑定。宿主用实际到达推进路点索引并随 v3 状态保存，每步 `spec.destination` 是当前站；换脚本不重置进度，后续整句新命令仍替换该队路线。侧栏区分产量与路点进度。

移动、路线和未编队集结共用 `packages/runtime/src/arrival.ts` 的主体到达判定：按存活受控人数扩大半径（当前为 `max(3, ceil(2.5×√N))` 格），至少 80% 成员进入范围即可继续，少量掉队成员保留归属并继续跟随下一站；无人、仅少数前锋到达或全队交接未完成不算到达。相同 `arrival` 事实传给脚本，避免模型另设全员 1–2 格挤点条件。该判定只表示抵达目的地，不代表区域敌人已经清空。

模型调用按控制对象合并：整句理解通常一次，全局和每个需要变更的编队各生成一次；不同控制对象目前依次编译，执行阶段只运行本机脚本。校验重试、重新绑定及自动修复另计。详细协调方式见[玩家基础能力](doc/spec/player-capabilities.md)。

当前只使用冰天雪地，进入新对局或 Companion 重连后会自动绑定其默认分区，无需先执行 `map use ice`；该命令保留为手动重绑入口。这是单图默认配置，不通过地图尺寸猜测地图名称。地名移动使用分区内部候选格，是否可达以实际位置确认。区域清敌用真实异形边界筛选敌人；行军可经过其他区域，到达不能当作清空分区。普通攻击不再被宿主或页面桥的射程预判拦截，游戏处理接近和开火。`say 制造间谍卫星，保持电量健康` 会分别建立卫星生产和持续补电目标；未指定电力余量时，本轮测试默认至少留100，已提交电厂在完成前计入待补电量，避免重复下单。补电目标持续到取消。

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

持久化状态写为 v4（保留目标、脚本、生产记录、战损、队列与交接，增加 Skill 和探索事实），兼容读入无 Skill 数据的 v3。v1/v2 不自动合并；首次写新格式前保留旧格式备份。恢复须当前快照确认同局，预留未决记录不自动重放。升级页面桥也会使旧授权失效；游戏与资源 profile 保留。

环境变量覆盖：`RA2C_GAME_DIR`、`RA2C_PACK`、`RA2C_PORT`、`RA2C_PROFILE`。

## 代码结构

```text
apps/companion/            # 启动器：静态伺服、自动导入、文本 CLI
packages/contracts/        # 桥契约、宿主动作校验 + vendored werhd API 类型声明
packages/game-werhd/       # 页面桥（bridge.js 注入 + 宿主侧 WerhdBridge）
packages/command/          # Acorn 语法/契约检查、生成与有限修复
packages/runtime/          # 控制对象、目标、脚本切换、生产记录、归属、探索与 v4 持久化
packages/js-worker/        # 独立子进程中的 QuickJS WASM 隔离执行器
packages/model-providers/  # 可取消的云模型接入
packages/maps/             # 分区方案读取、空间查询与离线提取工具
prompts/templates/         # 理解、脚本生成、修复和校验反馈的 Markdown 模板
prompts/capabilities/      # 基础能力元信息、参数与行为说明
prompts/games/             # 当前游戏目录、阵营、角色与规则适用说明
prompts/tactics/           # 按目标和恢复条件组合的战术主题
maps/ice/                  # 地图分区方案及提取参数
tests/                     # 命令冒烟、关键故障与地图数据检查
```

`skills/scout/SKILL.md` 保存首个游戏 Skill 定义，`speech` 按架构设计在后续里程碑再建。运行时数据（profile、截图）在 `.runtime/`，已 gitignore。

