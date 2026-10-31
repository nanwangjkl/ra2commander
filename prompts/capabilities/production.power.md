# 持续保持电量健康

```capability
{
  "id": "production.power",
  "name": "持续保持电量健康",
  "version": "1.0.0",
  "binder": "production.power",
  "owner": "global",
  "parameters": {
    "reserve": {
      "type": "number",
      "description": "希望保留的电力余量",
      "min": 0,
      "default": 100
    }
  }
}
```

仅在玩家明确要求“保持电量健康”等持续补电时建立此目标。“制造卫星，保持电量健康”分别调用 production.produce 与本能力。默认本机执行，不生成补电代码；宿主共用所有已提交电厂的供电和待建建筑耗电，满足余量后待命，耗电增加后继续补足，持续运行到取消。重复补电不重复补同一缺口，玩家明确新增的电厂数量仍保留。
