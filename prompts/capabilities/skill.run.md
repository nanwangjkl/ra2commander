# 调用常规行动 Skill

```capability
{
  "id": "skill.run", "name": "调用常规行动", "version": "1.0.0", "binder": "skill.run", "owner": "selected",
  "parameters": {
    "skillId": { "type": "string", "description": "Skill 索引中的 ID 或名称，例如 scout/探路、cover/掩护", "required": true },
    "quantity": { "type": "integer", "description": "本次成员/维修车成品数量，省略使用 Skill 默认值", "min": 1 },
    "memberSource": { "type": "string", "description": "按Skill定义选择来源：auto优先空闲现有，existing只用现有，new新造；造维修车用new", "enum": ["auto", "existing", "new"] },
    "useExisting": { "type": "boolean", "description": "旧参数，true 等同 existing，false 等同 new；优先使用 memberSource" },
    "formationId": { "type": "string", "description": "探路/维修车的专用编队可省略自动建立；cover指定受护队伍或承接同句已明确队名。维修车也可加入已有队并替换该队任务" },
    "followFormationId": { "type": "string", "description": "维修车可选的被支援编队，跟随并维修该队坦克" },
    "regionName": { "type": "string", "description": "可选的单个目标分区；省略探索当前地图全部分区" },
    "selector": { "type":"string", "description":"cover 的掩护成员兵种，如警犬、防空车" },
    "unitIds": { "type":"integer[]", "min":0,"minItems":1,"description":"cover 的现有掩护成员 ID" },
    "protectedSelector": { "type":"string", "description":"cover 的受护成员兵种；已有队伍可省略" },
    "protectedQuantity": { "type":"integer", "min":1,"description":"cover 的现有受护成员数量" },
    "protectedUnitIds": { "type":"integer[]", "min":0,"minItems":1,"description":"cover 的现有受护成员 ID" }
  }
}
```

“探路”使用 skill.run，skillId=scout。普通探路 memberSource=auto 或省略，默认优先现有未编队成员，没有时才新造；明确“用已有狗”填 existing，明确“新造/出狗探路”填 new。不要再独立输出重复的生产或编队命令。Skill 默认定义从索引加载，实际生产、建队、探索由宿主展开；不需要玩家逐步确认。

“造维修车/造修理车”调用 skill.run，skillId=repair-vehicle，memberSource=new，默认quantity=1；造两辆quantity=2（两辆IFV和两名工程师）。可用formationId指定成品编队，followFormationId指定支援对象。明确组装已有组件用auto/existing。生产、上车、并行维修由Skill完成，不另外输出重复生产。单纯要求现有维修队维修使用vehicle.repair，不新造。

“掩护”可调用skill.run，skillId=cover、formationId为双方共同所属队伍、selector为掩护兵种、quantity为掩护数量。也可直接调用formation.cover。同句已有编队时承接该队；受护和掩护单位合在同一队，不新建跟随队。未说生产默认existing，明确新造使用new，承接“造5辆坦克编入1队，2个IFV掩护”可用auto补差额；本句已单独生产的掩护成员会复用，不重复下单。明确受护成员时填写protectedSelector/protectedQuantity或protectedUnitIds；明确新造受护成员时，先用production.produce安排生产并编入同队，再安排掩护。普通移动、守区与攻击沿用角色和近身协同，防空优先就近空中目标，不让掩护成员独自追击。
