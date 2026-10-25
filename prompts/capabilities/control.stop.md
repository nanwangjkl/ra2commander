# 停止执行

```capability
{
  "id": "control.stop",
  "name": "停止执行",
  "version": "1.0.0",
  "binder": "control.stop",
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

立即停止指定编队、全局、全部脚本或所选单位，并撤销相应待编译命令与未完成目标。“1队停止”使用 scope=formation，“全部停止”使用 scope=all。成员停车交给宿主，已投入游戏的生产不自动撤回。停止完成后原目标不会自动恢复；临时等待应使用 control.pause。
