# 玩家基础能力

能力以 [prompts/capabilities/](../../prompts/capabilities/) 的 Markdown 为唯一参数定义来源，同时驱动模型说明、输入校验和生成类型。宿主绑定器负责选择真实对象并建立目标；终端语法、直接能力、文字和语音共用这一入口。新增能力必须同时接通入口，不能只在底层存在。

## 选择与绑定约定

- “五辆坦克编入一队”选择现有单位，不隐含生产；默认优先未编队，明确“所有”按要求覆盖现有集合。数量不足先用可用部分并反馈。
- 名称、角色和原生 ID 共用游戏目录，具体型号不扩大成任意同类。泛称按本局规则与阵营选合理对象；“战斗单位”排除矿车、基地车、工程师及建筑，“车辆”仍可包含矿车。
- 一句话可以有多个独立操作。整句通常理解一次，绑定后的摘要才是实际执行说明；模型原始解释单独归档。按控制对象合并需要生成的脚本，固定能力不额外生成转发代码。
- 同句同队连续移动形成有序路线；后续改令替换该队当前任务。全局新增目标保留其他有效目标，取消按目标作用。
- 已选成员与有限生产来源固定，不持续吸收后来同型单位。交接期间不能被旧队或新队同时指挥。

停止、暂停、恢复及取消直接处理，不等待模型生成脚本；[并发](command-concurrency.md)、[生产取消](production-cancellation.md)及[修复](automatic-recovery.md)分别规定细节。

参数和默认值直接查能力 Markdown 与[生成类型](../../packages/command/src/capability-types.generated.ts)；绑定入口为 [capabilities/](../../apps/companion/src/capabilities/)，共用对象选择在 [unit-selection.ts](../../apps/companion/src/unit-selection.ts)。生成和检查命令见 [AGENTS.md](../../AGENTS.md)。
