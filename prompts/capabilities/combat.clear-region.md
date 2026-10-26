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

若队中有飞机，宿主沿用飞机单次出击规则：未装满弹等待，逐机满弹后攻击区内匹配敌人，每架实际发射一次即结束该机本次调度；不因目标未摧毁重复派出。混编中的地面成员继续区域攻击。

三个攻击能力由同一攻击要求绑定目标类别、真实地域、搜索方式与结束条件。地面队在看不见敌人时仍进入指定分区搜索；混有飞机时地面部分也保留这一行为，飞机独立等待装弹和单次出击。
