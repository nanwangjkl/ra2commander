# ra2commander - 开发指南

每次开始工作先读本文件，面向用户用中文简洁沟通。修改前检查相关实现与规范，修改后运行相应检查。本项目不使用 `reverse-engineer-anything`（REA）Skill。

## 范围与文档

项目用途和上手方式见 [README.md](README.md)，技术文档入口为 [doc/README.md](doc/README.md)，术语见 [CONTEXT.md](doc/spec/CONTEXT.md)。个人 Steam Deck 主线已于 2026-11-03 获用户验收；专用手柄开发按用户要求取消，沿用个人键盘映射。Windows 入口存在但实际构建与运行未验证。交付历史只记在[开发里程碑](doc/roadmap/development-history.md)。

- 分阶段工作交付后等用户明确验收，再按授权继续；自动检查不能替代用户验收，不同计划的授权独立。
- README 面向使用者，不放开发流水或全量文档目录。环境、构建、工具命令集中在本文件。
- `doc/spec/` 只保留行为契约和边界；字段、参数、默认值和算法细节链接到代码或运行时定义，不重复抄写。
- `doc/architecture/` 说明职责与接入限制；`doc/decisions/` 保留取舍和替代关系，ADR 按编号命名。
- `doc/assets/` 保存来源、许可与资源管理约定；`doc/roadmap/` 放待交付计划及精简里程碑，已完成的实施过程通过 Git 历史查阅。
- 修改行为同步修改对应规范。`prompts/`、`skills/` 的 Markdown 是运行时资产，不能当作普通文档精简。

## 必须保留的行为

RTS 优先及时行动：存在合理解释就结合当前战况选择并执行，简短反馈，不因阵营或同类候选不唯一要求确认。部分受阻先执行其余部分；不擅自扩大战略目标。见[产品边界](doc/spec/requirements.md)。修改相应模块前阅读专题规范：

- [命令并发](doc/spec/command-concurrency.md)：独立并行理解、按序绑定，生成不阻塞控制；停止、暂停、取消和换局使相关迟到结果失效。
- [生产](doc/spec/production-execution.md)与[取消](doc/spec/production-cancellation.md)：本局规则优先，复用必要前置，台账和实际产物不因重编或恢复重置；未知回执不盲目重发，只恢复确认属于自己的队列暂停。
- [集结](doc/spec/factory-rally.md)与[建筑选址](doc/spec/building-placement.md)：先脱离出口、抵达有效集结点并停车交接再指挥，矿车保留采矿；逐次入队复查开阔地，保留已批准的树石避让、到达容差和建筑间距。
- [掩护](doc/spec/cover-skill.md)：按真实规则速度预测跟随，最慢主体持续领行，补员独立追赶，严重脱队有限重聚；单侧耗尽转普通编队继续原任务，全灭结束保留队名，不补兵或复活旧任务。
- [攻击与战损](doc/spec/selected-attacks-and-sorties.md)、[防守基地](doc/spec/base-defense.md)：保留成员、敌人类别和地域，普通攻击不加射程门禁；基地无敌原地待命，蜘蛛离场不按超时判死亡，对局终态先于战损结算。
- [部署](doc/spec/unit-deployment.md)、[碾压](doc/spec/crushing.md)、[探路](doc/spec/scouting-skills.md)、[维修车](doc/spec/repair-vehicle-skill.md)：保留各自适用范围与完成条件，不能用通用重试扩大生产或攻击范围。

## 环境与启动

需要 Node ≥ 22.12、pnpm 9（具体锁定版本见 package.json）。游戏参考固定版本来自 [ra2web](https://github.com/ra2web/ra2web.github.io)，资源和模型正文不提交 Git。

```sh
pnpm install --frozen-lockfile
pnpm game:resources:install # 准备固定基础资源
pnpm game:site:install      # 准备固定站点与冰天雪地
pnpm speech:install         # 准备固定本地语音模型
pnpm game:resources:check   # 离线校验
pnpm speech:check
pnpm desktop               # Electron 开发入口
```

浏览器开发入口另需安装 Chromium：

```sh
pnpm playwright-install
pnpm companion
```

工作台为 `https://127.0.0.1:8787/commander/`，TCP 命令通道为 `127.0.0.1:8790`，终端 `help` 查看完整语法，`say <原话>` 模拟语音。玩家手动进入“单机 → 遭遇战”；当前单图配置自动绑定冰天雪地分区，无需 `map use ice`。

两个入口共用端口，不同时运行。Companion 重连保留浏览器与游戏，不刷新 iframe；`quit` 断连，`quit hard` 关闭浏览器。Electron 直接承载工作台，不启动外部 Chromium；关闭窗口或 `quit` 会保存、停止宿主并退出客户端。

开发数据在项目 `.runtime/`，Electron profile 为 `.runtime/desktop-profile/`，浏览器 profile 为 `.runtime/profile/`。正式包使用平台用户数据根，设置、归档和浏览器资料与安装资源分开，路径见 [Linux](doc/spec/linux-distribution.md)和[macOS / Windows](doc/spec/desktop-distribution.md)。

可用覆盖项：`RA2C_GAME_DIR`（开发站点，默认 `~/my/code/ra2web.github.io`）、`RA2C_GAME_RESOURCES_DIR`、`RA2C_SPEECH_MODEL_DIR`、`RA2C_PORT`、`RA2C_PROFILE`、`RA2C_DATA_ROOT`。`RA2C_PACK` 保留旧手动导入入口。正式包不要求本机存在相邻游戏检出目录。

模型 URL、Key、模型名在设置页编辑，保存只影响新请求，空 Key 保留原值；`.env` 兼容读取，本机 `.runtime/settings.json` 优先，不进入 Git 或调试包。具体见[模型设置](doc/spec/model-settings.md)。

## 构建与分发

```sh
pnpm build       # 准备/校验资源并编译正式运行目录
pnpm dist:linux  # 需 Docker；隔离 Linux x64 构建 AppImage、tar.gz
pnpm dist:check  # 干净 Linux 容器复查实际两种发行档
pnpm dist:mac    # macOS 本机当前架构 ZIP
pnpm dist:win    # Windows 本机当前架构 ZIP
```

原生依赖按目标系统和架构安装，macOS/Windows 不交叉打包；产物与 SHA256SUMS 在 `dist/`，不自动上传。基础游戏资源、冰天雪地和语音模型随包，但不等于全地图、全 MOD 离线。资源来源与许可分别见[游戏资源](doc/assets/game-resources.md)、[语音模型](doc/assets/speech-model.md)。

Deck 默认窗口 1280×800，普通桌面默认 1480×960 并适应工作区；`RA2C_STEAM_DECK=1/0` 可覆盖 Deck 判定。Linux 使用稳定用户级安装路径，macOS/Windows 仅 ZIP；安装和签名边界见对应分发规范。发布新内容时更新版本，不覆盖已交付版本的产物。

## 修改与验证

```sh
pnpm typecheck
pnpm test                 # 不访问云模型或真实游戏
pnpm ui:check             # 模拟工作台，无头 Chromium
pnpm desktop:check        # 隐藏 Electron、合成麦克风和生命周期
pnpm maps:check
pnpm prompts:check
pnpm capabilities:check
pnpm game-data:check
```

按修改范围选择检查。自动测试优先保留正常链路、具体故障和数据有效性，不大量锁定实验阈值；文档修改检查链接和一致性即可。

实机由用户观看。未经明确要求，不自动截图、录屏、生成测试报告、添加游戏内测试提示或移动镜头。`pnpm scenario:voice` 会调用云模型并操作真实游戏，须用户明确要求及只有基地车的新冰天雪地对局；同局续测用 `--resume`，不属于离线测试。

固定提示在 `prompts/templates/`，能力在 `prompts/capabilities/`，游戏和战术在 `prompts/games/`、`prompts/tactics/`，游戏 Skill 在 `skills/`。修改正文运行 `pnpm prompts:check`；改能力参数、默认值、ID 或绑定器，先运行 `pnpm capabilities:generate`，再检查能力、类型及相关测试并重启，禁止手改生成类型。新命令捕获完整版本，运行中不热替换。

`pnpm game-data:import` 从本地固定站点的规则、CSF 和 art 导入目录，随后运行 `pnpm game-data:check`、`pnpm prompts:check`。当前可造性仍以本局 API 为准，详见[完整目录](doc/spec/full-game-catalog.md)。

各本机执行能力可独立设置为 `script` 回退后运行 Companion：`RA2C_BUILDING_EXECUTOR`、`RA2C_MINING_EXECUTOR`、`RA2C_RELOCATION_EXECUTOR`、`RA2C_SCOUT_EXECUTOR`、`RA2C_REPAIR_EXECUTOR`、`RA2C_PRODUCTION_EXECUTOR`。回退保留目标 ID、真实产物和进度；无执行方式标记的旧目标继续原脚本，不自动迁移。探索/维修回退不替代生产开关。

## 对局资料工具

```sh
pnpm records:read --list
pnpm records:read <battle-id>
pnpm records:read <battle-id> --summary
pnpm records:export <battle-id>           # gzip 提交包
pnpm records:export <battle-id> --zip     # 与历史页相同的标准 ZIP
pnpm records:read <提交包路径> --summary
```

原档在 `.runtime/battles/`，终端提交包在 `.runtime/record-exports/`，不自动删除或上传。读取不需要游戏或 Companion，不恢复任务；只优化新增记录，不批量改写旧原档。格式、反馈落盘与隐私范围见[对局记录](doc/spec/battle-records.md)。运行恢复另用 `.runtime/state.json`，仅证明同局才恢复，不盲目重发未决提交。

## 地图工具

运行时读取分区不需要原始素材。查询与校验：

```sh
pnpm maps:check maps/ice/schemes/nanwang-0.1.0.json 39 82
```

图片导入需要 Python 3、Pillow，纹理校准另需 cryptography；均不属于程序运行依赖。下列路径按本机来源调整，更换地图或图片先核对哈希与投影：

```sh
python3 packages/maps/tools/verify_native_alignment.py --pack ~/Downloads/full-pack --map .runtime/maps/ice/mp32s8.map --image mp32s83.png --out .runtime/maps/ice/native-texture-check.json
python3 packages/maps/tools/export_playable_area.py --map .runtime/maps/ice/mp32s8.map --map-id ra2:mp32s8 --out maps/ice/playable-area.json
python3 packages/maps/tools/export_static_obstacles.py --map .runtime/maps/ice/mp32s8.map --rules ~/my/code/ra2web.github.io/res/overlay/rules.ini --art ~/my/code/ra2web.github.io/res/overlay/art.ini --map-id ra2:mp32s8 --out maps/ice/static-obstacles.json
python3 packages/maps/tools/import_regions.py --map .runtime/maps/ice/mp32s8.map --image mp32s83.png --annotations maps/ice/import/annotations.json --out maps/ice/schemes/nanwang-0.1.0.json --diagnostics .runtime/maps/ice/generated
```

分区身份、异形边界及提交规则见[地图规范](doc/spec/map-regions.md)。模块职责和代码入口集中在[架构总览](doc/architecture/overview.md)。
