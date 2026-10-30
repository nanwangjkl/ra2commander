# 维修支援

```capability
{
  "id": "vehicle.repair", "name": "维修车持续维修", "version": "1.0.0", "binder": "vehicle.repair", "owner": "selected",
  "parameters": {
    "formationId": { "type": "string", "required": true, "description": "包含现有维修车的编队，不新增生产" },
    "followFormationId": { "type": "string", "description": "可选的被支援编队，只维修该队坦克并跟随" },
    "targetId": { "type": "integer", "min": 1, "description": "明确指定的己方坦克ID；省略自动选择受损坦克" }
  }
}
```

“1队修理受损坦克”“让维修队跟随2队维修”调用本能力，默认全体己方受损坦克，多车分头并行。只更新维修编队当前任务，不替换被支援编队。默认由本机按真实载员和血量发令，无需生成维修代码。明确“造/组装维修车”调用 skill.run，skillId=repair-vehicle；不要把单纯维修理解成重新生产。
