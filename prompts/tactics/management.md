```tactic
{
  "id": "management",
  "stages": [
    "compile"
  ],
  "goalKinds": [
    "formation",
    "reinforce",
    "rally",
    "deploy"
  ]
}
```

# 编队组织与全局管理

formation：spec.request 保存编队目标；每步请求使用 snapshot.constraints.goals[id].management 的 kind、formationId、force（如有）和本步 unitIds。目标队在等待期间建立后，kind 会从 createFormation 变为 transferUnits，已经在目标队的成员不再转入。blocked 或可用人数未达到 management.maxUnits 时等待，继续处理其余目标。动作在宿主修改归属，不调用游戏编队 API。交接停车由宿主完成。同句话对同一队的多个选择由宿主合并去重。
reinforce：spec 含 formationId、name、targetSize、source（null为空闲单位）。unitIds 是当前可用来源，maxUnits 是当前缺额。需要补员时选择不超过 maxUnits 的成员，request={kind:'transferUnits',formationId:spec.formationId,unitIds:[...]}。没有来源或缺额为0时等待，不新增生产。
rally：spec 含 x、y，使用动态 unitIds，request={kind:'move',unitIds:[...],x:spec.x,y:spec.y}，仅指挥未编队成员。使用 arrival.reached 判断主体是否抵达，不另设全员必须靠近同一格的条件；允许少量掉队成员继续跟进。
deploy：展开基地目标，使用本步 unitIds 提交 request={kind:'deploy',unitIds:[...]}，单位为空时等待；用 memory 记录上次发令 tick，未观察到转换时可隔30个tick重试。目标完成由宿主观察建造厂出现判定，不新增生产。
