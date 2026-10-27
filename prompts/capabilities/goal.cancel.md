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

取消指定目标，其余目标继续。使用当前 goals 的 ID 消除同名歧义；合理选择最近的匹配目标，不询问玩家内部 ID。

“停止造矿车”“把飞机制造停了”“取消制造四架飞机”使用本能力取消对应生产目标：立即停止追加，并撤销该目标尚在游戏队列中的数量，已造出的单位保留。其他目标仍需的共享科技前置保留。宿主按实际队列确认撤销，保留原始提交、产出和撤销记录，不重造已完成部分。旧已取消目标若 pendingSubmissions 大于零，仍可选择它撤销剩余队列；无需另发暂停全局或停止编队。
