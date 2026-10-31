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

建造目标带 afterGoalId 时必须尊重本步 blocked：搬迁未完成、失败或取消时不能在旧基地提前执行该目标及其前置。placementRegion 表示实际建筑落点必须位于指定分区，和 placement 方位约束可同时存在；宿主注入完整边界并选址，模型只提交 place，不丢弃位置要求或改成默认区域。分区无合法落点时保留就绪建筑，不重造。

建筑完整占地之间至少留一格；仅防御建筑之间可紧贴，围墙不受间距限制。宿主统一检查并选址，模型仍只提交 place；因间距暂时无法放置时保留就绪建筑继续尝试，其他可执行目标继续，不取消重造或改写位置要求。

# 生产协调

production：spec 含 target、quantity、prerequisites、queues、targetType。该脚本同时协调所有生产目标。对每个目标先处理尚未出现的必要前置，再处理目标本身。
- spec.formationId 表示把本目标新造单位编入指定队。新造身份由 observed[spec.target] 提供，当前可交接的成员是本目标 unitIds；仅将这些成员按 snapshot.constraints.goals[id].management 提供的 kind（createFormation 或 transferUnits）、formationId 提交编队管理动作，不操作其他已有单位。建队后继续转入后续新造成员；生产完成仍要把剩余成员编入队。
- observed 中的坦克和步兵可能仍在出厂或前往集结点；productionPlan.pendingRallyIds 表示尚未可交接成员。必须等待宿主将其放入本步 unitIds，不能从 observed 或 self 绕过等待自行编队、停车、攻击、上车或安排掩护。产物已经记账，等待期间不补造、不删除目标，不把本步没有可交接成员记成永久 done。
- 每次单位 produce 入队前，宿主会检查集结点及周围地形、建筑占地，必要时先换点。没有新开阔位置时本次生产暂缓且没有预占额度，其他目标继续；下步继续按宿主 produceRemaining 提出请求，不将本次已返回动作数组当成已经提交，不自行另设集结点或追加替代产量。
- spec.maintainPower 表示玩家明确要求持续保持电量健康。宿主已结合实时电力、待完成建筑耗电和在建电厂算好 produceRemaining；直接使用该剩余额度，不能按 spec.quantity 或 observed.length 自行结束目标。补电与其他建设共用建筑队列，优先处理就绪建筑，不额外堆积电厂。
- 生产动作 request={kind:'produce',name,quantity}。produceRemaining 已经扣除了 submitted，直接提交 remaining 以内数量，不要再次减 submitted，也不要比较 submitted<remaining。为0时不再 produce；本次已就绪建筑仍由宿主继续放置。uncertain 表示结果待确认，等待并保留目标。
- 建筑放置由宿主按本次生产记录与 Ready（status=3）队列主动执行，优先于脚本，不依赖脚本提出 place。仍兼容旧脚本 request={kind:'place',name}，同一步同名建筑只发一次；不要带坐标。明确方位、分区及间距由宿主统一处理，不手工覆盖。新增建筑是否完成只看 observed 中本次真实产物与生产记录，self 中已有同名建筑只满足必要前置，不能抵消明确新增数量。尚未确认落地时不取消、不补造，暂时无空位继续保留就绪建筑；不能用 memory 的“已调用 place”或 selfHas 标记宣布完成。
- 生产类别在 snapshot.constraints.goals[id].productionQueueTypes，空位在 queueSpace。同一步同类别所有目标合计产量不能超过空位。建筑队列通常只有1格：一次提交一项，等它完成并落地后才能提交同类下一项；不同名称也会争用同一队列，不能同时把矿场和兵营塞入单格建筑队列。
- productionQueueTypes[name] 是单个整数队列编号，不是数组。usedByQueue、同名共享前置去重集合要在遍历全部目标之前建立，同步扣除本步已安排数量，不能在每个目标内重置。宿主也会按相同共享空位顺序安排合法生产，放不下的部分留到下一步；生产完成与剩余量仍只看实时事实，不用 memory 把未实际提交的动作记为已完成。
- gonghui 的车辆/步兵队列可能恒空，不能要求队列存在才生产，也不能据此重复下单。production.available 是名称字符串数组；当前可造且 remaining>0 时可以 produce。用 produceRemaining 避免重复，用 observed 中累计的新身份观察完成，不能用当前单位净增量计算累计生产。
- 同名共享前置在单步中最多 produce 一次；已经存在或正在建设则等待/复用。不要额外扩张经济或产能。
- 必须区分前置和目标：self 中存在同名建筑只满足前置，不能抵消本条明确新增的目标。即使已有坦克或电厂，只要该目标的 produceRemaining[target]>0，仍须按剩余额度生产；observed[target] 部分增长也不能当成全部完成。禁止把 existsInSelf/observed.length>0 的前置判断复用于目标生产。
- 同时存在明确建设目标和同名必要前置时，宿主把新提交统一计入明确建设目标，供其他目标共享，不再额外造一次。始终按本步 produceRemaining 和 productionPlan 执行，不按硬编码的建筑名称/科技顺序把 target 排除在生产循环之外。
- 队列操作 request={kind:'pauseQueue'|'resumeQueue',queueType} 仅限明确允许且可观测的类别；只能恢复该目标暂停的队列。优先使用 productionPlan.queueControl.actions，不暂停本目标仍需的前置或产物队列，不接管玩家或其他目标的暂停。queueControl.pending 表示回执或恢复待确认，不重复发令。普通目标不主动操作队列；生产撤销由宿主处理，不自行 cancel。
- blocked 表示目标当前阻塞，可继续处理其他目标。
- 建筑避让集结区、必要换点及未就绪产物改点由宿主统一协调；等待时保留就绪建筑并处理其他目标，不自行重设集结点、放宽位置或补造建筑。

默认新生产、持续补电及显式队列控制均由本机按同一 productionPlan 发令；这些说明继续用于旧脚本及显式回退。脚本只执行分配给自己的目标，共享前置和队列可能已由本机目标推进，以每步事实为准，不在脚本中重新接管本机目标。

每个 goal.productionPlan 是宿主按本步规则与提交记录算好的事实：missingPrerequisites 是尚未满足的必要前置，pendingPrerequisites 是已有提交待完成的前置；availableToProduce 是当前有剩余额度、可造且有队列空位的候选；readyToPlace 是本步就绪且允许放置的建筑。必须从当前目标读取，不能读取不存在的 snapshot.productionPlan。优先使用这些事实，结合本步 constraints 和目标进度执行，不按游戏常识重算科技树，不重复提交前置。
目标已经在 production.available 中时，引擎已确认前置满足，不再等待 spec.prerequisites 中的历史缺项，直接处理目标本身的剩余额度与放置。

productionPlan.placement 存在时表示玩家明确指定了逐座方位：completed 只计实际位于要求方向的建筑，next 是本次待放置建筑的方向及参照点。仍然用普通 {kind:"place",name} 发起放置，宿主补齐当前约束；不要因已发 place 就切换方位，不按全部目标累计数量自己选方向。暂时无合法位置时保留就绪建筑，在原方向继续尝试，其他队列与目标继续；不擅自放到相反方向，不补造替代品。

科技树由宿主按本局规则统一解析，不逐种硬编码建造顺序。productionPlan.unmetConditions 列出国家限制、不可直接生产的设施或引擎尚未开放的条件；这些条件按当前快照更新。只执行 availableToProduce 中的项目与 readyToPlace 中的建筑，不猜测额外前置，不以当前目标还不可造就跳过其可执行前置。不要求玩家先手动造出空指部、实验室等。多个目标共用同一座就绪前置，本步同名建筑只 place 一次；宿主也会统一去重。
