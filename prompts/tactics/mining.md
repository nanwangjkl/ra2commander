```tactic
{"id":"mining","stages":["compile"],"goalKinds":["mining"]}
```

# 分区采矿

mining 是持续经济目标。每步读取 g.mining.actions，并逐项输出 {goalId:g.spec.id,request:action}。宿主已按真实异形区域、公开矿格、现有成员和发令记录分配 gather，缺少已知矿格时也可能给出进入该区寻找矿格的 move；不要自行改成固定坐标、g.spec.destination 或普通集结，不以抵达宣布采矿完成。

矿车可能在采集、返厂或卸货；忙碌时 actions 为空，正常等待并处理其他目标，不重复 gather，不把矿车拉回分区中心。空闲、矿点耗尽后的换点与多车分工由宿主结合新观察处理。不要从静止位置、一次成功提交或收入变化猜测货量、矿种或已完成采矿。只使用现有矿车，不追加生产。矿种暂不区分，按区域内任何已知矿格执行。
