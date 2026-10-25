# 恢复执行

```capability
{
  "id": "control.resume",
  "name": "恢复执行",
  "version": "1.0.0",
  "binder": "control.resume",
  "owner": "selected",
  "parameters": {
    "scope": {
      "type": "string",
      "description": "操作范围：单个编队、全局管理、全部脚本、指定单位",
      "enum": [
        "formation",
        "global",
        "all",
        "units"
      ],
      "default": "formation"
    },
    "formationId": {
      "type": "string",
      "description": "scope=formation 时指定编队或已有任务标签"
    },
    "selector": {
      "type": "string",
      "description": "兵种原生名称/显示名，或 combat（战斗单位，排除矿车等辅助单位）、tanks、infantry、vehicles、aircraft、all",
      "default": "all"
    },
    "unitIds": {
      "type": "integer[]",
      "description": "明确的己方单位 ID；优先由宿主按 selector 选择",
      "min": 0,
      "minItems": 1
    }
  }
}
```

恢复指定对象保留的目标。存在待生效变更或生成失败时重新生成完整目标集合；已停止而取消的目标不会重放。可恢复全局或全部脚本，已完成目标继续保持完成。
