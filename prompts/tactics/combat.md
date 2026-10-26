```tactic
{
  "id": "combat",
  "stages": [
    "compile"
  ],
  "goalKinds": [
    "combat"
  ]
}
```

# 编队作战

combat：spec 含 formationId、region、allowedActions、retreat?。只操纵该目标动态 unitIds；根据可见敌人选择目标、分配火力和站位。move/attackMove 坐标必须在指定地域内；attack 指向当前目标集合中的敌人，接近、寻路及是否能开火由游戏处理；不得把射程作为停止执行的前提。没有 attackMove 能力时不要使用。retreatActive 为 true 时只能 move 到 spec.retreat 的指定点或 stop；回撤条件由宿主计算。不要假设生成时的单位永远在队内，暂时没有成员时返回空动作等待。
- spec.attackRegion 如存在表示单个区域清敌目标。snapshot.enemies 和该目标 constraints.enemyIds 已按真实异形分区筛选，只能攻击这些敌人；不要重新寻找全图敌人。destination 是行军/搜索起点，不是完成条件。到达前使用 move 经过沿途区域，不沿途主动清理其他分区；进入目标区域后攻击可见区域内敌人或向区内目标 attackMove。没有可见敌人时继续前往目的地/观察，不能把暂时不可见当作清空整个区域。
- spec.destination 如存在是已经绑定的移动目的地，直接使用 x/y；name 是地名。前往地名的命令允许经过沿途其他分区，不能把目的地分区当作全程禁止离开的区域。
- spec.route 是本次完整有序路线。宿主按部队主体到达推进并持久化进度，每步的 spec.destination 已更新为当前应到达的一站；直接读取本步 destination，禁止硬编码路点、猜坐标、跳到最后一站或在 memory 里另建循环。末站到达后由宿主完成目标，换脚本不会把路线重置到第一站。
- spec.patrol=true 表示沿本次路线巡逻，途中遇敌可以交战，战斗结束继续当前路点；不因远处敌人改成全图清敌。路线未走完不能宣称结束，不默认无限重复；普通移动没有额外攻击权限。
- 同句话可以先建立编队、再给该队移动/作战目标。编队尚未建立或成员正在停车交接时，unitIds 为空，blocked 可能提示等待建队；本步等待并在后续步骤读取新的动态 unitIds，不把首次没有成员写成永久结束。宿主只在成员归属交接确认后开放指挥。
- spec.mode 为 hold 或 assault 时表示持续守区，destination 是就位点；抵达后继续守卫和处理区内敌人，不把到达当成整个任务结束。mode 为 move 才只赶路。
- “摧毁全部敌人”且有 attackMove 能力时，要主动接近可见敌人，优先可达的地面单位和建筑。可以直接 attack 指定敌人，由游戏处理接近，也可以 attackMove；不要用自行估算的射程拦截攻击。根据后续可见敌人动态重选目标。无敌人时不宣称胜利，也不凭空编造隐藏敌军坐标。
- region 是允许活动的边界，不是移动目的地。玩家明确“移动到60,128”时必须前往60,128，不能用区域中心或当前位置代替；只有玩家未指定具体位置、且任务确实需要站位时才自行选点。不要凭空增加攻击或巡逻阶段。
- 有目的地时，到达判定使用当前 GoalView 的 arrival：reached 表示部队主体已抵达，radius 随存活队伍规模扩大，nearby/required/total 给出本步人数，laggingUnitIds 是尚在跟进的成员；无固定目的地的全图进攻不假设 arrival 存在。不要另写 every 距离≤1/2格等全员挤点条件，也不要用自身的到达判断阻止宿主切换路点。少量掉队成员随全队继续下一站，不为等齐反复把主体塞回旧点。新成员加入后仍按原指令跟进；主体尚未抵达且单位空闲时，可隔一段游戏 tick 重试，移动去重同时考虑成员、目的地和执行状态。不得把动作提交当作到达，远处停滞也不算完成。

全图进攻与区域清敌的统一攻击要求位于 spec.objective：target 限定目标类型、ID 和地域，search 表达寻找方式，completion.ground=continuous。兼容字段 attackRegion/destination 由同一要求派生；不能因为保留旧字段而另外扩大目标。普通移动、巡逻和守区继续按原字段执行，不凭空添加全图进攻。
