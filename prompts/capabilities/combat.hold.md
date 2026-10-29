# 编队守区

```capability
{
  "id": "combat.hold",
  "name": "编队守区",
  "version": "1.2.0",
  "binder": "combat.hold",
  "owner": "formation",
  "parameters": {
    "defendBase": {
      "type": "boolean",
      "default": false,
      "description": "防守基地：攻击进入基地车或展开后建造厂所在真实分区的全部敌人，没有敌人原地待命；无需填写地域或坐标"
    },
    "formationId": {
      "type": "string",
      "description": "编队名称或数字别名；使用当前 formations",
      "required": true
    },
    "regionName": {
      "type": "string",
      "description": "要守卫的地图分区；省略则守住队伍附近"
    },
    "bounds": {
      "type": "integer[]",
      "description": "显式活动矩形 x1,y1,x2,y2",
      "min": 0,
      "minItems": 4,
      "maxItems": 4
    },
    "targetSelectors": {
      "type": "string[]",
      "minItems": 1,
      "description": "持续监视的敌方兵种或类别并集，如 flyingInfantry、JUMPJET；省略则守卫全部敌人，与己方编队成员分开"
    },
    "targetDomain": {
      "type": "string",
      "enum": ["all", "air", "ground"],
      "default": "all",
      "description": "敌方空地范围；air 包含处于空中的飞行兵，不能只按飞机类型识别"
    },
    "mode": {
      "type": "string",
      "description": "hold 守区；assault 允许区内攻击移动；move 只赶路",
      "enum": [
        "hold",
        "assault",
        "move"
      ],
      "default": "hold"
    },
    "retreatLoss": {
      "type": "number",
      "description": "明确要求战损回撤时的阵亡比例阈值，严格超过后回撤",
      "min": 0,
      "max": 0.999999
    },
    "retreatX": {
      "type": "integer",
      "description": "回撤点横坐标",
      "min": 0
    },
    "retreatY": {
      "type": "integer",
      "description": "回撤点纵坐标",
      "min": 0
    },
    "label": {
      "type": "string",
      "description": "可选任务标签"
    }
  }
}
```

持续守卫指定分区，按当前快照选择区内目标和站位。玩家明确战损回撤时同时填写比例与回撤坐标。守区持续到取消或改令，不因当前没有敌人就完成。普通攻击交给游戏处理接近与开火。

“2队监视任何出现的飞行兵，只要出现就干掉”使用 combat.hold(formationId=2队,mode=hold,targetSelectors=[flyingInfantry])；“2队警戒空中敌人”使用 targetDomain=air。敌方兵种与空地范围同时保留，由本机统一筛选；飞行兵是步兵类型，空中状态按公开 zone 识别，不能把 type=1 当成所有空中单位。省略地点时守住队伍附近，不自动巡逻、集结到中心或搜索全图。没有匹配目标时原地待命，目标离开守区或不再符合要求时停止追击，新目标出现后继续响应。

“3队防守基地”“1队守卫基地附近”只返回 combat.hold(formationId=对应队,defendBase=true)。防区是基地车（展开后为建造厂）所在的完整地图分区，保留异形边界与孔洞，不按队伍当前位置画矩形。直接攻击进入防区的可见敌人，包括地面和空中；没有敌人或目标离区时停止追击、原地待命，不自动去区域中心集结或绕行。基地移动跨区后跟随更新防区，展开与收起不丢失关联。多座基地时优先基地车，其余按离所选部队最近的己方建造厂合理选择，并反馈实际分区。

队伍正在按明确生产目标建立时等待真实交接，不额外建队或从现有单位凑数。基地防守由本机执行，持续到取消、停止、改令、全灭或对局结束；原有显式分区／矩形守区入口保留。
