```tactic
{"id":"attack","stages":["compile"],"goalKinds":["attack"]}
```

# 选中成员攻击与飞机出击

attack 目标使用本步 g.attack.readyIds 和 g.attack.targets。只对 readyIds 发令，从 targets 中选择匹配敌人；targets 已按敌方基地/单位/建筑、ID 和分区筛选，不能退回全图其他敌人。未编队单位走全局脚本，编队中的部分成员也只指挥本次选中的 ID；不建队、不转编、不追加生产。

对飞机优先直接 attack，由游戏处理飞近和开火，不做射程拒绝，也不发 attackMove、move 或 stop。装弹未满、弹药状态未知、尚待交接的飞机在 pendingIds，飞行出击中的在 attackingIds，已实际发射的在 firedIds；这些 ID 都不能再次发令。readyIds 为空时等待，不把首次 pending 写成 memory 永久结束。每步重新读 readyIds，满弹的先出击，不等整队装弹；宿主观察每架弹药下降或武器进入冷却后结束该机本次出击，返航和重新装弹交给游戏。不能用 request 已提交、敌人血量下降或目标摧毁代替逐机投弹确认。

地面 readyIds 有匹配敌人时优先直接 attack，由游戏处理接近、寻路和开火，不必先计算射程或等待全体进入射程。持续根据匹配敌人重选目标；无匹配敌人时继续观察，不猜隐藏敌军坐标或宣称全图胜利。生成代码不能缓存生成时的 ID/弹药或丢弃其他目标。

新攻击默认本机执行；本主题保留给旧脚本和显式调试回退。objective.target.unitNames/unitTypes 是敌方名称或类别并集，domain 限定空中／地面，包含空中的步兵；不能当作己方选择器，也不能在修复时删除。普通攻击只按武器空地能力分配目标，不添加距离门槛。

避免每步重复发令，但去重必须包含动作类型、目标和动态成员：发过 move/attackMove 只表示下达行军，不能据此跳过后续 attack；如确实先行军，到达目标附近后仍须下达攻击。仅实际返回 attack 动作时才能记为已下达攻击，不能用“目标 ID 相同”代替动作阶段。新加入的地面成员和新装满弹的飞机必须获得指令。

攻击要求统一在 spec.objective：target 给出类别、ID 和可选真实分区；search.kind 分别为 visible（等待可见目标）、region（进入区域寻找）或 map（全图推进）；completion 区分地面持续作战与飞机单次发射。旧 targetKind/targetRegion 等仅为兼容字段，不扩大 objective 的目标范围。

当 search.kind=region 且有 search.destination 时，地面 groundIds 即使暂时没有匹配敌人，也应 move 前往该点并在区域内继续搜索/观察；到达不表示清空。攻击移动只能选择目标分区内部落点，进入区域前用 move 赶路，不主动清理沿途其他分区。只移动 groundIds，飞机仍只直接 attack。search.kind=map 的地面成员主动接近可见匹配敌人；无目标时继续观察，不猜隐藏敌人位置。混编时地面搜索和飞机等待/出击独立推进。

membership.kind=selected 表示本次固定选中的现有 ID；prepared 表示还会从明确的生产/编队目标接入本次成员，宿主按真实产物和交接维护 readyIds，不按兵种无限纳入后来生产的单位。不要自行扩大名单，也不要因首批成员已经出击就丢弃其余待准备成员。
