# 建筑维修与出售

建筑操作选定当前己方对象，本机持续推进，不需要编队或维修车。

维修开启游戏原生扳手，缺钱等待、满血完成；重复命令不能把已开启维修反向关闭。出售仅处理本次选定的可售建筑，跳过禁售项，不包含车辆或后来新建筑，以实际离场确认。

动作回执不等于完成；目标保存已发令和实际成果，同局恢复不重复切换。取消只停止后续调度，不能撤回游戏已接受的出售或维修。单个目标失败不阻止其他有效操作。

实现：[building-operations.ts](../../apps/companion/src/building-operations.ts)、[building.ts](../../packages/runtime/src/building.ts)。维修车另见[维修车 Skill](repair-vehicle-skill.md)。
