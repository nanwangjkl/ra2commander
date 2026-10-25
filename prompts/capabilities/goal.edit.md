# 修改生产目标总量

```capability
{
  "id": "goal.edit",
  "name": "修改生产目标总量",
  "version": "1.0.0",
  "binder": "goal.edit",
  "owner": "global",
  "parameters": {
    "goalId": {
      "type": "string",
      "description": "当前生产目标 ID、标签或目标描述",
      "required": true
    },
    "quantity": {
      "type": "integer",
      "description": "修改后的本目标总量，包含已经提交和完成的部分",
      "min": 1,
      "max": 100,
      "required": true
    }
  }
}
```

修改已有生产目标的总量，保留累计提交和完成进度。例如已造2辆、目标改成5辆，最多再补3辆；这不是另下5辆。持续补电由电量事实决定，不用本能力修改固定总量。
