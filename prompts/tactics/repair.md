```tactic
{ "id": "repair", "stages": ["compile"], "goalKinds": ["repair", "transport"] }
```

# 上车与维修支援

transport：使用动态 unitIds，向 spec.transportId 发送 {kind:'enterTransport',unitIds,targetId:spec.transportId}。无可用成员时等待；完成由宿主按载员ID确认。不展开载具、不卸载、不消耗工程师修建筑。

repair：repair 字段包含宿主按全量己方快照生成的 readyIds（已组装车辆）、assembling（{engineerId,vehicleId}）、targets（{unitId,targetId}）、damaged（真实坦克血量）、follow（可选跟随点）。不要自行筛选 self 的前几项、不要用区域中心代替坦克对象。先遍历 assembling 分别发 enterTransport，再遍历全部 targets 分别发 repair。每辆独立发令，不等全队到齐，不等上一辆修满。维修动作 {kind:'repair',unitIds:[unitId],targetId} 由游戏负责接近；不能生成 attack/attackMove/ForceAttack 或射程门禁，也不能指挥受损坦克移动。

脚本仅做动态分工的发令和去重。用 memory 按成员保存动作类型、目标、最后发令 tick；换目标立即发令，同一目标忙碌且未超过 spec.policy.retryTicks 时不重复。若超过20个动作，按上次发令时间优先，分步处理，不能把未实际输出的动作记为已发。targets 中已无某辆车的旧目标时，若它刚才在维修且未转入新目标，应停车一次，清除旧发令记忆，避免继续追逐满血或已失效对象。派新维修或上车任务时不先停车打断。

没有伤员时持续待命；有 follow 时仅让没有维修任务的 readyIds 靠近跟随点，离队伍主体小于等于6格时不挤点。跟随途中发现伤员立即改为 repair。没有 follow 就原地待命，不自行探路或进攻。blocked 及无可用成员时等待后续组件，不额外生产。组装与生产完成由宿主判定，memory 不能宣布完成。
