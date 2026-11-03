# 游戏资源来源与管理

游戏来自 [ra2web（网页红井）](https://github.com/ra2web/ra2web.github.io)。固定站点及冰天雪地来源、提交、文件大小和哈希以 [site-manifest.json](../../packages/game-werhd/site-manifest.json) 为准，下载指向原项目，不依赖个人 fork。基础转换后资源镜像与校验规则以 [game-resources.json](../../packages/game-werhd/game-resources.json) 为准。

站点副本保留上游 LICENSE（AGPL-3.0-or-later）及声明，游戏素材另按原权利说明处理，不能用本仓库 MIT 替代。确切文件、资源版本与校验备注在清单维护，不在本文复制库存。

正文放入已忽略的 `resources/game-site/` 与 `resources/game/`，不从开发者浏览器资料导出。准备命令完整校验后复用有效目录，缺失时从固定来源下载，原子发布；损坏目录报错并保留，不能放宽校验交付半成品。

宿主同源提供资源，只改写返回浏览器的配置，不修改外部站点文件。游戏正常校验并缓存，来源偏好在 localStorage，正文由游戏持久存储管理；不伪造“已加载”标记。新 profile 无需手动选资源，正常加载进度仍保留。

Electron 要求完整本机资源；浏览器入口未准备时保留远端兼容路径。构建内置基础资源与冰天雪地，其他地图、音乐、MOD、战役和在线服务沿用原来源，不承诺全资源离线。命令见 [AGENTS.md](../../AGENTS.md)，发行行为见[Linux 分发](../spec/linux-distribution.md)。
