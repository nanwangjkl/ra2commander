# 取消常规行动

```capability
{
  "id": "skill.cancel", "name": "取消常规行动", "version": "1.0.0", "binder": "skill.cancel", "owner": "selected",
  "parameters": {
    "runId": { "type": "string", "description": "当前 Skill 运行 ID，优先使用事实列表中的 ID" },
    "skillId": { "type": "string", "description": "可选的 Skill ID；无运行 ID 时取消最近匹配的活动运行" },
    "all": { "type": "boolean", "description": "明确要求取消全部匹配运行时为 true", "default": false }
  }
}
```

“停止探路/取消侦察”取消对应 Skill 的后续步骤及未完成目标，停止其侦察队，其他全局目标继续。没有活动运行时简短说明，不额外建队或生产。

“取消维修/停止修理车任务”用 skillId=repair-vehicle；停止本次后续组件准备、组装和维修，不撤回已进游戏队列的生产。
