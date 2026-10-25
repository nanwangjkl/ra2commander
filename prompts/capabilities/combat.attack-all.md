# 全图进攻

```capability
{
  "id": "combat.attack-all",
  "name": "全图进攻",
  "version": "1.0.0",
  "binder": "combat.attack-all",
  "owner": "formation",
  "parameters": {
    "formationId": {
      "type": "string",
      "description": "指定队伍；仅在玩家未指定队伍时省略"
    }
  }
}
```

玩家明确要求摧毁全图敌人时使用。指定编队则只指挥该队，省略才使用全部现有作战编队。根据后续可见敌人动态推进，不凭暂时无敌人宣布胜利，不额外生产部队。限定分区的清敌必须使用 combat.clear-region。
