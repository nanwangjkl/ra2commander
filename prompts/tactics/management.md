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
    "deploy",
    "relocate",
    "building"
  ]
}
```

# 编队组织与全局管理

building（仅兼容旧状态中由脚本执行的目标，新建筑操作由本机固定流程处理）：维修或出售本次选中的现有己方建筑，使用 g.building.actions 提供的本步原生动作逐条输出 {goalId:g.spec.id, request:action}。动作为空时等待，下一步重新读取；不得自行切换维修开关、指挥维修车、追加生产或出售其他 ID。repairBuilding 仅开启原生扳手，sellBuilding 交给游戏卖掉建筑。缺钱、已开启维修或等待出售动画时不重复发令；满血或实际离场由宿主确认完成。不要把首次等待写成永久 done，也不要丢弃其他全局目标。

formation：spec.request 保存编队目标；每步请求使用 snapshot.constraints.goals[id].management 的 kind、formationId、force（如有）和本步 unitIds。目标队在等待期间建立后，kind 会从 createFormation 变为 transferUnits，已经在目标队的成员不再转入。blocked 或可用人数未达到 management.maxUnits 时等待，继续处理其余目标。动作在宿主修改归属，不调用游戏编队 API。交接停车由宿主完成。同句话对同一队的多个选择由宿主合并去重。

新造坦克和步兵抵达生产建筑集结点前不会进入可用 unitIds；正常等待，不直接使用 spec.request.unitIds 或扫描 self 提前操作这些成员，也不另发 stop 打断出厂与集结。宿主确认到点以后会重新提供成员；不能把暂时没有可用成员记成永久完成。
reinforce：spec 含 formationId、name、targetSize、source（null为空闲单位）。unitIds 是当前可用来源，maxUnits 是当前缺额。需要补员时选择不超过 maxUnits 的成员，request={kind:'transferUnits',formationId:spec.formationId,unitIds:[...]}。没有来源或缺额为0时等待，不新增生产。
rally：spec 含 x、y，使用动态 unitIds，request={kind:'move',unitIds:[...],x:spec.x,y:spec.y}，仅指挥未编队成员。使用 arrival.reached 判断主体是否抵达，不另设全员必须靠近同一格的条件；允许少量掉队成员继续跟进。
deploy：展开基地目标，使用本步 unitIds 提交 request={kind:'deploy',unitIds:[...]}，单位为空时等待；用 memory 记录上次发令 tick，未观察到转换时可隔30个tick重试。目标完成由宿主观察建造厂出现判定，不新增生产。

relocate（仅用于旧状态或显式回退后的脚本目标，新搬迁由本机固定流程处理）：宿主用 relocation 保存当前阶段、变形后的真实 unitId、候选落点和本步 action。每步若 g.relocation.action 存在，直接输出 {goalId:g.spec.id, request:g.relocation.action}；不存在时正常等待并继续其他目标。不要缓存原建造厂 ID，不从 spec.unitId 重新猜成员，不自行提前展开或另建编队。收起实际使用向建造厂下达 move，抵达后才允许 deploy；转换后的新建造厂出现且位置正确才完成。宿主负责有限换点、重复指令节流和进度保存。
