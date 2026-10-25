# 编队守区

```capability
{
  "id": "combat.hold",
  "name": "编队守区",
  "version": "1.0.0",
  "binder": "combat.hold",
  "owner": "formation",
  "parameters": {
    "formationId": {
      "type": "string",
      "description": "编队名称或数字别名；使用当前 formations",
      "required": true
    },
    "regionName": {
      "type": "string",
      "description": "要守卫的地图分区；省略则守住队伍附近"
    },
    "bounds": {
      "type": "integer[]",
      "description": "显式活动矩形 x1,y1,x2,y2",
      "min": 0,
      "minItems": 4,
      "maxItems": 4
    },
    "mode": {
      "type": "string",
      "description": "hold 守区；assault 允许区内攻击移动；move 只赶路",
      "enum": [
        "hold",
        "assault",
        "move"
      ],
      "default": "hold"
    },
    "retreatLoss": {
      "type": "number",
      "description": "明确要求战损回撤时的阵亡比例阈值，严格超过后回撤",
      "min": 0,
      "max": 0.999999
    },
    "retreatX": {
      "type": "integer",
      "description": "回撤点横坐标",
      "min": 0
    },
    "retreatY": {
      "type": "integer",
      "description": "回撤点纵坐标",
      "min": 0
    },
    "label": {
      "type": "string",
      "description": "可选任务标签"
    }
  }
}
```

持续守卫指定分区，按当前快照选择区内目标和站位。玩家明确战损回撤时同时填写比例与回撤坐标。守区持续到取消或改令，不因当前没有敌人就完成。普通攻击交给游戏处理接近与开火。
