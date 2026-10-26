# 上车

```capability
{
  "id": "transport.enter", "name": "步兵上车", "version": "1.0.0", "binder": "transport.enter", "owner": "global",
  "parameters": {
    "unitIds": { "type": "integer[]", "minItems": 1, "min": 1, "required": true, "description": "现有未编队步兵ID" },
    "transportId": { "type": "integer", "required": true, "min": 1, "description": "己方有空位载具ID" }
  }
}
```

明确要求现有步兵进入指定载具时调用。不新增生产；完成以载员ID确认。整套维修车优先调用 skill.run，不拆成重复操作。
