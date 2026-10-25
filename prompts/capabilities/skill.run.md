# 调用常规行动 Skill

```capability
{
  "id": "skill.run", "name": "调用常规行动", "version": "1.0.0", "binder": "skill.run", "owner": "selected",
  "parameters": {
    "skillId": { "type": "string", "description": "Skill 索引中的 ID 或名称，例如 scout/探路", "required": true },
    "quantity": { "type": "integer", "description": "本次成员数量，省略使用 Skill 默认值", "min": 1 },
    "memberSource": { "type": "string", "description": "auto 优先现有未编队狗，无可用成员时新造；existing 只用现有；new 明确新造", "enum": ["auto", "existing", "new"] },
    "useExisting": { "type": "boolean", "description": "旧参数，true 等同 existing，false 等同 new；优先使用 memberSource" },
    "formationId": { "type": "string", "description": "可选的新侦察队名称，不能覆盖现有队；省略自动建立专用队" },
    "regionName": { "type": "string", "description": "可选的单个目标分区；省略探索当前地图全部分区" }
  }
}
```

“探路”使用 skill.run，skillId=scout。普通探路 memberSource=auto 或省略，默认优先现有未编队成员，没有时才新造；明确“用已有狗”填 existing，明确“新造/出狗探路”填 new。不要再独立输出重复的生产或编队命令。Skill 默认定义从索引加载，实际生产、建队、探索由宿主展开；不需要玩家逐步确认。
