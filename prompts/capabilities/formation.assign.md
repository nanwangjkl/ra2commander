# 把现有单位编入队伍

```capability
{
  "id": "formation.assign",
  "name": "把现有单位编入队伍",
  "version": "1.0.0",
  "binder": "formation.assign",
  "owner": "global",
  "parameters": {
    "formationId": {
      "type": "string",
      "description": "编队名称或数字别名；使用当前 formations",
      "required": true
    },
    "selector": {
      "type": "string",
      "description": "兵种原生名称/显示名，或 tanks、infantry、vehicles、aircraft、all",
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
    }
  }
}
```

使用现有单位；目标编队不存在时建立，存在时转入。按数量编入优先未编队单位；数量不足先编入可用部分并反馈缺额，禁止把不足转换为生产。
“5个坦克编入1队”：selector=tanks、quantity=5、formationId=1队。“所有坦克编入1队”：selector=tanks、quantity=all，可合并其他队伍。已在目标队内的不重复转入。也支持步兵、车辆、空军及具体兵种。
摘要来自实际选中成员，明确这是现有单位。完成以成员归属与停车交接确认。
