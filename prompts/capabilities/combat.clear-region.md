# 清理指定分区敌人

```capability
{
  "id": "combat.clear-region",
  "name": "清理指定分区敌人",
  "version": "1.0.0",
  "binder": "combat.clear-region",
  "owner": "formation",
  "parameters": {
    "formationId": {
      "type": "string",
      "description": "编队名称或数字别名；使用当前 formations",
      "required": true
    },
    "regionName": {
      "type": "string",
      "description": "要清理的地图分区",
      "required": true
    }
  }
}
```

“1队摧毁3楼右下所有敌人”只返回本能力，formationId=1队、regionName=三楼右下。不拆成移动加全图进攻，不调用其他编队。沿途可经过其他区域，主动攻击目标按真实异形分区筛选；到达或暂时看不见敌人都不代表分区清空。
