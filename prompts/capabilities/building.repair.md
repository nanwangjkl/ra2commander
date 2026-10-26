# 维修己方建筑

```capability
{
  "id": "building.repair", "name": "维修建筑", "version": "1.0.0", "binder": "building.repair", "owner": "global",
  "parameters": {
    "selector": {"type":"string", "default":"all", "description":"all/全部表示现有受损建筑，也可填写建筑原生ID、中文名或角色名"},
    "unitIds": {"type":"integer[]", "min":0, "minItems":1, "description":"明确选择的现有己方建筑ID"},
    "quantity": {"type":"integer", "min":1, "allowAll":true, "default":"all", "description":"维修本次匹配的受损建筑数量"}
  }
}
```

“维修受损的建筑”“修理所有建筑”使用本能力。使用游戏原生扳手维修，消耗游戏资金，无需维修车或工程师；缺钱时等待资金。只选择下令时已有的受损建筑，开启已开启的维修不会切成关闭。满血后确认完成；后续新建或再次受损不自动纳入。取消/暂停停止后续发令，游戏已开启的维修可继续。没有受损建筑时直接说明，无需生成脚本。
