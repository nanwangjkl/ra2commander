# 架构决策记录

ADR 解释影响系统边界的选择：背景是什么、选了什么、为什么、需要承担哪些后果。产品行为以[产品需求](../spec/requirements.md)为准，实现方式见[架构设计](../architecture/overview.md)。

`accepted` 表示决策被确认，不代表已交付。旧决策按当时背景阅读，替代关系在各文件注明；现行行为见专题规范，交付状态见[开发里程碑](../roadmap/development-history.md)。

| 编号 | 决策 | 主要取舍 |
| --- | --- | --- |
| [001](001-player-owns-strategic-decisions.md) | 战略决定权完全属于玩家 | 执行权限可核验，接受玩家未授权造成的阻塞 |
| [002](002-integrate-through-public-player-api.md) | 仅通过现有公共 API 接入 | 独立维护，承担公共接口的信息和控制缺口 |
| [003](003-voice-command-and-generated-micro-control.md) | 语音指挥与本机执行生成脚本（部分范围已修订） | 保留人类指挥与模型生成能力，承担代码质量验证成本 |
| [004](004-new-command-scripts-and-cross-battle-skills.md) | 命令实例隔离与 Skill 复用（粒度由 006 替代） | 保留经审核的代码复用与跨局隔离原则 |
| [005](005-correct-engine-pursuit-through-public-api.md) | 通过监控纠正处理原生追击 | 保持现有 API 边界，接受可测量的短暂引擎偏移 |
| [006](006-script-per-control-owner.md) | 每编队与全局各一份脚本，统一整体替换 | 集中协调生产，保留对象独立改令及状态延续 |
| [007](007-action-first-command-interpretation.md) | 快速反应优先，命令按合理解释执行 | 接受误判与次优结果，玩家用后续命令纠正；替代 001、003 的默认歧义澄清规则 |
| [008](008-command-actions-and-engine-attack.md) | 分开表达现有单位编队与区域清敌，攻击射程由游戏处理 | 解释与执行计划同源；按实际分区选敌，普通攻击不被射程预判拦截 |
| [009](009-capability-definitions-and-prompt-layers.md) | 统一基础能力定义、入口与三层提示组织 | Markdown 同时驱动模型说明、参数校验和类型生成；宿主保留绑定，Skill 扩展为常规行动定义 |
| [010](010-native-production-preparation.md) | 生产的规则准备独立于代码生成 | 复用生产台账与提交，逐目标准备、本机补电及队列控制；旧脚本共存 |

未来改变已接受的边界时，新增决策并标明替代关系；文档精简保留当时背景，不把旧方案改写成已经交付的能力。
