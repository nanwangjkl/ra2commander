# 探路

```skill
{
  "id": "scout",
  "version": "1.3.1",
  "name": "探路",
  "aliases": ["侦察", "开图", "探索地图"],
  "games": ["ra2web-gonghui"],
  "description": "默认优先用现有未编队侦察犬，无可用成员时新造三条；独立编队并行探索，每区覆盖至少60%，优先区域中心。",
  "parameters": {
    "quantity": { "type": "integer", "description": "侦察成员数量", "min": 1, "default": 3 },
    "memberSource": { "type": "string", "description": "auto 优先已有未编队狗，无可用成员时新造；existing 只用已有；new 明确新造", "enum": ["auto", "existing", "new"], "default": "auto" }
  },
  "requires": ["production.produce", "formation.assign", "map.explore"],
  "steps": [
    { "id": "prepare", "capability": "production.produce", "existingCapability": "formation.assign", "role": "scoutDog" },
    { "id": "explore", "capability": "map.explore", "after": { "step": "prepare", "milestone": "first-member-ready" } }
  ],
  "exploration": { "pointSpacing": 6, "stallTicks": 600, "maxStallsPerRegion": 3, "coverageRatio": 0.6, "interiorMargin": 3, "retryPasses": 1, "centerFirst": true }
}
```

使用当前游戏的侦察犬角色，默认最多三条，优先选择现有未编队成员；没有可用成员时才新造三条。现有数量不足时先按可用部分执行并简短说明，不擅自补足生产。“用已有狗探路”显式 memberSource=existing，只使用已有成员，没有也不生产；“新造/出三条狗探路”显式 memberSource=new，按指定数量新造。普通“探路”使用 memberSource=auto 或省略，让宿主按当前成员选择来源。旧参数 useExisting=true/false 分别兼容 existing/new。使用独立侦察编队，不擅自接管其他玩家编队的整队任务。

准备和探索沿用全局及编队脚本。探索可提前编译为等待中的目标，首个实际产出或选中的成员完成停车交接后才开放指挥，其余成员随后加入，不必等全部到齐。

按宿主给出的探索任务点分派成员。覆盖依据是游戏 API 真实揭示过的格子，不凭到达分区中心、提交移动或 memory 标记宣布完成。不逐帧调用模型。遇阻换候选格并继续其余分区；无法揭示的部分必须保留数量和原因，不能说全图完成。

有可用任务时各成员独立并行移动，优先占用不同分区；只剩少量区域时选相隔较远的落点协作。优先选择分区内部候选，避免沿地图边缘反复尝试。移动中允许绕路，不因暂时远离终点判定停滞；长时间原地不动才换点，并避开失败点附近。真实区域覆盖继续增加时清除连续失败计数。其他区域处理后，对暂缓区额外换点重试一轮，尽量换一个成员；无新进展且重试耗尽才部分完成，不无限循环。

每个目标分区分别达到至少 60% 的实际揭开覆盖即达标，达标分区不再分配新落点，所有目标分区都达标才完成。不能用全图平均覆盖达到 60% 代替逐区达标。优先前往区域中心及中心附近尚未揭开的有效格子；异形区中心落在图外或孔洞时选区内最近的有效候选。仍不足 60% 才逐步向外展开，达到下限就结束该区，不为补齐边角贴边绕行。

只探路，不主动全图进攻、不无限补狗。成员阵亡后用剩余成员继续；全部丢失且初始生产已结束时结束任务，并如实显示未覆盖部分。完成、取消或改令后不再接管侦察队，不撤回已经投入生产的队列。
