```tactic
{"id":"attack","stages":["compile"],"goalKinds":["attack"]}
```

# 选中成员攻击与飞机出击

attack 目标使用本步 g.attack.readyIds 和 g.attack.targets。只对 readyIds 发令，从 targets 中选择匹配敌人；targets 已按敌方基地/单位/建筑、ID 和分区筛选，不能退回全图其他敌人。未编队单位走全局脚本，编队中的部分成员也只指挥本次选中的 ID；不建队、不转编、不追加生产。

对飞机优先直接 attack，由游戏处理飞近和开火，不做射程拒绝，也不发 attackMove、move 或 stop。装弹未满、弹药状态未知、尚待交接的飞机在 pendingIds，飞行出击中的在 attackingIds，已实际发射的在 firedIds；这些 ID 都不能再次发令。readyIds 为空时等待，不把首次 pending 写成 memory 永久结束。每步重新读 readyIds，满弹的先出击，不等整队装弹；宿主观察每架弹药下降或武器进入冷却后结束该机本次出击，返航和重新装弹交给游戏。不能用 request 已提交、敌人血量下降或目标摧毁代替逐机投弹确认。

地面 readyIds 可以 attack，持续根据匹配敌人重选目标；无匹配敌人时继续观察，不猜隐藏敌军坐标或宣称全图胜利。生成代码不能缓存生成时的 ID/弹药或丢弃其他目标。避免对同一目标每步重复发令，但去重须包含动态 readyIds；新装满弹的飞机必须获得指令。
