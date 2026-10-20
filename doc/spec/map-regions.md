# 地图分区数据

地图分区方案保存地图版本、区域名称、别名和原生 `rx/ry` 边界。同一地图可以有多个作者的方案，每个方案独立版本化。第一份数据为 [冰天雪地 nanwang@0.1.0](../../maps/ice/schemes/nanwang-0.1.0.json)。

当前已实现 JSON 读取、结构校验、名称查询、坐标查询和图片坐标转换。命令编译器、任务运行时和页面桥尚未接入地名或多边形守区；当前调试任务仍使用既有矩形 `Region`。分区数据本身不增加行动限制，也不定义寻路通行性。

## 文件与身份

```text
maps/<地图>/
  import/annotations.json                 # 图像提取参数、文字位置与校准记录
  schemes/<作者>-<版本>.json              # 项目读取的分区方案
packages/maps/src/index.ts                # 读取与空间查询
packages/maps/tools/import_regions.py     # 离线提取
packages/maps/tools/verify_native_alignment.py # 离线纹理校准
```

- `schemaVersion`：文件格式版本，目前为 1。
- `map.id`：地图标识，例如 `ra2:mp32s8`；`map.sha256` 单独标识实际地图文件版本。
- `scheme.id`、`scheme.version`：方案身份与语义版本号；同一地图可并存多套方案。
- `regions[].id`：方案内稳定区域标识；名称修改时保留 ID。
- `regions[].name`、`aliases`：显示名称与别名。读取时进行 NFKC 归一化、去除首尾空白，并检查重名。

原始 `.map`、游戏资源包和标注图片不作为运行时依赖。方案记录其 SHA-256，供作者核对来源。当前原图由用户放在仓库根目录 `mp32s83.png`；离线诊断图片位于 `.runtime/maps/ice/generated/`。

## 坐标与边界

所有 `labelPosition`、`polygons[].outer` 和 `holes` 顶点均为 `[rx, ry]`，支持小数。边界为闭合环，可表达凹多边形、孔洞和多片区域。这里的坐标不是经纬度。

`fullSize`、`localSize` 保留地图文件 `[Map]` 的原始四元组；冰天雪地分别为 `[0,0,90,110]`、`[3,5,84,90]`。它们与公共 API 的 `200×200` 索引范围不是同一个尺寸概念。

`level` 是用户的“一楼、二楼、三楼”分组，不直接对应原地图的高度数值。`labelPosition` 只用于标签显示，不能当作已经验证可达的移动目标。图像覆盖范围也不等于所有格子可玩、可通行；通行性由游戏地图与寻路处理。

粉色粗线采用最近内区的曼哈顿距离分配，公共边界位于标线中部。先按 3 个原图像素一个采样点提取，再填充分割线与小碎片，追踪全部边界。只删除严格共线的顶点，避免相邻区域各自简化后产生缝隙。该规则保留手绘线的近似性，不声称红线中心就是引擎障碍物边缘。

点正好位于公共边界时，`regionsAt()` 返回全部相关区域；`regionAt()` 仅在唯一归属时返回结果。

## 冰天雪地的坐标核对

原图为 `5040×2835`，已关闭高度位移。通过原生雪地 CLAT 素材采样，在四个象限分别搜索纹理对齐；四处均得到相同修正。原地图内 660 条相邻格高度突变边的中点，投影后均位于粉色标线内。此检查支持整体映射，不代表手绘边界具有像素级几何精度。

最终映射为：

```text
px = 30 * rx - 30 * ry + 2520
py = 15 * rx + 15 * ry - 1410

rx = ((px - 2520) / 30 + (py + 1410) / 15) / 2
ry = ((py + 1410) / 15 - (px - 2520) / 30) / 2
```

尺寸计算参考 [CNCMaps 的地图裁剪与地块位置实现](https://github.com/zzattack/ccmaps-net/blob/main/CNCMaps.Engine/Map/Map.cs)。尺寸吻合不能单独确定原点；纹理匹配还确定了相对标准 Local 裁剪公式的 15 像素纵向修正。纹理采样分数用于候选偏移比较，不是坐标准确率。

`projection.validation.status` 为 `native-terrain-verified`，`realGameVerified` 目前为 `false`，二者分别表示原生静态地形核对与实际对局核对。静态数据已可读取和查询；尚未验证浏览器对局中的实际站位，也不支持自动识别当前对局地图。

## 读取示例

```ts
import { loadRegionScheme } from './packages/maps/src/index.ts'

const map = await loadRegionScheme('maps/ice/schemes/nanwang-0.1.0.json')
map.resolve('二楼左上')        // 名称、稳定 ID 或别名
map.regionAt(39, 82)?.name    // 三楼左上
map.regionsAt(39, 82)         // 处理公共边界时使用
map.fromImage(2520, 1590)     // [100, 100]
```

检查与离线工具的运行命令见仓库 [AGENTS.md](../../AGENTS.md)。读取器检查格式、有限坐标、范围、闭合环、非零面积、重复 ID、别名冲突和标签归属；完整覆盖与内部不重叠另有真实方案采样回归。结构校验不是任意外部多边形的完整拓扑证明。

## 提交其他地图或方案

新增方案文件并填写地图哈希、独立方案 ID 与版本号，保留已有方案。边界或命名调整后更新方案版本；地图文件发生变化时记录新地图哈希，重新校准坐标。图片导入还需要在提取参数中登记区域文字的位置，并核对图片哈希和投影。

提交时运行 `pnpm maps:check <文件>`、`pnpm typecheck` 和 `pnpm test`，附上边界叠加图与校准依据，便于评审。自动提取工具目前针对这类平面雪地导图；其他剧场或不同裁剪方式可直接提交符合格式的原生坐标多边形，配套提供自己的校准依据。
