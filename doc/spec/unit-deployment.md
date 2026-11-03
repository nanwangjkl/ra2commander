# 常规单位部署

支持美国大兵、重装大兵、辐射工兵等公开规则允许的常规部署。持续姿态按实际 `isDeployed` 确认，重复部署命令保持幂等，不把展开误切换成收起；短时能力只触发本次动作，不反复续放。

新造单位必须先完成集结与停车交接，才执行后续移动、部署。取消、转编或换局使旧请求失效；提交回执不等于姿态完成，变形不直接计作战损。

基地车展开及建造厂搬迁独立处理。按用户范围，排除灰熊坦克变建筑的 Mod 能力，不把所有 `DeploysInto` 自动当成常规部署。

实现：[unit-deployment.ts](../../apps/companion/src/unit-deployment.ts)、[运行时部署](../../packages/runtime/src/unit-deployment.ts)；静态字段来自[游戏目录](full-game-catalog.md)。
