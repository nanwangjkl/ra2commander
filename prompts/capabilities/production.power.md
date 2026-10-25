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

仅在玩家明确要求“保持电量健康”等持续补电时建立此目标。“制造卫星，保持电量健康”分别调用 production.produce 与本能力。待建电厂和建筑耗电由宿主计算，持续运行到取消。
