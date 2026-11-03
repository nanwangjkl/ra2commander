# 开发文档

使用介绍见[项目 README](../README.md)，环境、运行和验证命令集中在 [AGENTS.md](../AGENTS.md)。这里保留代码之外需要解释的行为约定与设计取舍；参数、字段、默认值和完整接口以相应代码或运行时 Markdown 为准。

| 主题 | 阅读入口 |
| --- | --- |
| 产品与术语 | [产品边界](spec/requirements.md)、[领域术语](spec/CONTEXT.md) |
| 架构与接入 | [模块职责](architecture/overview.md)、[公开 API 限制](architecture/game-api.md)、[运行与恢复](architecture/runtime-control.md) |
| 命令与提示词 | [基础能力](spec/player-capabilities.md)、[并发](spec/command-concurrency.md)、[规则与战术](spec/game-rules-and-tactics.md)、[修复](spec/automatic-recovery.md) |
| 生产与基地 | [生产](spec/production-execution.md)、[取消](spec/production-cancellation.md)、[集结交接](spec/factory-rally.md)、[选址](spec/building-placement.md)、[建筑操作](spec/building-operations.md)、[搬迁](spec/base-relocation.md)、[采矿](spec/regional-mining.md) |
| 作战与 Skill | [攻击与战损](spec/selected-attacks-and-sorties.md)、[基地防守](spec/base-defense.md)、[部署](spec/unit-deployment.md)、[碾压](spec/crushing.md)、[掩护](spec/cover-skill.md)、[探路](spec/scouting-skills.md)、[维修车](spec/repair-vehicle-skill.md) |
| 地图与规则数据 | [地图分区](spec/map-regions.md)、[完整游戏目录](spec/full-game-catalog.md) |
| 工作台与分发 | [对局记录](spec/battle-records.md)、[模型设置](spec/model-settings.md)、[语音](spec/speech-input.md)、[游戏预置](spec/game-preferences.md)、[Linux](spec/linux-distribution.md)、[macOS / Windows](spec/desktop-distribution.md) |
| 资源来源 | [游戏资源](assets/game-resources.md)、[语音模型](assets/speech-model.md) |
| 设计经过 | [架构决策](decisions/README.md)、[开发里程碑](roadmap/development-history.md) |

已完成的分阶段实施方案已收拢到开发里程碑；完整旧方案可通过 Git 历史查阅。新的路线图只记录尚待决定或交付的工作，避免把旧“待验收”说明当作当前计划。
