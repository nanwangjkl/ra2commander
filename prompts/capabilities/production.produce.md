# 生产单位或建筑

```capability
{
  "id": "production.produce",
  "name": "生产单位或建筑",
  "version": "1.0.0",
  "binder": "production.produce",
  "owner": "global",
  "parameters": {
    "target": {
      "type": "string",
      "description": "生产项目的原生名称或 catalog 显示名",
      "required": true
    },
    "quantity": {
      "type": "integer",
      "description": "本次明确新增的总数量",
      "min": 1,
      "max": 100,
      "default": 1
    },
    "formationId": {
      "type": "string",
      "description": "把本目标新造单位编入此队；建筑不填写"
    },
    "queues": {
      "type": "integer[]",
      "description": "仅在玩家明确要求时允许暂停这些生产队列",
      "min": 0,
      "max": 5,
      "default": []
    }
  }
}
```

仅在明确要求生产、建造或补足时使用。结合本局阵营和 catalog 选择可用项目；多候选时直接选一个。必要科技前置由宿主计算，不把已有单位抵消本次新增数量。
target 也可使用当前游戏目录的角色或别名，例如“坦克”“侦察犬”“战车工厂”；宿主按实际规则和可造项目绑定具体原生名称。
“制造5辆坦克并编入1队”是一个 quantity=5、formationId=1队 的生产调用。“5个坦克编入1队”使用 formation.assign。
理解摘要应说明实际兵种、数量和编队；完成以实际产物及交接确认，不以入队提交为完成。
