# 全图进攻

```capability
{
  "id": "combat.attack-all",
  "name": "全图进攻",
  "version": "1.3.0",
  "binder": "combat.attack-all",
  "owner": "formation",
  "parameters": {
    "splitTargets": {"type":"boolean","default":false,"description":"仅在明确要求分头、分散或各自攻击时为true；普通编队默认集中主目标"},
    "targetSelectors": {"type":"string[]","minItems":1,"description":"可选敌方兵种或类别并集；不填表示全部敌人"},
    "targetDomain": {"type":"string","enum":["all","air","ground"],"default":"all","description":"敌方空地范围，air 包括空中飞行兵"},
    "selector": { "type": "string", "description": "可选兵种选择，如 aircraft、tanks、combat；填写时可直接操作未编队成员" },
    "unitIds": { "type": "integer[]", "min": 0, "minItems": 1, "description": "明确选择的现有单位ID，不需要新建编队" },
    "formationId": {
      "type": "string",
      "description": "指定队伍；仅在玩家未指定队伍时省略"
    }
  }
}
```

玩家明确要求摧毁全图敌人时使用。指定编队则只指挥该队，省略才使用全部现有作战编队。根据后续可见敌人动态推进，不凭暂时无敌人宣布胜利，不额外生产部队。限定分区的清敌必须使用 combat.clear-region。

普通编队默认集中攻击一个主要目标，目标失效后继续选择下一目标；不要求先集结或进入射程。玩家明确要求“分头／各自攻击”才填 splitTargets=true；目标兵种和区域要求照常保留。
