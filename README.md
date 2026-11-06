![蓝发少女的作战部署](doc/assets/readme-cover.png)

# RA2 Commander

用中文语音指挥红警。按住录音键说出目标，RA2 Commander 负责生产、建设、编队和部队行动，你可以随时改令或停止。

项目通过 [ra2web（网页红井）](https://github.com/ra2web/ra2web.github.io) 的公开玩家 API 控制游戏，使用 Electron 将游戏和指挥侧栏放在同一个窗口中。目前围绕**冰天雪地**地图开发，已在 Steam Deck 上完成实机验收。

## 能做什么

可以从这些命令开始：

```text
展开基地
造五辆坦克，编入一队
一队进攻三楼右下
探路
防守基地
```

生产会自动补齐必要科技前置；部队可以按地图分区移动、进攻和防守。探路、维修车、掩护三个游戏 Skill 处理持续协作，例如让多条狗分头探索，或让防空车随坦克一起行动。

侧栏显示每条命令、实际理解、执行状态和错误。每条命令都能添加反馈，历史对战页可以下载最近十局的完整调试包，供复盘和排查问题。

这是一个仍在迭代的个人项目。系统优先按合理解释行动，可能选错对象或执行得不够好；后续命令可以纠正它。当前地图和规则经过专门适配，其他地图、MOD 的效果需要另外验证。

## 开始使用

在“设置”中填写兼容 OpenAI Chat Completions 协议的模型 **URL、Key、模型名称**，可以先点“测试连接”。设置只保存当前一套配置，后续命令立即使用新配置。

进入游戏的“单机 → 遭遇战”，使用冰天雪地地图。默认我方利比亚，对手为法国简单电脑；可以在开局前自行修改。

麦克风默认启用。按住反引号键（`Backquote`）或输入区右侧按钮说话，松开后识别并下令；关闭左侧麦克风开关即可改用文字输入。设置页可以选择麦克风和录音键。Steam Deck 可用 Steam 的键盘映射触发录音键，其余操作沿用游戏输入。

语音通过随包的 **SenseVoiceSmall INT8** 在本机识别，转写后的文字交给所配置的云模型理解；实时执行在本机持续进行，不逐帧请求模型。原始录音默认不保存、不上传，命令理解需要网络和模型服务。

### 从源码运行

需要 Node.js ≥ 22.12 和 pnpm 9。首次准备会下载游戏资源与语音模型，它们不保存在 Git 中。

```sh
pnpm install --frozen-lockfile
pnpm game:resources:install
pnpm game:site:install
pnpm speech:install
pnpm desktop
```

浏览器开发入口、构建命令、环境变量及检查方式见 [AGENTS.md](AGENTS.md)。

### 桌面包

正式包包含运行环境、基础游戏资源、冰天雪地和语音模型，无需另装 Node.js 或浏览器；其他地图、音乐和在线服务仍可能访问上游。

| 平台 | 格式 | 验证情况 |
| --- | --- | --- |
| SteamOS / Linux x64 | AppImage、tar.gz | Steam Deck 实机已验收，Deck 窗口为 1280×800 |
| macOS | ZIP，解压运行 `.app` | Apple Silicon 已构建检查；尚未提供开发者签名与公证 |
| Windows | ZIP，解压运行 `ra2commander.exe` | 已在 Windows 构建成功，实机对局体验待验收 |

macOS、Windows 采用普通桌面窗口尺寸。程序与用户数据分开保存，升级替换程序会保留设置和对局；安装方式见 [Linux 分发](doc/spec/linux-distribution.md)及[桌面分发](doc/spec/desktop-distribution.md)。

## 参与开发

遇到问题时，可以在命令卡片中记录实际表现与期望，再从历史页下载相关对局 ZIP。调试包包含命令、理解、生成代码、运行观察和反馈，不包含模型 Key 或浏览器资料，不会自动上传。

开发约定和命令见 [AGENTS.md](AGENTS.md)，模块与行为说明见[开发文档](doc/README.md)。地图分区支持多个作者和版本，提交方式见[地图分区](doc/spec/map-regions.md)；固定提示词在 [prompts/](prompts/)，游戏 Skill 在 [skills/](skills/)。

## 致谢与许可

本仓库代码采用 [MIT License](LICENSE)。游戏由 [ra2web](https://github.com/ra2web/ra2web.github.io) 提供，语音识别使用 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 与 [SenseVoice](https://github.com/FunAudioLLM/SenseVoice)。游戏、游戏素材和语音模型各自保留上游许可，本项目的 MIT 许可不覆盖这些资源；固定来源与许可说明见[游戏资源](doc/assets/game-resources.md)和[语音模型资源](doc/assets/speech-model.md)。
