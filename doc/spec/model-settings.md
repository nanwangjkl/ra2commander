# 模型设置

只保留一套当前配置：URL、Key、模型名称，以及保存、测试连接按钮。URL 是兼容 Chat Completions 的 Base URL，不带末尾 `/chat/completions`；不提供多配置管理或服务下拉。

Key 不回显，留空保留原值，填写新值替换；更换 URL 必须填写适用的 Key。保存成功后只影响新请求，在途请求保留旧实例，不重编脚本或刷新游戏。测试使用当前表单发最小模型请求，不保存、不切换实际配置、不操作游戏；保存本身不自动测试。

配置在用户数据的 `.runtime/settings.json` 中原子保存，写盘成功才切换内存配置。失败保留旧值及表单草稿，过时修订不能覆盖新配置。没有本机配置时兼容原环境配置，页面保存后本机唯一配置优先；旧多配置文件仅保留已选项。无效文件保留并报告，不偷偷切换模型。

文件以受限权限创建，但不是加密存储；Key 不发送给页面、不进入对局导出，错误中的已知 Key 脱敏。用户数据位置见[桌面分发](desktop-distribution.md)和[Linux 分发](linux-distribution.md)。

实现：[model-settings.ts](../../apps/companion/src/model-settings.ts)、[接口](../../apps/companion/src/workbench-api.ts)、[表单](../../apps/companion/ui/model-settings-panel.ts)。
