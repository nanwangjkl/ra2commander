# 未编队单位集结

```capability
{
  "id": "management.rally",
  "name": "未编队单位集结",
  "version": "1.0.0",
  "binder": "management.rally",
  "owner": "global",
  "parameters": {
    "selector": {
      "type": "string",
      "description": "兵种原生名称/显示名，或 repairVehicles（已组装维修车）、combat（战斗单位，排除矿车等辅助单位）、tanks、infantry、vehicles、aircraft、all",
      "default": "all"
    },
    "unitIds": {
      "type": "integer[]",
      "description": "明确的己方单位 ID；优先由宿主按 selector 选择",
      "min": 0,
      "minItems": 1
    },
    "regionName": {
      "type": "string",
      "description": "已绑定的地图分区名称或别名"
    },
    "x": {
      "type": "integer",
      "description": "目标横坐标",
      "min": 0
    },
    "y": {
      "type": "integer",
      "description": "目标纵坐标",
      "min": 0
    }
  }
}
```

让接令时选中的未编队单位移动到指定分区或 x/y。已编队成员由对应编队脚本指挥，不抢占；只有未编队可用部分时先执行并反馈。完成以成员实际到达确认。
