# 基地搬迁与区域建造

使用现有基地车或建造厂，完成收起、移动到分区/坐标、重新展开；不要求先编队，也不默认生产新基地车。真实规则决定能否收起与展开，常规单位部署另见[单位部署](unit-deployment.md)。

形态转换可能换 ID，须按真实转换接续阶段，不能算作阵亡或另找无关基地。搬迁的区域、候选落点、当前身份与进度同局保存，恢复不从收起重放。

相关区域建造等待搬迁实际完成及新建造范围出现。失败、取消或暂无落点时保留阻塞，不在旧基地或其他分区偷偷建造。必要前置复用，目标的分区和方向仍按[建筑选址](building-placement.md)执行。

实现：[base-relocation.ts](../../apps/companion/src/base-relocation.ts)、[relocation.ts](../../packages/runtime/src/relocation.ts)。
