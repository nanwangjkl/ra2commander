# 出售己方建筑

```capability
{
  "id": "building.sell", "name": "出售建筑", "version": "1.0.0", "binder": "building.sell", "owner": "global",
  "parameters": {
    "selector": {"type":"string", "default":"all", "description":"all/全部表示现有全部己方建筑，也可填写具体建筑原生ID、中文名或角色名"},
    "unitIds": {"type":"integer[]", "min":0, "minItems":1, "description":"明确选择的现有己方建筑ID"},
    "quantity": {"type":"integer", "min":1, "allowAll":true, "default":"all", "description":"出售本次匹配建筑数量"}
  }
}
```

“卖掉所有的建筑”“出售电厂”使用本能力。只出售当前己方匹配建筑，不能出售车辆、敌方建筑或后续新建建筑。规则明确禁止出售的项目跳过并反馈，其余继续。以实际建筑离场确认本次操作完成，不把API已提交当成售出或承诺退款数额。出售接管所选建筑的旧维修/出售目标；其他生产与部队目标保留。

对象绑定后由本机固定流程执行，无需生成脚本；与其他全局目标共用暂停、取消和完成状态。
