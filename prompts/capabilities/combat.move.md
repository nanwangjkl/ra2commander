# 编队移动

```capability
{
  "id": "combat.move",
  "name": "编队移动",
  "version": "1.0.0",
  "binder": "combat.move",
  "owner": "formation",
  "parameters": {
    "formationId": {
      "type": "string",
      "description": "编队名称或数字别名；使用当前 formations",
      "required": true
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
    },
    "bounds": {
      "type": "integer[]",
      "description": "调试入口可提供活动矩形 x1,y1,x2,y2",
      "min": 0,
      "minItems": 4,
      "maxItems": 4
    },
    "label": {
      "type": "string",
      "description": "可选任务标签"
    }
  }
}
```

让指定编队前往 regionName 或 x/y；地名使用地图中已有分区。行军允许经过沿途其他区域，不扩大为全图攻击。调试入口可只绑定 bounds 并由原话指定移动细节。完成以存活成员实际抵达确认，不把下令当到达。
