# 转移编队成员

```capability
{
  "id": "formation.transfer",
  "name": "转移编队成员",
  "version": "1.0.0",
  "binder": "formation.transfer",
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
    "quantity": {
      "type": "integer",
      "description": "选择现有单位的数量；all 表示全部匹配单位",
      "min": 1,
      "allowAll": true,
      "default": "all"
    },
    "unitIds": {
      "type": "integer[]",
      "description": "明确的己方单位 ID；优先由宿主按 selector 选择",
      "min": 0,
      "minItems": 1
    },
    "sourceFormationId": {
      "type": "string",
      "description": "只从此编队选择成员；省略则从现有匹配单位选择"
    }
  }
}
```

把现有单位转入已存在的目标编队，不生产。可按来源编队、兵种或明确单位选择；例如“2队的3个步兵转入1队”。原队剩余成员继续原任务。完成以交接确认。
