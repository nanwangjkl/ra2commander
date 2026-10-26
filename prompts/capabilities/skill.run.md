# 调用常规行动 Skill

```capability
{
  "id": "skill.run", "name": "调用常规行动", "version": "1.0.0", "binder": "skill.run", "owner": "selected",
  "parameters": {
    "skillId": { "type": "string", "description": "Skill 索引中的 ID 或名称，例如 scout/探路", "required": true },
    "quantity": { "type": "integer", "description": "本次成员/维修车成品数量，省略使用 Skill 默认值", "min": 1 },
    "memberSource": { "type": "string", "description": "按Skill定义选择来源：auto优先空闲现有，existing只用现有，new新造；造维修车用new", "enum": ["auto", "existing", "new"] },
    "useExisting": { "type": "boolean", "description": "旧参数，true 等同 existing，false 等同 new；优先使用 memberSource" },
    "formationId": { "type": "string", "description": "本次专用编队名称；省略自动建立。维修车也可加入指定已有队并替换该队任务" },
    "followFormationId": { "type": "string", "description": "维修车可选的被支援编队，跟随并维修该队坦克" },
    "regionName": { "type": "string", "description": "可选的单个目标分区；省略探索当前地图全部分区" }
  }
}
```

“探路”使用 skill.run，skillId=scout。普通探路 memberSource=auto 或省略，默认优先现有未编队成员，没有时才新造；明确“用已有狗”填 existing，明确“新造/出狗探路”填 new。不要再独立输出重复的生产或编队命令。Skill 默认定义从索引加载，实际生产、建队、探索由宿主展开；不需要玩家逐步确认。

“造维修车/造修理车”调用 skill.run，skillId=repair-vehicle，memberSource=new，默认quantity=1；造两辆quantity=2（两辆IFV和两名工程师）。可用formationId指定成品编队，followFormationId指定支援对象。明确组装已有组件用auto/existing。生产、上车、并行维修由Skill完成，不另外输出重复生产。单纯要求现有维修队维修使用vehicle.repair，不新造。
