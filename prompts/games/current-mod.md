# 当前游戏目录

```game
{
  "id": "ra2web-gonghui",
  "name": "ra2web 共和国之辉",
  "version": "1.0.4",
  "catalogFile": "catalogs/ra2web-gonghui.json",
  "factions": [
    {
      "id": "allied",
      "label": "Allied 盟军",
      "anchors": [
        "GACNST",
        "AMCV"
      ]
    },
    {
      "id": "soviet",
      "label": "Soviet 苏军",
      "anchors": [
        "NACNST",
        "SMCV"
      ]
    },
    {
      "id": "china",
      "label": "China 中国",
      "anchors": [
        "CACNST",
        "CMCV"
      ]
    }
  ],
  "roles": [
    {
      "id": "aircraft",
      "aliases": ["飞机", "战机", "战斗机", "空军", "aircraft", "plane", "planes"],
      "members": [],
      "match": {"type": 1}
    },
    {
      "id": "infantry",
      "aliases": ["步兵", "infantry"],
      "members": [],
      "match": {"type": 3}
    },
    {
      "id": "vehicle",
      "aliases": ["车辆", "战车", "vehicle", "vehicles"],
      "members": [],
      "match": {"type": 7}
    },
    {
      "id": "building",
      "aliases": ["建筑", "building", "buildings"],
      "members": [],
      "match": {"type": 2}
    },
    {
      "id": "naval",
      "aliases": ["船", "舰艇", "战舰", "海军", "ship", "ships"],
      "members": [],
      "match": {"type": 7, "flags": {"naval": true}}
    },
    {
      "id": "constructionVehicle",
      "aliases": [
        "基地车",
        "mcv"
      ],
      "members": [
        {
          "name": "AMCV",
          "type": 7,
          "factions": [
            "allied"
          ]
        },
        {
          "name": "SMCV",
          "type": 7,
          "factions": [
            "soviet"
          ]
        },
        {
          "name": "CMCV",
          "type": 7,
          "factions": [
            "china"
          ]
        }
      ]
    },
    {
      "id": "constructionYard",
      "aliases": [
        "建造厂",
        "基地"
      ],
      "members": [
        {
          "name": "GACNST",
          "type": 2,
          "factions": [
            "allied"
          ]
        },
        {
          "name": "NACNST",
          "type": 2,
          "factions": [
            "soviet"
          ]
        },
        {
          "name": "CACNST",
          "type": 2,
          "factions": [
            "china"
          ]
        }
      ],
      "prerequisiteCategories": [
        "CONYARD"
      ],
      "match": {
        "type": 2,
        "flags": {
          "constructionYard": true
        }
      }
    },
    {
      "id": "powerPlant",
      "aliases": [
        "电厂",
        "发电厂",
        "powerplant"
      ],
      "members": [
        {
          "name": "GAPOWR",
          "type": 2,
          "factions": [
            "allied"
          ]
        },
        {
          "name": "NAPOWR",
          "type": 2,
          "factions": [
            "soviet"
          ]
        },
        {
          "name": "CAPOWR",
          "type": 2,
          "factions": [
            "china"
          ]
        }
      ],
      "prerequisiteCategories": [
        "POWER"
      ],
      "match": {
        "type": 2,
        "positivePower": true
      }
    },
    {
      "id": "refinery",
      "aliases": [
        "矿场",
        "矿厂",
        "精炼厂",
        "refinery"
      ],
      "members": [
        {
          "name": "GAREFN",
          "type": 2,
          "factions": [
            "allied"
          ]
        },
        {
          "name": "NAREFN",
          "type": 2,
          "factions": [
            "soviet"
          ]
        },
        {
          "name": "CAREFN",
          "type": 2,
          "factions": [
            "china"
          ]
        }
      ],
      "prerequisiteCategories": [
        "REFINERY",
        "PROC"
      ],
      "match": {
        "type": 2,
        "flags": {
          "refinery": true
        }
      }
    },
    {
      "id": "barracks",
      "aliases": [
        "兵营",
        "barracks"
      ],
      "members": [
        {
          "name": "GAPILE",
          "type": 2,
          "factions": [
            "allied"
          ]
        },
        {
          "name": "NAHAND",
          "type": 2,
          "factions": [
            "soviet"
          ]
        },
        {
          "name": "CAHAND",
          "type": 2,
          "factions": [
            "china"
          ]
        }
      ],
      "prerequisiteCategories": [
        "BARRACKS"
      ]
    },
    {
      "id": "warFactory",
      "aliases": [
        "战车工厂",
        "重工",
        "工厂",
        "warfactory"
      ],
      "members": [
        {
          "name": "GAWEAP",
          "type": 2,
          "factions": [
            "allied"
          ]
        },
        {
          "name": "NAWEAP",
          "type": 2,
          "factions": [
            "soviet"
          ]
        },
        {
          "name": "CAWEAP",
          "type": 2,
          "factions": [
            "china"
          ]
        }
      ],
      "prerequisiteCategories": [
        "FACTORY"
      ]
    },
    {
      "id": "radar",
      "aliases": [
        "雷达",
        "雷达站",
        "radar"
      ],
      "members": [
        {
          "name": "GAAIRC",
          "type": 2,
          "factions": [
            "allied"
          ]
        },
        {
          "name": "NARADR",
          "type": 2,
          "factions": [
            "soviet"
          ]
        },
        {
          "name": "CARADR",
          "type": 2,
          "factions": [
            "china"
          ]
        }
      ],
      "prerequisiteCategories": [
        "RADAR"
      ]
    },
    {
      "id": "technology",
      "aliases": [
        "作战实验室",
        "高科",
        "科技中心",
        "battlelab"
      ],
      "members": [
        {
          "name": "GATECH",
          "type": 2,
          "factions": [
            "allied"
          ]
        },
        {
          "name": "NATECH",
          "type": 2,
          "factions": [
            "soviet"
          ]
        },
        {
          "name": "CATECH",
          "type": 2,
          "factions": [
            "china"
          ]
        }
      ],
      "prerequisiteCategories": [
        "TECH"
      ]
    },
    {
      "id": "spySatellite",
      "aliases": [
        "间谍卫星",
        "卫星",
        "spysat"
      ],
      "members": [
        {
          "name": "GASPYSAT",
          "type": 2,
          "factions": [
            "allied"
          ]
        }
      ]
    },
    {
      "id": "tank",
      "aliases": [
        "tank",
        "tanks",
        "坦克",
        "所有坦克"
      ],
      "members": [
        {
          "name": "MTNK",
          "type": 7,
          "factions": [
            "allied"
          ],
          "aliases": [
            "灰熊",
            "灰熊坦克"
          ]
        },
        {
          "name": "HTNK",
          "type": 7,
          "factions": [
            "soviet"
          ],
          "aliases": [
            "犀牛",
            "犀牛坦克"
          ]
        },
        {
          "name": "LTNK",
          "type": 7,
          "factions": [
            "china"
          ],
          "aliases": [
            "轻型坦克"
          ]
        },
        {
          "name": "APOC",
          "type": 7,
          "factions": [
            "soviet"
          ],
          "aliases": [
            "天启",
            "天启坦克"
          ]
        },
        {
          "name": "MGTK",
          "type": 7,
          "factions": [
            "allied"
          ],
          "aliases": [
            "幻影坦克"
          ]
        },
        {
          "name": "TNKD",
          "type": 7,
          "factions": [
            "allied"
          ],
          "aliases": [
            "坦克杀手"
          ]
        },
        {
          "name": "TTNK",
          "type": 7,
          "factions": [
            "soviet"
          ],
          "aliases": [
            "磁能坦克"
          ]
        },
        {
          "name": "DMTK",
          "type": 2,
          "factions": [
            "allied"
          ]
        }
      ],
      "match": {
        "type": 7,
        "labelIncludes": [
          "tank",
          "坦克"
        ],
        "excludeFlags": [
          "harvester",
          "naval"
        ]
      }
    },
    {
      "id": "gi",
      "aliases": ["美国大兵", "大兵"],
      "members": [{"name":"E1","type":3,"factions":["allied"],"aliases":["大兵"]}]
    },
    {
      "id": "flyingInfantry",
      "aliases": ["飞行兵", "火箭飞行兵"],
      "members": [{"name":"JUMPJET","type":3,"factions":["allied"],"aliases":["飞行兵"]}]
    },
    {
      "id": "antiAirVehicle",
      "aliases": ["防空车", "防空战车", "antiAirVehicle"],
      "members": [
        {"name":"FV","type":7,"factions":["allied"]},
        {"name":"HTK","type":7,"factions":["soviet"],"aliases":["防空履带车"]}
      ],
      "match": {"type":7,"labelIncludes":["防空"],"excludeFlags":["naval","harvester"]}
    },
    {
      "id": "infantryFightingVehicle",
      "aliases": [
        "ifv",
        "多功能步兵车",
        "多功能车",
        "步兵战车"
      ],
      "members": [
        {
          "name": "FV",
          "type": 7,
          "factions": ["allied"],
          "aliases": ["ifv", "多功能步兵车", "多功能车", "步兵战车"]
        }
      ]
    },
    {
      "id": "scoutDog",
      "aliases": [
        "狗",
        "军犬",
        "侦察犬",
        "scoutDog",
        "dogs"
      ],
      "members": [
        {
          "name": "ADOG",
          "type": 3,
          "factions": [
            "allied"
          ]
        },
        {
          "name": "DOG",
          "type": 3,
          "factions": [
            "soviet",
            "china"
          ]
        }
      ]
    },
    {
      "id": "engineer",
      "aliases": [
        "工程师",
        "engineer"
      ],
      "members": [
        {
          "name": "ENGINEER",
          "type": 3,
          "factions": [
            "allied"
          ]
        },
        {
          "name": "SENGINEER",
          "type": 3,
          "factions": [
            "soviet"
          ]
        }
      ],
      "match": {
        "type": 3,
        "flags": {
          "engineer": true
        }
      }
    },
    {
      "id": "harvester",
      "aliases": [
        "矿车",
        "采矿车",
        "harvester"
      ],
      "members": [
        {
          "name": "CMIN",
          "type": 7,
          "factions": [
            "allied"
          ]
        },
        {
          "name": "HARV",
          "type": 7,
          "factions": [
            "soviet"
          ]
        }
      ],
      "match": {
        "type": 7,
        "flags": {
          "harvester": true
        }
      }
    },
    {"id":"defenseBuilding","aliases":["防御建筑","防御设施","防御工事","防御塔","defenses"],"members":[],"match":{"type":2,"flags":{"isBaseDefense":true}}},
    {"id":"nuclearPowerPlant","aliases":["核电站","核电厂","核反应堆","核子反应炉","nuclearPowerPlant"],"members":[{"name":"NANRCT","type":2,"factions":["soviet"]},{"name":"CANRCT","type":2,"factions":["china"]}]},
    {"id":"terrorDrone","aliases":["蜘蛛","恐怖机器人","恐怖蜘蛛","terrorDrone"],"members":[{"name":"DRON","type":7,"factions":["soviet"]}]}
  ]
}
```

本目录适用于当前本地 ra2web 的共和国之辉规则配置，覆盖盟军、苏军和中国。候选名称及角色别名帮助理解命令和查找规则，不声明所有候选在本局都存在或可造。

当前引擎 rules()、production.available() 和实际单位观测优先。建造前置、队列类别、电力与可造性使用宿主查询结果；不把“电厂、矿场、重工”写成所有阵营固定的科技顺序。宿主会解析真实 prerequisite，包括 POWER、PROC 等类别，并复用已有或已提交的前置。

泛称“防空车”使用 antiAirVehicle，苏军通常选择 HTK，盟军通常选择 FV；不能把它固定解释为 IFV。明确“IFV／多功能步兵车”仍指 FV。“飞行兵／火箭飞行兵”指 JUMPJET，“美国大兵／大兵”指 E1；目标名称依据完整目录解析，不把敌方兵种丢成全部单位。

“核电站／核电厂”是 nuclearPowerPlant，苏军 NANRCT、中国 CANRCT，未解锁时补科技前置，不换成普通电厂。“部队和防御建筑”是步兵、车辆、防御设施的并集；defenseBuilding 由本局 isBaseDefense 标记决定，不能泛化为全部建筑。terrorDrone 表示恐怖机器人；暂时离场时不能据此断言阵亡或寄生成功。

catalog 中角色用于理解“坦克”“侦察犬”等名称。同类有多个候选时，按当前可造项目、当前阵营和已有设施合理选择，简短反馈选择；精确可用的项目可跨阵营。角色映射不自动建立额外生产或扩张目标。

完整项目、中文名称和基础规则事实从 catalogFile 指向的自动导入数据加载。上方角色成员只用于常用语义与阵营提示，不是项目白名单；尚未解锁的巨炮等项目也可接受建造目标。依赖和生产设施由宿主查询本局规则并统一规划；当前可造性由引擎确认，国家限制与未知条件分开反馈。
