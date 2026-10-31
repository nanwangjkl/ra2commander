# 维修车

```skill
{
  "id": "repair-vehicle", "version": "1.2.0", "name": "维修车",
  "aliases": ["修理车", "组装维修车", "组装修理车"],
  "games": ["ra2web-gonghui"],
  "description": "造维修车/修理车：每辆新造一辆IFV和一名工程师，实际上车后持续维修己方受损坦克；多车分头并行，可跟随指定编队。",
  "parameters": {
    "quantity": { "type": "integer", "description": "维修车数量，每辆需要一个IFV和一个工程师", "min": 1, "default": 1 },
    "memberSource": { "type": "string", "description": "new按数量新造整套；auto先用空闲组件或已组装维修车并补齐缺项；existing只用现有", "enum": ["auto", "existing", "new"], "default": "new" }
  },
  "requires": ["production.produce", "formation.assign", "transport.enter", "vehicle.repair"],
  "steps": [
    { "id": "vehicles", "capability": "production.produce", "role": "infantryFightingVehicle" },
    { "id": "engineers", "capability": "production.produce", "role": "engineer" },
    { "id": "assemble", "capability": "transport.enter" },
    { "id": "repair", "capability": "vehicle.repair" }
  ],
  "repair": { "retryTicks": 90, "stallTicks": 600 }
}
```

“造维修车”“造修理车”默认新造整套：每辆一个 IFV、一名工程师；数量是成品数量，不是组件总数。前置按当前对局真实规则补齐，两个生产目标共用全局生产台账与共享前置。明确“组装/使用已有”才使用现有空闲组件；existing 不额外生产。

默认由本机完成现有组件编队、新造组件的有限生产、工程师上车及持续维修，不为维修队生成组装或维修代码。新造或选中的组件进入本次维修编队，先完成原生集结和停车交接。每名工程师只分配一个空载 IFV，每个 IFV 只分配一名工程师；可同时组装多辆。只在 transport.unitIds 实际出现工程师后确认组装，不能因发出上车动作就算完成。已就绪的维修车可立即工作，其他组件继续准备；载有其他兵种的 IFV 不擅自卸载或冒充维修车。

维修范围默认是己方全部坦克。宿主从完整 self 快照读取真实 hitPoints/maxHitPoints，生成 repair.targets；本机逐项提交 {kind:'repair',unitIds:[unitId],targetId}，直接以受损坦克为对象。底层使用普通 Attack 发挥负伤害维修武器；不是建筑扳手、不是工程师消耗式修楼，也不用 ForceAttack。不要先要求坦克在射程内；游戏负责接近并维修。

同一编队多辆维修车独立并行，优先各修不同坦克；没有更多伤员时可协修。保留仍有效的分工，修满、阵亡、离开指定支援队或维修车失效后及时重分配。持续无移动、无回血时允许换目标，不能一辆受阻拖住全队。只指挥维修车和待上车工程师，不移动受损坦克。无伤员时持续待命，不宣布永久完成。

指定 followFormationId 时维修该队受损坦克，无伤员时跟随该队主体；不改变被支援队的脚本或成员。repair.readyIds 是已组装成员，assembling 是上车配对，targets 是维修分工，follow 是待命跟随位置。按动态事实发令，遍历全部成员，不串行等待。只以成功回执保存上次目标和 tick，同目标忙碌时不反复发令，空闲且达到 policy.retryTicks 时可重试；任务变化及时更新，没有伤员且没有跟随点时结束本任务的旧订单并原地待命。禁止自行攻击敌军、卸载工程师、无限补造或扩大数量。

无执行方式标记的旧目标继续原脚本，RA2C_REPAIR_EXECUTOR=script 可回退组装和维修发令，RA2C_PRODUCTION_EXECUTOR=script 独立回退组件生产。仅在脚本回退时，由脚本遍历 assembling 发 enterTransport、遍历 targets 发 repair，并让没有维修分工的 readyIds 按 follow 移动；沿用相同动态分工，不自行选择另一套伤员或把已发上车当成组装完成。

侧栏区分生产、组装与持续维修；取消停止本次后续准备和维修，已提交生产不撤回。改令后原 Skill 不再接管，重启保留组件生产与配对事实，不重复生产。
