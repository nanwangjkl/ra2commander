# 游戏规则与三层提示词

固定提示词是运行时资源，正文与结构化块都参与版本捕获，不能按普通说明文档删除。

| 层 | 来源 | 职责 |
| --- | --- | --- |
| 基础操作 | [capabilities/](../../prompts/capabilities/) | 可调用能力、参数和选择方式 |
| 游戏规则与战术 | [games/](../../prompts/games/)、[tactics/](../../prompts/tactics/) | 名称与角色、本局规则入口、目标内的执行约定 |
| 常规操作 Skill | [skills/](../../skills/) | 基础能力组合、成员准备、步骤和结束条件 |

[templates/](../../prompts/templates/) 定义理解、编译和修复契约。战术按当前目标和恢复阶段组合，不为每层分别请求模型；普通攻击不因战术说明重新引入射程拒绝。

游戏目录帮助发现未解锁项目和解释中文别名，实际科技、价格、电力、类型及可造性以本局公开 API 为准。已满足前置和已提交前置复用，不要求模型凭记忆列科技树。完整数据与导入边界见[游戏目录](full-game-catalog.md)。

每条命令捕获一套完整模板、能力、游戏、战术和 Skill 版本，同次准备、编译、绑定修正与重试始终复用。新命令可加载磁盘修改，运行中的脚本和 Skill 不热替换；重载失败保留上一套完整定义并报告文件错误。

加载器：[prompt-loader.ts](../../packages/command/src/prompt-loader.ts)。修改和生成规则见 [AGENTS.md](../../AGENTS.md)，行为取舍见 [ADR 009](../decisions/009-capability-definitions-and-prompt-layers.md)。
