# ra2commander

基于 [ra2web](https://github.com/ra2web/ra2web.github.io) 的独立开源本机语音指挥执行系统。玩家巡视战场并下达战略命令，AI 为每条命令生成独立 JavaScript，在玩家授权范围内执行战术微操和生产。

系统由命令编译器与实时任务运行时组成，具有战术执行层的自主性。主程序计划使用 TypeScript / Node.js；云端模型生成和修复代码，本机脚本持续观察战况并执行动作。

M1（公共 API 桥）与 M2 单队循环已实测：文本命令经云模型（DeepSeek/GLM 可切换）编译为独立任务脚本，经快照驱动持续执行——26 坦克守区、战损六成边界回撤、改令/撤权、故障隔离均通过真实对局与合成回放验证。运行方式见 [AGENTS.md](AGENTS.md)；首版范围与验证安排见[实施与验证计划](doc/roadmap/implementation-plan.md)。

## 文档导航

| 文档 | 回答的问题 |
| --- | --- |
| [产品需求](doc/spec/requirements.md) | 玩家能做什么，AI 获得哪些权限，任务应该如何表现？ |
| [架构设计](doc/architecture/overview.md) | 命令如何变成代码，各模块如何协作和持续执行？ |
| [游戏 API 调查](doc/architecture/game-api.md) | 现有接口能做到什么，依据和限制是什么？ |
| [实施与验证计划](doc/roadmap/implementation-plan.md) | 先做什么，如何测量和验证首版？ |
| [领域术语](doc/spec/CONTEXT.md) | 玩家、编队、战损、授权条件与 Skill 分别指什么？ |
| [架构决策记录](doc/decisions/README.md) | 为什么选择当前方案，有哪些取舍和后果？ |

建议先读产品需求，再读架构设计；实现游戏适配器时查 API 调查，评审设计取舍时查 ADR。产品需求记录已确认行为，架构文档中的技术方案仍需原型验证，API 调查保留参考版本与证据。
