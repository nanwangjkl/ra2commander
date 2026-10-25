# 持续补员

```capability
{
  "id": "management.reinforce",
  "name": "持续补员",
  "version": "1.0.0",
  "binder": "management.reinforce",
  "owner": "global",
  "parameters": {
    "formationId": {
      "type": "string",
      "description": "编队名称或数字别名；使用当前 formations",
      "required": true
    },
    "target": {
      "type": "string",
      "description": "补员兵种原生名称或 catalog 显示名",
      "required": true
    },
    "targetSize": {
      "type": "integer",
      "description": "维持的该兵种数量",
      "min": 1,
      "required": true
    },
    "sourceFormationId": {
      "type": "string",
      "description": "明确允许的来源编队；省略只使用未编队单位"
    }
  }
}
```

持续把现有匹配成员补入指定编队，按实际缺额选择数量。默认仅使用未编队单位；玩家可明确来源编队。没有来源时等待，不自行生产。新造补员需玩家另行明确生产目标。
