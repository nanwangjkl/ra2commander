# 架构决策记录

本项目基于 [ra2web](https://github.com/ra2web/ra2web.github.io) 设计独立的本机语音指挥伴随程序。

ADR 解释影响系统边界的选择：背景是什么、选了什么、为什么、需要承担哪些后果。产品行为以[产品需求](../spec/requirements.md)为准，实现方式见[架构设计](../architecture/overview.md)。

所有记录状态为 `accepted`，表示需求讨论中已确认该决策，不表示实现或验证已经完成。

| 编号 | 决策 | 主要取舍 |
| --- | --- | --- |
| [001](001-player-owns-strategic-decisions.md) | 战略决定权完全属于玩家 | 执行权限可核验，接受玩家未授权造成的阻塞 |
| [002](002-integrate-through-public-player-api.md) | 仅通过现有公共 API 接入 | 独立维护，承担公共接口的信息和控制缺口 |
| [003](003-voice-command-and-generated-micro-control.md) | 玩家只发语音命令，AI 编写全部微操 | 保留人类指挥与模型生成能力，承担代码质量验证成本 |
| [004](004-new-command-scripts-and-cross-battle-skills.md) | 每命令新脚本，跨局能力沉淀为 Skill | 明确任务和状态归属，保留经审核的代码复用 |
| [005](005-correct-engine-pursuit-through-public-api.md) | 通过监控纠正处理原生追击 | 保持现有 API 边界，接受可测量的短暂引擎偏移 |

每份记录包含背景、决策、备选方案与取舍、影响和验证依据。未来改变已接受的边界时，新增记录并标明替代关系，避免把旧决策直接改成与原约束相反的结论。
