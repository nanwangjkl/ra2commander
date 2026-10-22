# 架构决策记录

本项目基于 [ra2web](https://github.com/ra2web/ra2web.github.io) 设计独立的本机语音指挥伴随程序。

ADR 解释影响系统边界的选择：背景是什么、选了什么、为什么、需要承担哪些后果。产品行为以[产品需求](../spec/requirements.md)为准，实现方式见[架构设计](../architecture/overview.md)。

`accepted` 表示讨论中已确认该决策，不表示实现或验证已经完成；被后续记录替代的部分在各文件中注明。

| 编号 | 决策 | 主要取舍 |
| --- | --- | --- |
| [001](001-player-owns-strategic-decisions.md) | 战略决定权完全属于玩家 | 执行权限可核验，接受玩家未授权造成的阻塞 |
| [002](002-integrate-through-public-player-api.md) | 仅通过现有公共 API 接入 | 独立维护，承担公共接口的信息和控制缺口 |
| [003](003-voice-command-and-generated-micro-control.md) | 玩家只发语音命令，AI 编写全部微操 | 保留人类指挥与模型生成能力，承担代码质量验证成本 |
| [004](004-new-command-scripts-and-cross-battle-skills.md) | 每命令新脚本，跨局能力沉淀为 Skill（粒度由 006 替代） | 保留经审核的代码复用与跨局隔离原则 |
| [005](005-correct-engine-pursuit-through-public-api.md) | 通过监控纠正处理原生追击 | 保持现有 API 边界，接受可测量的短暂引擎偏移 |
| [006](006-script-per-control-owner.md) | 每编队与全局各一份脚本，统一整体替换 | 集中协调生产，保留对象独立改令及状态延续 |
| [007](007-action-first-command-interpretation.md) | 快速反应优先，命令按合理解释执行 | 接受误判与次优结果，玩家用后续命令纠正；替代 001、003 的默认歧义澄清规则 |

每份记录包含背景、决策、备选方案与取舍、影响和验证依据。未来改变已接受的边界时，新增记录并标明替代关系，避免把旧决策直接改成与原约束相反的结论。
