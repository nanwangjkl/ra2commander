# 生产单位或建筑

```capability
{
  "id": "production.produce",
  "name": "生产单位或建筑",
  "version": "1.2.0",
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
    "placementDirections": {
      "type": "string[]", "minItems": 1, "maxItems": 100,
      "enum": ["up", "down", "left", "right", "up-left", "up-right", "down-left", "down-right"],
      "description": "仅原话明确指定建筑方位时填写，按游戏画面上/下/左/右及四个斜向，数组顺序对应逐座建筑；上、左、下各一个填[up,left,down]，同一方向多座可只填一个方向"
    },
    "placementAnchor": {
      "type": "string", "description": "有方位要求时的参照物，如基地、矿场、战车工厂或已绑定分区；省略以基地为参照"
    },
    "placementRegion": {
      "type": "string", "description": "明确要求在某分区内建造时填写该分区名，例如一楼；独立于方位，必须在该异形分区内落地"
    },
    "afterRelocation": {
      "type": "boolean", "description": "同句要求基地搬迁完成后再建造时为true；未说明先后且与搬迁区域无关的项目不填"
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
默认生产由本机在真实规则准备后执行，不生成生产代码；显式 queues 同样由本机处理，只暂停其他明确允许的忙队列，避开本目标仍需的队列，生产结束后恢复自身暂停。玩家已暂停的队列不接管。生产状态、建筑就绪和出厂交接都按真实观察推进。
target 也可使用当前游戏目录的角色或别名，例如“坦克”“侦察犬”“战车工厂”；宿主按实际规则和可造项目绑定具体原生名称。
“制造5辆坦克并编入1队”是一个 quantity=5、formationId=1队 的生产调用。“5个坦克编入1队”使用 formation.assign。
理解摘要应说明实际兵种、数量和编队；完成以实际产物及交接确认，不以入队提交为完成。

只在本生产项目明确有方位要求时填写 placementDirections；没提方位就省略，沿用默认自动选址，不推测防御阵型。“在基地上方，左边和下边各造一个巨炮，补3个电厂”：巨炮 quantity=3、placementDirections=["up","left","down"]、placementAnchor="基地"；电厂 quantity=3，省略位置参数。不要只在 summary 写方位却从 params 丢掉。不同项目、前置建筑不继承该位置要求。
方位由宿主按画面投影换算并选合法落点，模型不计算格子坐标。多方向且数量更多时按顺序循环分配；同一方向多个建筑填一个方向即可。

“在一楼造一个矿场”必须填写 placementRegion="一楼"，不需要上下左右方位。分区无合法落点时等待，不改成默认位置；前置建筑不继承分区要求。
“搬基地到一楼，搬好后造矿场”同时调用 base.relocate 和本能力，并填 afterRelocation=true；分区内建造与同区搬迁也会自动关联。该建造目标及前置等待实际搬迁完成，其余不相关的生产仍可并行。
