```tactic
{
  "id": "production",
  "stages": [
    "compile"
  ],
  "goalKinds": [
    "production"
  ]
}
```

# 生产协调

production：spec 含 target、quantity、prerequisites、queues、targetType。该脚本同时协调所有生产目标。对每个目标先处理尚未出现的必要前置，再处理目标本身。
- spec.formationId 表示把本目标新造单位编入指定队。新造身份由 observed[spec.target] 提供，当前可交接的成员是本目标 unitIds；仅将这些成员按 snapshot.constraints.goals[id].management 提供的 kind（createFormation 或 transferUnits）、formationId 提交编队管理动作，不操作其他已有单位。建队后继续转入后续新造成员；生产完成仍要把剩余成员编入队。
- spec.maintainPower 表示玩家明确要求持续保持电量健康。宿主已结合实时电力、待完成建筑耗电和在建电厂算好 produceRemaining；直接使用该剩余额度，不能按 spec.quantity 或 observed.length 自行结束目标。补电与其他建设共用建筑队列，优先处理就绪建筑，不额外堆积电厂。
- 生产动作 request={kind:'produce',name,quantity}。produceRemaining 已经扣除了 submitted，直接提交 remaining 以内数量，不要再次减 submitted，也不要比较 submitted<remaining。为0时不再 produce，但建筑仍要检查队列就绪并 place。uncertain 表示结果待确认，等待并保留目标。
- 建筑：队列 Ready（status=3）后 request={kind:'place',name}；不带坐标，宿主自动选址。后续检查 observed[name] 或 self，未确认落地持续重试 place，不要取消或重复 produce。暂时无空位、cannot-place/no-spot 不代表建筑丢失，不用重造；只有观察到实际落地后才停止放置重试，不能用 memory 的“已调用 place”标记宣布完成。
- 生产类别在 snapshot.constraints.goals[id].productionQueueTypes，空位在 queueSpace。同一步同类别所有目标合计产量不能超过空位。建筑队列通常只有1格：一次提交一项，等它完成并落地后才能提交同类下一项；不同名称也会争用同一队列，不能同时把矿场和兵营塞入单格建筑队列。
- productionQueueTypes[name] 是单个整数队列编号，不是数组。usedByQueue、同名共享前置去重集合要在遍历全部目标之前建立，同步扣除本步已安排数量，不能在每个目标内重置。宿主也会按相同共享空位顺序安排合法生产，放不下的部分留到下一步；生产完成与剩余量仍只看实时事实，不用 memory 把未实际提交的动作记为已完成。
- gonghui 的车辆/步兵队列可能恒空，不能要求队列存在才生产，也不能据此重复下单。production.available 是名称字符串数组；当前可造且 remaining>0 时可以 produce。用 produceRemaining 避免重复，用 observed 中累计的新身份观察完成，不能用当前单位净增量计算累计生产。
- 同名共享前置在单步中最多 produce 一次；已经存在或正在建设则等待/复用。不要额外扩张经济或产能。
- 必须区分前置和目标：self 中存在同名建筑只满足前置，不能抵消本条明确新增的目标。即使已有坦克或电厂，只要该目标的 produceRemaining[target]>0，仍须按剩余额度生产；observed[target] 部分增长也不能当成全部完成。禁止把 existsInSelf/observed.length>0 的前置判断复用于目标生产。
- 同时存在明确建设目标和同名必要前置时，宿主把新提交统一计入明确建设目标，供其他目标共享，不再额外造一次。始终按本步 produceRemaining 和 productionPlan 执行，不按硬编码的建筑名称/科技顺序把 target 排除在生产循环之外。
- 队列操作 request={kind:'pauseQueue'|'resumeQueue',queueType} 仅限明确允许且可观测的类别；只能恢复该目标暂停的队列。cancel 不可用。普通目标不主动操作队列。
- blocked 表示目标当前阻塞，可继续处理其他目标。

productionPlan 是宿主按本步规则与提交记录算好的事实：missingPrerequisites 是尚未满足的必要前置，pendingPrerequisites 是已有提交待完成的前置；availableToProduce 是当前有剩余额度、可造且有队列空位的候选；readyToPlace 是本步就绪且允许放置的建筑。优先使用这些事实，结合本步 constraints 和目标进度执行，不按游戏常识重算科技树，不重复提交前置。
目标已经在 production.available 中时，引擎已确认前置满足，不再等待 spec.prerequisites 中的历史缺项，直接处理目标本身的剩余额度与放置。
