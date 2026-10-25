# 解散编队

```capability
{
  "id": "formation.dissolve",
  "name": "解散编队",
  "version": "1.0.0",
  "binder": "formation.dissolve",
  "owner": "global",
  "parameters": {
    "formationId": {
      "type": "string",
      "description": "编队名称或数字别名；使用当前 formations",
      "required": true
    }
  }
}
```

解散指定编队，成员回到未编队状态；交接停车由宿主处理。解散管理进入全局脚本，不解散其他队伍。
