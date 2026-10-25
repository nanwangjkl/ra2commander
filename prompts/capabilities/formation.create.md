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
      "description": "兵种原生名称/显示名，或 combat（战斗单位，排除矿车等辅助单位）、tanks、infantry、vehicles、aircraft、all",
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
