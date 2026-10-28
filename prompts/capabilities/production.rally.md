# 生产建筑集结点

```capability
{
  "id": "production.rally", "name": "设置生产建筑集结点", "version": "1.0.0", "binder": "production.rally", "owner": "global",
  "parameters": {
    "selector": { "type": "string", "default": "warFactory", "description": "重工/warFactory、兵营、船厂、建筑原生ID或中文名；all表示全部支持集结点的现有生产建筑" },
    "unitIds": { "type": "integer[]", "min": 0, "minItems": 1, "description": "明确的现有己方生产建筑ID，不是出厂单位ID" },
    "quantity": { "type": "integer", "min": 1, "allowAll": true, "default": "all", "description": "设置本次匹配的建筑数量" },
    "regionName": { "type": "string", "description": "玩家指定的地图分区名称" },
    "x": { "type": "integer", "min": 0, "description": "有明确位置依据时使用的地图格横坐标" },
    "y": { "type": "integer", "min": 0, "description": "有明确位置依据时使用的地图格纵坐标" }
  }
}
```

“重工集结到三楼右下”“把战车工厂的集结点设在基地附近”使用本能力：设置生产建筑以后新出厂单位的目的地。不是让现有单位移动，不使用 management.rally，不追加生产，不编队。

按原话保留建筑选择、数量与目的地；没有明确建筑类别时默认重工。指代“这里”只有上下文有明确地图格坐标时才填写 x/y，不能凭空编造；没有可靠位置时由宿主在重工或兵营附近选点并反馈。船厂须给出明确目的地。

本机直接提交设置，不生成命令脚本。API 不能读回集结点，因此反馈为“设置指令已提交”，不宣称单位已经到达。普通造车也会由宿主初始化一次重工默认集结点；不需要模型额外插入此操作。

坦克与步兵在出厂并抵达其出生时的集结点前，宿主会保留产物记账并延后编队、掩护、攻击和组装；不要另发停车、移动或编队打断这个阶段。兵营与重工都支持默认集结，矿车保留游戏原生采矿流程。
