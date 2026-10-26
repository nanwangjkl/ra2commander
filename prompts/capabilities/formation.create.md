# 建立编队

```capability
{
  "id": "formation.create",
  "name": "建立编队",
  "version": "1.0.0",
  "binder": "formation.create",
  "owner": "global",
  "parameters": {
    "formationId": {
      "type": "string",
      "description": "编队名称或数字别名；使用当前 formations",
      "required": true
    },
    "selector": {
      "type": "string",
      "description": "兵种原生名称/显示名，或 repairVehicles（已组装维修车）、combat（战斗单位，排除矿车等辅助单位）、tanks、infantry、vehicles、aircraft、all",
      "default": "all"
    },
    "unitIds": {
      "type": "integer[]",
      "description": "明确的己方单位 ID；优先由宿主按 selector 选择",
      "min": 0,
      "minItems": 1
    },
    "force": {
      "type": "boolean",
      "description": "明确要求从其他队伍调入时允许转编",
      "default": false
    }
  }
}
```

建立一个新命名编队；编队已存在时改用 formation.assign 或 formation.transfer。默认选择未编队成员；显式指定已有归属成员时需 force=true。玩家明确说“把所有坦克重新编成1队”可直接使用 formation.assign。

选择现有维修车可用 selector=repairVehicles（实际载有工程师的 IFV），不要用 FV 把未组装或搭载其他步兵的车混入。已在其他队的维修车转入新队用 formation.transfer；原队为空后不再控制这些成员。
