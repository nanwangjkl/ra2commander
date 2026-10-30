# 安排同队掩护

```capability
{
  "id":"formation.cover","name":"安排同队掩护","version":"1.1.0","binder":"formation.cover","owner":"global",
  "parameters":{
    "formationId":{"type":"string","required":true,"description":"双方共同所属的编队；承接同句话已指定的队名"},
    "selector":{"type":"string","default":"all","description":"掩护成员的兵种或类别，如警犬、防空车"},
    "quantity":{"type":"integer","min":1,"allowAll":true,"default":"all","description":"本次掩护成员数量，是否生产由memberSource决定"},
    "memberSource":{"type":"string","enum":["existing","auto","new"],"default":"existing","description":"existing使用现有及本句已明确生产的成员；new明确新造掩护成员；auto优先现有，不足时生产差额。未提生产用existing"},
    "unitIds":{"type":"integer[]","min":0,"minItems":1,"description":"可明确指定现有掩护成员 ID"},
    "protectedSelector":{"type":"string","description":"被掩护成员兵种；已有编队或同句已编队时可省略"},
    "protectedQuantity":{"type":"integer","min":1,"description":"被掩护成员数量；同句明确生产的批次先计入"},
    "protectedUnitIds":{"type":"integer[]","min":0,"minItems":1,"description":"可明确指定被掩护成员 ID"}
  }
}
```

“5辆坦克组成1队，5个警犬掩护”：可一次调用本能力，formationId=1队、protectedSelector=tanks、protectedQuantity=5、selector=警犬、quantity=5；也可先formation.assign选坦克再formation.cover选狗，宿主合并为同一队。坦克和狗都是真实1队成员，不另建护卫队，不额外生产。数量不足先使用可用部分。

“给1队加3辆防空车掩护”选择已有防空车加入同队；“1队里的防空车负责掩护”调整队内职责。原有掩护成员保留。掩护者可能更快也可能更慢；全队按最慢成员及真实位置协同行军，不按角色猜速度。后续移动保留角色；取消掩护使用formation.uncover。

明确“造2辆IFV掩护1队”使用memberSource=new；“造5辆坦克编入1队，2个IFV掩护”使用memberSource=auto，先复用现有掩护成员、不足时补足本次数量。若本句已经有IFV生产并编入1队，宿主复用该生产目标，不另造一批。被掩护成员可承接本句正在生产并编队的坦克。未说生产时默认existing，不因缺员自动补造。

“造5个坦克，2个防空车掩护”没有指定队号时，为双方选择一个未占用的数字队并简短反馈；两条 production.produce 填同一 formationId，再调用 formation.cover，明确 protectedSelector=tanks、protectedQuantity=5、selector=antiAirVehicle、quantity=2。宿主也会在本句内按双方兵种及数量补齐遗漏的生产队号，复用原批次。同句已经明确的生产先计入人数，现有同型单位只补不足；不把其他队伍或无关兵种的生产接入掩护。

角色在生产真实完成、停车交接后逐个生效，后续移动、守区与攻击都维持协同。掩护保持近身和威胁前侧，当前站位可开火才支援，防空优先射程内空中敌人，不离队追击。
