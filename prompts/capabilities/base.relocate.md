# 搬迁基地

```capability
{
  "id": "base.relocate",
  "name": "搬迁基地",
  "version": "1.0.0",
  "binder": "base.relocate",
  "owner": "global",
  "parameters": {
    "regionName": { "type": "string", "description": "目标地图分区，例如一楼；宿主选择分区内部落点" },
    "x": { "type": "integer", "min": 0, "description": "明确坐标时的目标横坐标，与 y 同时填写" },
    "y": { "type": "integer", "min": 0, "description": "明确坐标时的目标纵坐标，与 x 同时填写" },
    "unitId": { "type": "integer", "min": 0, "description": "明确指定的建造厂或基地车ID；省略时选择一座己方基地" }
  }
}
```

把现有建造厂收起为基地车，移至目标位置，重新展开并确认实际建造厂出现。已有基地车时直接移动和展开，不新增生产。不需要先建立作战编队，也不要把“基地车”当成编队名称。
“把基地搬到一楼，在一楼造矿场”：先返回 base.relocate(regionName=一楼)，再返回 production.produce(target=矿场, placementRegion=一楼, afterRelocation=true)。同句建造目标由宿主关联搬迁完成条件，不在旧基地提前执行。

对象与目的地绑定后由本机固定流程推进收起、移动、展开与身份确认，无需生成转发脚本；关联的建筑生产仍独立使用生成脚本。
