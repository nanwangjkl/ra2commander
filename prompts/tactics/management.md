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

formation：spec.request 是明确的 createFormation、transferUnits 或 dissolveFormation 请求；复制其 kind、formationId、force（如有）。涉及成员时使用本步 unitIds，只有完整成员可用时才提交。动作在宿主修改归属，不调用游戏编队 API。交接停车由宿主完成。
reinforce：spec 含 formationId、name、targetSize、source（null为空闲单位）。unitIds 是当前可用来源，maxUnits 是当前缺额。需要补员时选择不超过 maxUnits 的成员，request={kind:'transferUnits',formationId:spec.formationId,unitIds:[...]}。没有来源或缺额为0时等待，不新增生产。
rally：spec 含 x、y，使用动态 unitIds，request={kind:'move',unitIds:[...],x:spec.x,y:spec.y}，仅指挥未编队成员。
deploy：展开基地目标，使用本步 unitIds 提交 request={kind:'deploy',unitIds:[...]}，单位为空时等待；用 memory 记录上次发令 tick，未观察到转换时可隔30个tick重试。目标完成由宿主观察建造厂出现判定，不新增生产。
