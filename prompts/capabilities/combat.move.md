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
    },
    "patrol": {
      "type": "boolean",
      "description": "沿本次有限路线巡逻、途中允许交战；普通赶路保持 false，回到最后一站后结束",
      "default": false
    }
  }
}
```

让指定编队前往 regionName 或 x/y；地名使用地图中已有分区。行军允许经过沿途其他区域，不扩大为全图攻击。调试入口可只绑定 bounds 并由原话指定移动细节。完成以存活成员实际抵达确认，不把下令当到达。

同句话按顺序给同一队多个目的地时，依次返回多个 combat.move，宿主合成一个路线目标，不相互替换；不同队仍各自独立。“从A巡逻到B，再到C，最后回基地附近”保留 A、B、C、基地附近四站，并设置 patrol=true；这是走完一次后结束的路线，不自动无限循环。regionName 可用“基地附近”，宿主按当前己方建造厂/基地车位置绑定，不能编造坐标。
