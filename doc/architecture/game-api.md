# 游戏 API 调查

本项目基于 [ra2web](https://github.com/ra2web/ra2web.github.io) 设计独立的本机语音指挥伴随程序。

调查日期：2026-10-06。本文件记录参考版本的接口事实和集成限制；需求见[产品需求](../spec/requirements.md)，实现方案见[架构设计](overview.md)。接口调查尚未由实际对局性能测试验证。

## 参考来源

上游项目：[ra2web](https://github.com/ra2web/ra2web.github.io)。

本次接口调查的固定参考快照为[调查副本](https://github.com/nanwangjkl/ra2commander.github.io)，提交为 `7f6858ac8c1d1b7e6c9c5d84dcc1e9af1df3a06c`。以下源码链接对应该快照，用于复查原始调查结论；ra2web 的实际接入版本仍须在原型中验证。

- [公共类型声明](https://github.com/nanwangjkl/ra2commander.github.io/blob/7f6858ac8c1d1b7e6c9c5d84dcc1e9af1df3a06c/werhd-player-api.d.ts)
- [玩家 API 文档](https://github.com/nanwangjkl/ra2commander.github.io/blob/7f6858ac8c1d1b7e6c9c5d84dcc1e9af1df3a06c/docs/player-console-api.md)
- [Jev 使用示例](https://github.com/nanwangjkl/ra2commander.github.io/blob/7f6858ac8c1d1b7e6c9c5d84dcc1e9af1df3a06c/docs/examples/jev/werhd-jev-player.mjs)
- [发布版游戏实现](https://github.com/nanwangjkl/ra2commander.github.io/blob/7f6858ac8c1d1b7e6c9c5d84dcc1e9af1df3a06c/js/app.js)与[配置](https://github.com/nanwangjkl/ra2commander.github.io/blob/7f6858ac8c1d1b7e6c9c5d84dcc1e9af1df3a06c/config.json)

发布实现用于理解接口实际效果；伴随程序运行时仅使用公共 API。升级兼容时记录新的参考提交，不依赖另一份本机检出目录。

## 控制入口与生命周期

`window.werhd` 存在于正在运行对局的浏览器页面中。类型声明描述该对象，游戏不提供供 Node.js 直接调用的控制 SDK 或本地 HTTP 接口。本机通过自己注入的固定页面桥读写公共状态和动作。

`onTick` 只有一个回调槽，新注册替换旧回调；同步执行超过约 8 ms 或抛错会停用。快照构造和序列化也占浏览器线程，回调必须短小；模型、语音和生成脚本执行放在本机回调之外。

离局后 API 被摘除，旧引用失效。公共接口没有稳定对局 ID 或 API 版本，伴随程序建立本地会话代次。`order/deploy` 返回提交状态，入队不等于完成；部分方法无返回值，没有统一执行回执，效果通过后续公开状态观察。

## 能力与缺口

| 范围 | 可获得或执行 | 缺口与影响 |
| --- | --- | --- |
| 单位微操 | 己方及可见单位的位置、方向、速度、血量、升星、武器射程及可选冷却；移动与攻击 | 没有当前订单、目标、完整攻击状态或可靠射击事件 |
| 火力估算 | 基础伤害、射速、装甲倍率、目标血量 | 缺完整修正、连发与在途弹丸信息，过量集火只能估算 |
| 地图 | 已揭示格、高程、桥面、地形和可见性 | 无路径、可达性、语义地标和鼠标地图坐标 |
| 制造 | 钱、电、可造清单、队列、成本、前置字段、生产和落地 | 无全规则枚举，前置字符串不能替代完整合法性检查 |
| 编队 | 按己方单位 ID 批量下令 | 无游戏内编号编队 API，成员由伴随程序维护 |
| 镜头 | `camera.centerAt/state` | `state` 是投影平移和滚动边界，不是屏幕对应的地图矩形 |

可见单位与当前屏幕上的单位并不等同。射程关系也不证明无遮挡或实际开火；攻击参与和伤害贡献的精确归因不可直接取得。

## 攻击与维修

普通 `Attack` 在目标离开射程或视线后可能自动追逐，`Guard/GuardArea` 也可能有限追逐。公共 API 没有 `holdGround` 或禁止追击开关。坐标 `AttackMove` 的途中机会攻击逻辑不同，不能视为普通攻击的等价替代。

只攻击当前射程内目标仍不能保证后续不追击，需要持续观察、停止或纠正。该限制对应的取舍见 [ADR 005](../decisions/005-correct-engine-pursuit-through-public-api.md)。

车辆维修可通过 `Dock` 请求停靠兼容维修厂；建筑 `repair()` 是建筑修理，不能代替车辆停靠。泊位状态和失败原因不公开，只能结合血量和位置观察。固定 MOD 的规则目录或语音指定设施帮助绑定，不能承诺自动识别任意 MOD 的维修能力。

## 资金与生产优先级

游戏生产并非严格平分资金。[生产系统](https://github.com/nanwangjkl/ra2commander.github.io/blob/7f6858ac8c1d1b7e6c9c5d84dcc1e9af1df3a06c/js/app.js#L3145)逐队列推进队首项目，从当前余额扣除各队列本拍需求；先扣款的队列影响后续可用余额。产品默认尊重这一机制，不额外制定资金策略。

`pause/resume` 按 `QueueType` 操作整个类别，没有公开单项暂停、重排或插队接口。不同类别可暂停竞争队列，同类只能安排未提交请求顺序；已入队项目不能承诺无损插队。

上述调查快照的站点配置强制 `gonghui`。原型须记录实际有效 MOD，维护对应兵种别名和必要前置目录，结合 `rules()` 与 `production.available()` 验证，不修改站点配置。

## 地图校准与输入

参考仓库包含冰天雪地名称映射，但本次未找到可核验几何的实际地图文件。API 不提供地图名称、哈希或实际出生槽位；启动流程选择目标 Profile，再以真实地图校准。

`map.size()` 是 rx/ry 格子索引范围，不保证矩形全部可玩；`map.tile()` 对迷雾和地图外都可能返回 undefined。不能扫描空值就认定实际边界。等距投影同高程下横向与 `rx-ry` 相关、纵向与 `rx+ry` 相关，不能把较小 ry 直接定义为北方。

地图名称一致不保证几何一致。分区、桥口与方位需记录具体版本和校验结果，不编造未经核验的地标坐标。公开静态地图数据不能推导当前隐藏敌军。

游戏没有公共“仅巡视”输入模式。伴随程序须验证页面输入过滤，保留镜头巡视和录音入口，屏蔽原生单位操作；全面屏蔽效果尚未实测。
