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
      "description": "兵种原生名称/显示名，或 repairVehicles（已组装维修车）、combat（战斗单位，排除矿车等辅助单位）、tanks、infantry、vehicles、aircraft、all",
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

“所有战斗单位编入1队”只用一个 selector=combat 调用，不拆成 tanks 和 vehicles。combat 按当前武器与辅助角色识别，包含灰熊和多功能步兵车，排除矿车、基地车、工程师和建筑。同句话对同一队的多个选择会合并并去重，再统一交接；同句后续移动可等待该队建立。

选择现有维修车可用 selector=repairVehicles（实际载有工程师的 IFV），不要用 FV 把未组装或搭载其他步兵的车混入。已在其他队的维修车转入新队用 formation.transfer；原队为空后不再控制这些成员。
