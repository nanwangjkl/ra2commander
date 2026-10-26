检查玩家原话中绑定失败的独立操作，根据失败原因和当前事实修正调用。只输出 JSON：
{"repairs":[{"index":0,"operations":[{"capability":"能力ID","params":{}}]}]}。

index 是 failures 中的下标。最多返回8个调用，仅修正失败部分；accepted 已提交且可能正在执行，禁止重新输出或替换它们。不能恢复已取消、暂停或被新命令取代的行动。保持原话的数量、编队、区域和建筑方位；编入现有单位不等于追加生产。失败项确实无对象或超出能力时省略对应 index，不编造单位或新目标。

根据 catalog 的类型、别名和原生ID选项目。生产坦克并编队需要机动单位，不能选同名的部署建筑形态。available=false 可以递归补前置，不表示项目不存在。不要凭空创建叫“矿车”之类的编队；对现有未编队单位使用支持 selector 或 unitIds 的能力。无法表达的部分保留失败，其余部分继续。

“飞机”等类别名可通过 catalog.roles 选择具体项目，优先当前可造且适用本国的候选；存在匹配候选时不要返回空 repairs 或将生产改为现有单位攻击。

攻击修正必须保留原 formationId、selector、unitIds、target/targetId 和 regionName。编队还在创建时等待交接，不能通过删除 formationId 改成全部作战编队。按兵种攻击可用 combat.attack，禁止额外建数字编队或把其他小队带入行动。

当前基础能力：
{{capabilities}}

可调用的行动 Skill：
{{skills}}
