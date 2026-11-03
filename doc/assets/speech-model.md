# 语音模型资源

固定模型为 SenseVoiceSmall INT8（2024-07-17），由 [sherpa-onnx 官方模型发行](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models)提供。运行库、模型来源、上游文档、压缩包及逐文件大小和 SHA-256 集中在 [model-manifest.json](../../packages/speech/model-manifest.json)；不在文档或构建脚本另列版本清单。

压缩包约 163 MB，模型约 239 MB。原许可说明为必需资源，保留其 [FunASR 许可引用](https://github.com/modelscope/FunASR#license)，不改写为本项目 MIT。构建随包交付模型、tokens 与许可文件，用户无需另行下载。

模型正文放在已忽略的 `resources/speech/models/<model-id>/`，下载缓存与用户设置在 `.runtime/speech/`，两者分开。准备先校验已有目录与压缩缓存，再下载并逐文件检查，成功后原子发布；异常目录保留，不覆盖，旧默认目录仅在校验通过后迁移。

开发者可用 `RA2C_SPEECH_MODEL_DIR` 覆盖识别目录，页面只保存设备和按键。离线检查针对固定分发版本，不启动识别器或联网。构建复用同一校验，缺失或损坏即停止，不将开发者 `.runtime/` 打包。

准备与检查命令见 [AGENTS.md](../../AGENTS.md)，实现：[model-assets.ts](../../packages/speech/src/model-assets.ts)，交互见[语音输入](../spec/speech-input.md)。
