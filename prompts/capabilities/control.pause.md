# 暂停执行

```capability
{
  "id": "control.pause",
  "name": "暂停执行",
  "version": "1.0.0",
  "binder": "control.pause",
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

暂停对应脚本，保留目标与进度并取消待编译版本；恢复使用 control.resume。scope=units 时暂停所选单位所属脚本。暂停不保证单位停止游戏中已经接受的行动，需要停车时使用 control.stop。
