# 指定分区采矿

```capability
{
  "id": "economy.gather",
  "name": "指定分区采矿",
  "version": "1.0.0",
  "binder": "economy.gather",
  "owner": "selected",
  "parameters": {
    "regionName": { "type": "string", "required": true, "description": "采矿的地图分区，例如一楼；矿格必须在真实异形边界内" },
    "quantity": { "type": "integer", "min": 1, "allowAll": true, "default": "all", "description": "使用现有矿车数量，缺省全部；不足不生产" },
    "unitIds": { "type": "integer[]", "min": 0, "minItems": 1, "description": "明确选择的现有矿车ID；仍校验矿车角色" },
    "formationId": { "type": "string", "description": "仅指挥这个已有编队中的矿车；不创建编队" }
  }
}
```

“所有矿车去一楼采矿”“让矿车采一楼的矿”使用此能力，不能改成 management.rally 或普通移动。宿主分批搜索指定分区公开可读的矿格，向各辆矿车下达 gather，返厂卸货由游戏继续处理；没有已知矿格时可以先进入该区寻找，抵达不等于采矿完成。
这是持续目标，不新增矿车、不要求编队。新目标由本机固定流程执行；已编队矿车沿用对应编队控制对象，未编队矿车由全局管理。改令仍按原编队整体替换，不额外生成转发脚本。多车可并行分配不同矿点。当前公开接口不区分彩矿和普通矿，原话提到彩矿时按区内任何已知矿格执行并简短说明，不拒绝、不假称优先彩矿。
