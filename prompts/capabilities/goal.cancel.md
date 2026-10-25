# 取消单个目标

```capability
{
  "id": "goal.cancel",
  "name": "取消单个目标",
  "version": "1.0.0",
  "binder": "goal.cancel",
  "owner": "selected",
  "parameters": {
    "goalId": {
      "type": "string",
      "description": "从当前 goals 中选择目标 ID；也接受明确的任务标签或目标描述",
      "required": true
    }
  }
}
```

取消指定目标的后续执行，其余全局目标继续。使用当前 goals 的 ID 消除同名歧义；合理选择最近的匹配目标，不询问玩家内部 ID。保留已提交生产记录，不重复生产或自动撤回队列。
