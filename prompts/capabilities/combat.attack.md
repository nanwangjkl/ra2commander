# 选择单位攻击

```capability
{
  "id":"combat.attack", "name":"选择单位攻击", "version":"1.0.0", "binder":"combat.attack", "owner":"selected",
  "parameters": {
    "selector":{"type":"string","default":"combat","description":"己方兵种/角色，如 aircraft、tanks、combat，或具体兵种名；不需要编队"},
    "unitIds":{"type":"integer[]","min":0,"minItems":1,"description":"明确选择的现有己方单位ID"},
    "formationId":{"type":"string","description":"可选已有或本句话正在建立的编队；只选择该队符合 selector 的成员"},
    "quantity":{"type":"integer","min":1,"allowAll":true,"default":"all","description":"本次选中数量，默认全部匹配成员"},
    "target":{"type":"string","enum":["enemies","base","units","buildings"],"default":"enemies","description":"敌方目标类型：全部敌人、基地、机动单位、建筑"},
    "targetId":{"type":"integer","min":0,"description":"明确指定的敌人ID"},
    "regionName":{"type":"string","description":"只攻击这个地图分区内的敌人；省略不限定分区"}
  }
}
```

“所有飞机攻击敌方基地”返回 selector=aircraft、target=base；“所有飞机攻击敌方单位”返回 selector=aircraft、target=units。不得额外创建数字编队、转编或把其他小队带入攻击。宿主保留实际归属，未编队成员走全局，已有队伍分别更新该队脚本。
飞机默认一次出击：装弹未满保持 pending，不发攻击或移动；满弹后自动出击，每架实际发射一次后完成自己的任务，不要求摧毁目标。已满弹的先出击，不等其他飞机。地面单位按可见敌人持续攻击。没有敌人时观察，不编造隐藏位置，不额外生产。

选择范围在下令时捕获。若同句明确先生产/编队再攻击，可等待这些具体准备目标的实际产物与交接，即使已有首批成员也继续接入本次其余成员；不能把后来无关生产的同型单位自动纳入。指定 unitIds 时只操作这些 ID。
