# ra2commander - Agent 指南

本项目基于 [ra2web](https://github.com/ra2web/ra2web.github.io) 设计独立的本机语音指挥伴随程序。

本项目不使用 `reverse-engineer-anything`（REA）Skill。

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

## 当前原则与范围

RTS 优先快速反应。能理解行动目标时，Agent 应结合当前战况选一个合理解释并执行，接受误选和次优结果，由玩家后续命令纠正。阵营、同类生产项目或执行细节存在多个候选，不应成为拒绝执行或等待确认的理由。选择应简短反馈；一部分暂时做不了时，先推进其余可执行部分。详见[命令解释决策](doc/decisions/007-action-first-command-interpretation.md)。

每阶段交付后等待用户明确验收，再按其授权继续；自动检查、实机自查和功能已实现均不能代替用户验收。不同路线图的授权独立，完成当前阶段不自动启动其他计划。历史批准、验收与提交见[开发记录索引](doc/roadmap/development-history.md)，各计划开头记录现状，带日期或版本的交付记录保留当时口径。

[里程碑后的架构整理](doc/roadmap/architecture-consolidation.md)已完成运行时职责收拢、探路与维修车本机化、生产协调、页面桥和 UI 生命周期整理，并经用户验收提交。最后的文档精简已于 2026-11-01 获用户确认并要求提交，本轮整理收尾，新功能另定范围。早前[运行时整理](doc/roadmap/runtime-simplification.md)阶段 1～5 已全部验收，没有阶段 6。

用户于 2026-11-01 将尚未完成的开发按[新阶段计划](doc/roadmap/client-development-phases.md)重排为：1 历史和设置页内容 → 2 语音识别模块 → 3 Electron 或其他打包客户端方案。已完成部分及验收记录不变，原工作台计划保留作历史参考，各阶段单独实施和验收。阶段 1 已于 2026-11-02 获用户验收并要求提交推送，同日授权开始阶段 2 语音识别；打包客户端尚未启动；指挥记录保持当前局命令与反馈。

阶段 1 的最近 10 局列表、完整 ZIP 下载、模型 URL/Key/模型名设置已于 2026-11-02 完成开发检查并获用户验收。沿用文件归档，以 `.runtime/settings.json` 保存模型配置，不引入 SQLite；独立复盘页面和其他设置项暂不实施。行为见[模型设置](doc/spec/model-settings.md)、[对局记录](doc/spec/battle-records.md)，范围见[详细方案](doc/roadmap/history-download-and-model-settings.md)。

## 游戏行为约束

修改相应模块前阅读下列规范，保留已批准的行为：

- 命令独立并行理解，普通绑定按收到顺序，脚本生成不占绑定队列；停止、暂停与取消优先处理，按范围使旧操作失效，迟到结果不能恢复旧任务。见[命令并发](doc/spec/command-concurrency.md)。
- 科技树以当前对局公开规则为准，复用必要前置。生产台账、产物和交接不因重编或恢复重置；只认领正回执确认的自身队列暂停，未知回执不盲目重发。见[生产执行](doc/spec/production-execution.md)与[生产取消](doc/spec/production-cancellation.md)。
- 坦克、步兵到出生时的有效集结点并完成停车交接后，才允许编队和后续操作；矿车保留原生采矿。集结点逐次入队前复查，周围 3×3 排除静态障碍，到达容差四格但仍须脱离建筑和出口；已就绪成员不召回。建筑完整占地至少隔一格，防御建筑之间可紧贴，围墙豁免间距。见[生产集结点](doc/spec/factory-rally.md)与[建筑选址](doc/spec/building-placement.md)。
- 掩护快慢以真实规则速度判断：最慢成员持续领行，其余预测跟随，普通拉长只纠正相关成员，严重脱队才有限重聚；累计等待不因短暂会合或轮换成员重置。补员独立追赶主体。掩护或受护一侧耗尽且无该侧待准备成员时，剩余成员转普通编队继续原任务；全队耗尽且准备结束才结束任务并保留队名，不自动补兵、撤退或复活旧任务。见[掩护 Skill](doc/spec/cover-skill.md)。
- 攻击保留成员、敌人类别与地域，已有目标直接攻击；普通攻击不加射程前置，掩护支援保留近身和当前射程限制。基地防守以基地所在分区为边界，无敌原地待命。蜘蛛离场只表示暂时不可观测，保留同 ID 等待，不超时猜测阵亡；对局结束先于战损结算。见[攻击与离场状态](doc/spec/selected-attacks-and-sorties.md)与[基地防守](doc/spec/base-defense.md)。
- 常规部署支持美国大兵等，排除灰熊变建筑的 Mod 能力。自动碾压仅启用 MTNK、HTNK、HTK，主动目标排除两类狗，受原攻击范围、掩护及有限受阻回退约束。见[单位部署](doc/spec/unit-deployment.md)与[自动碾压](doc/spec/crushing.md)。

探路逐区 60%、中心优先和并行分工见[探路 Skill](doc/spec/scouting-skills.md)；维修车的组件生产、组装及并行维修见[维修车 Skill](doc/spec/repair-vehicle-skill.md)。[基础能力与三层提示词改造](doc/roadmap/capabilities-prompts-and-skills.md)的 A～C 与探路流程已获用户认可，后续 Skill 和执行迁移按各自计划记录。

## 开发环境

- Node >= 22、pnpm >= 9。
- 本地游戏静态站点默认 `~/my/code/ra2web.github.io`（参考快照 `7f6858a`）。
- 游戏资源默认 `~/Downloads/full-pack.7z`，导入一次后保存在 `.runtime/profile`。
- 环境覆盖：`RA2C_GAME_DIR`、`RA2C_PACK`、`RA2C_PORT`、`RA2C_PROFILE`。
- 建筑操作、采矿、搬迁默认本机执行；分别设置 `RA2C_BUILDING_EXECUTOR=script`、`RA2C_MINING_EXECUTOR=script`、`RA2C_RELOCATION_EXECUTOR=script` 后运行 `pnpm companion` 可回退对应能力，保留目标 ID 和实际进度并生成脚本接管。默认模式不迁移无标记的旧脚本目标。
- 探路 `scout@1.5.0` 默认本机完成现有犬编队、新造犬有限生产和并行探索。`RA2C_SCOUT_EXECUTOR=script pnpm companion` 独立回退探索；无标记旧探索不自动迁移。
- `repair-vehicle@1.2.0` 默认本机完成现有组件编队、新造组件有限生产、组装、维修与跟随。`RA2C_REPAIR_EXECUTOR=script pnpm companion` 独立回退组装维修；无标记旧维修不自动迁移。
- 新有限生产、持续补电和显式队列控制默认本机执行，共用真实规则准备、队列与台账。`RA2C_PRODUCTION_EXECUTOR=script pnpm companion` 回退生产，保留目标 ID、产物和实际进度，无标记旧目标保持脚本。各能力回退彼此独立，生产部分仍由生产开关控制。

```sh
pnpm install
pnpm playwright-install   # 首次下载 Chromium
pnpm companion
```

Companion 启动本地 HTTPS 服务和常驻 Chromium，导入资源、注入页面桥并打开 `https://127.0.0.1:8787/commander/`。左侧为游戏 iframe，右侧为命令侧栏。玩家手动进入单机 → 遭遇战；当前单图配置自动绑定冰天雪地分区。重启复用工作台和对局，不自动刷新 iframe；`quit` 只断连，`quit hard` 才关闭浏览器。

侧栏输入文本或终端 `say <原话>` 模拟语音；真实录音/识别尚未接入。终端 `help` 查看命令，TCP 入口为 `127.0.0.1:8790`。基础能力、运行行为、完成判定与显式调试参数见[运行时行为与调试入口](doc/architecture/runtime-control.md)。

模型可在“设置”页填写 Base URL、Key 与模型名，保存后用于新请求，无需重启游戏。只保留当前一套配置，保存覆盖旧值；已有 `.env` 兼容读取，本机配置优先，空 Key 保留原值，更换 URL 需填写适用的 Key。设置页保留三个字段及保存、测试连接按钮，不提供多配置管理；只有主动点击测试连接才额外请求模型，测试不保存配置。配置保存在已忽略的 `.runtime/settings.json`，不写入调试包，详见[模型设置](doc/spec/model-settings.md)。

## 修改与验证

```sh
pnpm typecheck
pnpm test                 # 不访问云模型或真实游戏
pnpm ui:check             # 独立无头 Chromium，仅检查模拟工作台；需先安装 Playwright 浏览器
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

新命令只写 `.runtime/battles/<battle-id>/`：v3 `events.jsonl` 保存变化与引用，动态列表按成员身份和字段记变化；`objects/` 按哈希保存正文，`meta.json` 和 `summary.md` 为派生索引/复盘。相同观察不重复保存，关键变化保留完整上下文。反馈成功前同步正文和日志；保存失败保留输入供重试。旧 v1/v2 日志与 `.runtime/transcripts/` 继续兼容读取，不批量覆盖历史。

```sh
pnpm records:read --list
pnpm records:read <battle-id>             # 展开引用输出完整 JSON，无需游戏或 Companion
pnpm records:read <battle-id> --summary
pnpm records:export <battle-id>          # 无损去重并生成单局 .ra2c.jsonl.gz 提交包
pnpm records:export <battle-id> --zip    # 标准 ZIP，网页下载使用同一格式
pnpm records:read <提交包路径> --summary  # 可在没有游戏和原档的机器读取
```

归档供玩家与开发 Agent 复盘。终端提交包默认写 `.runtime/record-exports/`，网页 ZIP 由独立 worker 在临时目录准备，下载完成或过期后清理。两种格式均校验全部逻辑事件，保留命令、反馈、错误、代码和历史观察，原档不改写；不包含无引用正文、模型配置、Key、浏览器资料或其他对局，不上传。ZIP 另含派生摘要和校验清单，旧 gzip 格式保持兼容。历史页按开局时间显示最近十局，排除未进局记录和当前进行中的对局，不删除更早归档。指挥记录保持当前局命令与反馈，不提供代码预览。只优化后续新增记录，存量原档保持原样。数据格式与接口见[对局记录](doc/spec/battle-records.md)。

## 地图工具

分区读取与查询不需要原始游戏素材或图片。检查其他方案或查询指定格子：

```sh
pnpm maps:check maps/ice/schemes/nanwang-0.1.0.json 39 82
```

重新从标注图生成分区时，离线工具需要 Python 3 和 Pillow；纹理校准另需 cryptography。它们不属于伴随程序的运行时依赖。地图及图片路径可替换；地图和图片哈希、区域文字位置及校准修正保存在提取参数中。更换图片或地形时先重新核对参数，参见[分区规范](doc/spec/map-regions.md)。

```sh
python3 packages/maps/tools/verify_native_alignment.py --pack ~/Downloads/full-pack --map .runtime/maps/ice/mp32s8.map --image mp32s83.png --out .runtime/maps/ice/native-texture-check.json
python3 packages/maps/tools/export_playable_area.py --map .runtime/maps/ice/mp32s8.map --map-id ra2:mp32s8 --out maps/ice/playable-area.json
python3 packages/maps/tools/export_static_obstacles.py --map .runtime/maps/ice/mp32s8.map --rules ~/my/code/ra2web.github.io/res/overlay/rules.ini --art ~/my/code/ra2web.github.io/res/overlay/art.ini --map-id ra2:mp32s8 --out maps/ice/static-obstacles.json
python3 packages/maps/tools/import_regions.py --map .runtime/maps/ice/mp32s8.map --image mp32s83.png --annotations maps/ice/import/annotations.json --out maps/ice/schemes/nanwang-0.1.0.json --diagnostics .runtime/maps/ice/generated
```

## 代码入口

- `apps/companion/src/`：启动器、模型编排、能力绑定、记录、桥接与命令入口；`ui/` 为工作台。
- `packages/contracts/`：快照、动作、目标与命令契约。
- `packages/command/`：Markdown 加载、能力类型、理解/编译与干跑检查。
- `packages/runtime/`：控制对象协调、`goals/` 静态处理器、生产/归属与 v4 持久化。
- `packages/js-worker/`：独立 QuickJS WASM 子进程；编译检查与实战分别运行。
- `packages/game-werhd/`、`model-providers/`、`maps/`：游戏桥、云模型、地图数据。
- `skills/scout/`、`skills/repair-vehicle/`、`skills/cover/`：探路、维修车和掩护游戏 Skill；语音模块待后续阶段。

运行数据在 `.runtime/`，已忽略；项目介绍与全部文档入口见 [README.md](README.md)。
