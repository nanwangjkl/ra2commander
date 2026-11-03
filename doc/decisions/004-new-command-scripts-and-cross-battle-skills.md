---
status: accepted
date: 2026-10-06
partially_superseded_by: ['006', '009']
---

# 命令实例隔离与跨局 Skill 复用

最初选择每条命令生成新脚本和任务实例，以便明确当前对局、对象、目标和授权，避免修改长期任务时混淆取消与状态。经开发者验证的通用代码可成为版本化 Skill；单位 ID、进度和授权不能跨局继承。代价是增加生成、版本追踪及审核成本。

2026-10-21：[ADR 006](006-script-per-control-owner.md) 用每编队与全局控制对象替代“每命令一份脚本”的粒度，保留独立目标和执行事实。

2026-10-25：[ADR 009](009-capability-definitions-and-prompt-layers.md) 将 Skill 扩展为基础能力组合、步骤和结束条件，可附代码参考。复用的是定义，运行实例仍隔离；候选不自动入库，不能借 Skill 创建额外战略目标。

普通改令准备后切换，停止或取消使旧云回答失效的原则继续适用。现行实现见[架构](../architecture/overview.md)，交付经过见[开发里程碑](../roadmap/development-history.md)。
