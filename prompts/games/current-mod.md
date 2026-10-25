# 当前游戏目录

```game
{
  "id": "ra2web-gonghui",
  "name": "ra2web 共和国之辉",
  "version": "1.0.1",
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
    }
  ]
}
```

本目录适用于当前本地 ra2web 的共和国之辉规则配置，覆盖盟军、苏军和中国。候选名称及角色别名帮助理解命令和查找规则，不声明所有候选在本局都存在或可造。

当前引擎 rules()、production.available() 和实际单位观测优先。建造前置、队列类别、电力与可造性使用宿主查询结果；不把“电厂、矿场、重工”写成所有阵营固定的科技顺序。宿主会解析真实 prerequisite，包括 POWER、PROC 等类别，并复用已有或已提交的前置。

catalog 中角色用于理解“坦克”“侦察犬”等名称。同类有多个候选时，按当前可造项目、当前阵营和已有设施合理选择，简短反馈选择；精确可用的项目可跨阵营。角色映射不自动建立额外生产或扩张目标。
