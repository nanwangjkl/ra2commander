# ra2commander

基于 [ra2web](https://github.com/ra2web/ra2web.github.io) 的独立开源本机语音指挥执行系统。玩家巡视战场并下达战略命令，AI 为每个编队和全局管理分别生成 JavaScript，在玩家授权范围内执行战术微操和生产。

设计上优先快速反应：命令有合理解释就行动，接受误判与次优结果，由玩家后续命令纠正。“造重工”按当前对局选择，不因未说明盟军或苏军而停下来询问。

每队一份脚本，全局一份脚本，共用生成、校验、替换和修复机制；目标与执行进度独立保存。系统由命令编译器与实时任务运行时组成，具有战术执行层的自主性。主程序计划使用 TypeScript / Node.js；云端模型生成和修复代码，本机脚本持续观察战况并执行动作。

语音绑定失败会单独重决策；执行错误或具备条件却长期没有进展时，携带实际动作与结果限次修复脚本。见[自动恢复](doc/spec/automatic-recovery.md)。

浏览器工作台第一阶段已由用户验收通过：游戏位于左侧 iframe，右侧侧栏可调宽、折叠，全屏保留整个工作台，Companion 重启沿用当前对局。侧栏已接入文本下令、原话、理解、实际选择、执行/完成状态与错误；追加的逐命令反馈、本机归档及侧栏精简已由用户验收通过，当前默认自动绑定冰天雪地分区。对局资料自动归档到本机，关闭游戏后仍保留供开发复盘，游戏侧栏不提供历史管理或代码预览。真实录音按[分阶段计划](doc/roadmap/browser-workbench-and-voice.md)另行验收后实施。

M1（公共 API 桥）与 M2 单队循环已实测：文本命令经云模型（DeepSeek/GLM 可切换）编译为独立任务脚本，经快照驱动持续执行——26 坦克守区、战损六成边界回撤、改令/撤权、故障隔离均通过真实对局与合成回放验证。当前已改为编队/全局脚本统一替换，支持多目标生产、转编与持续补员、v4 持久化（兼容 v3）；本轮自动化验证与实机记录见[改造方案](doc/roadmap/script-ownership-refactor.md)。宿主保留请求失效检查及 QuickJS 子进程隔离。运行方式与显式授权参数见 [AGENTS.md](AGENTS.md)；首版范围与验证安排见[实施与验证计划](doc/roadmap/implementation-plan.md)。

## 文档导航

| 文档 | 回答的问题 |
| --- | --- |
| [产品需求](doc/spec/requirements.md) | 玩家能做什么，AI 获得哪些权限，任务应该如何表现？ |
| [架构设计](doc/architecture/overview.md) | 命令如何变成代码，各模块如何协作和持续执行？ |
| [游戏 API 调查](doc/architecture/game-api.md) | 现有接口能做到什么，依据和限制是什么？ |
| [地图分区数据](doc/spec/map-regions.md) | 如何读取冰天雪地分区、核对坐标和提交其他方案？ |
| [实施与验证计划](doc/roadmap/implementation-plan.md) | 先做什么，如何测量和验证首版？ |
| [编队与全局脚本改造方案](doc/roadmap/script-ownership-refactor.md) | 如何改为每编队一份脚本、全局一份脚本，并统一替换？ |
| [运行时整理与响应速度改造计划](doc/roadmap/runtime-simplification.md) | 如何分阶段改善调度、目标扩展、对象选择、归档和模型调用？（阶段 1 已验收，阶段 2 已获准） |
| [六句模拟语音测试](doc/roadmap/voice-six-commands.md) | 展开、建设、造兵编队、地名移动、补电和进攻的实机效果如何？ |
| [工作台、侧栏与语音开发计划](doc/roadmap/browser-workbench-and-voice.md) | 如何分阶段加入游戏右侧命令栏和真实语音，逐阶段由玩家验收？ |
| [探路 Skill](doc/spec/scouting-skills.md) | 如何配置、调用、取消和恢复探路，以及如何确认真实探索覆盖？ |
| [维修车 Skill](doc/spec/repair-vehicle-skill.md) | 如何生产、组装维修车，按坦克血量选择目标并让多车并行维修？ |
| [基础能力、提示词与 Skill 改造方案](doc/roadmap/capabilities-prompts-and-skills.md) | 如何统一能力入口、将提示词外置为 Markdown，并组合“探路”等常规操作？（A～C 已验收，D 已实现待实机验收） |
| [玩家基础能力](doc/spec/player-capabilities.md) | 已接通哪些能力，Markdown 参数如何连接模型、类型与宿主，如何新增能力？ |
| [建筑方位要求](doc/spec/building-placement.md) | 如何保留明确的上、下、左、右要求，选择合法落点并确认实际位置？ |
| [建筑维修与出售](doc/spec/building-operations.md) | 如何直接使用原生扳手维修，或出售指定己方建筑，并确认实际效果？ |
| [基地搬迁与区域建造](doc/spec/base-relocation.md) | 如何收起基地、搬至分区重新展开，并等待搬迁后在区域内建造？ |
| [指定分区采矿](doc/spec/regional-mining.md) | 如何指挥现有矿车采区内矿石，并保留正常采集、返厂与卸货？ |
| [现有单位攻击与飞机出击](doc/spec/selected-attacks-and-sorties.md) | 如何不建队直接攻击，并让飞机等待装弹、投弹一次后完成？ |
| [游戏规则与战术约定](doc/spec/game-rules-and-tactics.md) | 如何按真实规则选择阵营项目、复用前置，并按目标组合战术提示？ |
| [完整游戏目录与通用科技树](doc/spec/full-game-catalog.md) | 如何识别尚未解锁的单位与建筑，导入中文名称并自动补齐前置和生产设施？ |
| [对局记录与命令反馈](doc/spec/battle-records.md) | 如何提交命令反馈，并在本机归档理解、代码和实际成果供开发复盘？ |
| [领域术语](doc/spec/CONTEXT.md) | 玩家、编队、战损、授权条件与 Skill 分别指什么？ |
| [架构决策记录](doc/decisions/README.md) | 为什么选择当前方案，有哪些取舍和后果？ |

建议先读产品需求，再读架构设计；实现游戏适配器时查 API 调查，评审设计取舍时查 ADR。产品需求记录已确认行为，架构文档中的技术方案仍需原型验证，API 调查保留参考版本与证据。
