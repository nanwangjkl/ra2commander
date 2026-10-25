# ra2commander

基于 [ra2web](https://github.com/ra2web/ra2web.github.io) 的独立开源本机语音指挥执行系统。玩家巡视战场并下达战略命令，AI 为每个编队和全局管理分别生成 JavaScript，在玩家授权范围内执行战术微操和生产。

设计上优先快速反应：命令有合理解释就行动，接受误判与次优结果，由玩家后续命令纠正。“造重工”按当前对局选择，不因未说明盟军或苏军而停下来询问。

每队一份脚本，全局一份脚本，共用生成、校验、替换和修复机制；目标与执行进度独立保存。系统由命令编译器与实时任务运行时组成，具有战术执行层的自主性。主程序计划使用 TypeScript / Node.js；云端模型生成和修复代码，本机脚本持续观察战况并执行动作。

浏览器工作台第一阶段已由用户验收通过：游戏位于左侧 iframe，右侧侧栏可调宽、折叠，全屏保留整个工作台，Companion 重启沿用当前对局。第二阶段已接入文本下令、原话、理解、实际选择与生成错误卡片，并按用户追加要求接入执行中、持续执行、已完成等状态，等待用户验收；当前默认自动绑定冰天雪地分区。完整历史恢复和真实录音按[分阶段计划](doc/roadmap/browser-workbench-and-voice.md)逐阶段验收后实施。

M1（公共 API 桥）与 M2 单队循环已实测：文本命令经云模型（DeepSeek/GLM 可切换）编译为独立任务脚本，经快照驱动持续执行——26 坦克守区、战损六成边界回撤、改令/撤权、故障隔离均通过真实对局与合成回放验证。当前已改为编队/全局脚本统一替换，支持多目标生产、转编与持续补员、v3 持久化；本轮自动化验证与实机记录见[改造方案](doc/roadmap/script-ownership-refactor.md)。宿主保留请求失效检查及 QuickJS 子进程隔离。运行方式与显式授权参数见 [AGENTS.md](AGENTS.md)；首版范围与验证安排见[实施与验证计划](doc/roadmap/implementation-plan.md)。

## 文档导航

| 文档 | 回答的问题 |
| --- | --- |
| [产品需求](doc/spec/requirements.md) | 玩家能做什么，AI 获得哪些权限，任务应该如何表现？ |
| [架构设计](doc/architecture/overview.md) | 命令如何变成代码，各模块如何协作和持续执行？ |
| [游戏 API 调查](doc/architecture/game-api.md) | 现有接口能做到什么，依据和限制是什么？ |
| [地图分区数据](doc/spec/map-regions.md) | 如何读取冰天雪地分区、核对坐标和提交其他方案？ |
| [实施与验证计划](doc/roadmap/implementation-plan.md) | 先做什么，如何测量和验证首版？ |
| [编队与全局脚本改造方案](doc/roadmap/script-ownership-refactor.md) | 如何改为每编队一份脚本、全局一份脚本，并统一替换？ |
| [六句模拟语音测试](doc/roadmap/voice-six-commands.md) | 展开、建设、造兵编队、地名移动、补电和进攻的实机效果如何？ |
| [工作台、侧栏与语音开发计划](doc/roadmap/browser-workbench-and-voice.md) | 如何分阶段加入游戏右侧命令栏和真实语音，逐阶段由玩家验收？ |
| [基础能力、提示词与 Skill 改造方案](doc/roadmap/capabilities-prompts-and-skills.md) | 如何统一能力入口、将提示词外置为 Markdown，并组合“探路”等常规操作？（A、B 已验收，C 已获准开始） |
| [玩家基础能力](doc/spec/player-capabilities.md) | 已接通哪些能力，Markdown 参数如何连接模型、类型与宿主，如何新增能力？ |
| [领域术语](doc/spec/CONTEXT.md) | 玩家、编队、战损、授权条件与 Skill 分别指什么？ |
| [架构决策记录](doc/decisions/README.md) | 为什么选择当前方案，有哪些取舍和后果？ |

建议先读产品需求，再读架构设计；实现游戏适配器时查 API 调查，评审设计取舍时查 ADR。产品需求记录已确认行为，架构文档中的技术方案仍需原型验证，API 调查保留参考版本与证据。
