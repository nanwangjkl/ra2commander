# 指挥现有编队探索地图

```capability
{
  "id": "map.explore", "name": "编队探索地图", "version": "1.0.0", "binder": "map.explore", "owner": "formation",
  "parameters": {
    "formationId": { "type": "string", "description": "使用已有编队；普通探路应优先调用 scout Skill", "required": true },
    "regionName": { "type": "string", "description": "可选单个地图分区，省略探索当前地图全部分区" }
  }
}
```

仅使用已有编队，不新增生产。按真实揭示覆盖探索分区，每个目标分区分别达到至少 60% 才达标，全部目标分区达标后完成；全图平均 60% 不代表完成。优先区域中心及中心附近有效落点，达标区不再分配落点；走到中心仍按实际揭开覆盖确认，不凭到达直接宣布达标。成员分头工作，遇阻更换目标，无法覆盖的部分如实记录；没有攻击或无限补员权限。对该队下达新命令会替换探索任务。
