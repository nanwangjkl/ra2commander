# 解除同队掩护

```capability
{"id":"formation.uncover","name":"解除同队掩护","version":"1.0.0","binder":"formation.uncover","owner":"formation","parameters":{"formationId":{"type":"string","required":true,"description":"需要解除掩护关系的队名"}}}
```

“取消1队掩护”只解除队内角色，成员保留在原队，原移动任务继续，不等于停止整队或解散。明确停止整队继续使用control.stop。
