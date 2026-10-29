# 单位部署与解除部署

```capability
{
  "id": "unit.deploy", "name": "单位部署与解除部署", "version": "1.0.0", "binder": "unit.deploy", "owner": "selected",
  "parameters": {
    "selector": { "type": "string", "default": "all", "description": "兵种原生ID、中文名或类别；只操作有部署姿态的成员" },
    "unitIds": { "type": "integer[]", "min": 0, "minItems": 1, "description": "明确选择已有单位" },
    "formationId": { "type": "string", "description": "只操作指定编队中的可部署成员" },
    "quantity": { "type": "integer", "min": 1, "allowAll": true, "default": "all", "description": "本次匹配成员数量" },
    "deployed": { "type": "boolean", "default": true, "description": "true部署/坐下/架起，false解除部署/站起/收起" },
    "source": { "type": "string", "enum": ["auto", "existing", "production"], "default": "auto", "description": "auto优先接同句匹配生产；existing只操作现有；production只接同句明确生产的产物" },
    "regionName": { "type": "string", "description": "先前往此分区，再部署；省略目的地时原地执行" },
    "x": { "type": "integer", "min": 0, "description": "明确目的地横坐标" },
    "y": { "type": "integer", "min": 0, "description": "明确目的地纵坐标" }
  }
}
```

美国大兵（E1）、守卫大兵（GGI）、辐射工兵（DESO）等按本局 Deployer 规则和实际 isDeployed 状态统一处理。支持部署、坐下、架起、解除部署、收起、站起来；混编队只选择支持此能力的成员，保留编队归属。已达到要求姿态不重复 toggle。尤里等自动解除的短时部署只触发本次技能，确认后不反复维持。

“造两个辐射工兵，去二楼左下部署”：依次调用 production.produce(target=DESO,quantity=2)，unit.deploy(selector=DESO,source=production,regionName=二楼左下)。宿主直接关联该生产目标，不需要虚构“辐射工兵”编队、空 unitIds 或玩家先编队。“造两个美国大兵编入2队，去二楼左下部署”可在生产中指定 formationId=2队，再调用 unit.deploy(formationId=2队,selector=E1,source=production,regionName=二楼左下)。

“2队去二楼左下部署”只需 unit.deploy(formationId=2队,regionName=二楼左下)，不能只返回 combat.move 遗漏部署。先等待出厂、集结及已有编队交接，再各自移动与部署，以实际姿态确认完成。没有部署能力时明确反馈，不把仅移动算作整句完成。单位无需为此新建编队。

本能力使用本机固定流程，不生成转发脚本。基地车和建造厂继续使用 base.deploy/base.relocate；本轮不接灰熊变建筑等 Mod 变形，运输车卸载也不属于此能力。
