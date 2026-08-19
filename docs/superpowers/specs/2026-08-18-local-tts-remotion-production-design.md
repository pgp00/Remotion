# 本地 TTS 驱动的 Remotion 成片生产设计

**状态：** 用户已确认，实施中  
**日期：** 2026-08-18  
**正式成片基准：** `out/s5max-30-smb-unique-indextts2/` 中现有 25 条视频

## 1. 唯一目标

用户只提供产品文案。Codex 必须自主完成产品与卖点识别、全文拆句、SMB 素材检索和视觉确认、逐句产品镜头组合、本地配音、字幕与音画同步、Remotion 渲染和成品质检，最终每条文案交付一个可播放 MP4。用户不负责准备镜头映射、时间线、生产计划或 JSON。

项目不再以网页、通用编辑框架或演示 Composition 为目标。SMB 是必需的只读素材来源；IndexTTS 2.5 是唯一语音引擎；Remotion 是唯一最终视频渲染器；FFmpeg/ffprobe 只负责素材预处理、媒体探测和质检。

## 2. 验收基准

- 视觉与节奏以现有 25 条正式成片为最低基准。
- Remotion 示范片的字幕条和动态图形能力作为视觉升级方向。
- 每条原始文案必须完整覆盖，不得概括、漏句或为满足时长而截断。
- 每个语义句必须有独立语音、对应产品镜头和同源字幕。
- 默认句间停顿为 5 帧，30fps 下约为 0.167 秒；最后一句后不追加停顿。
- 输出为 H.264、`yuv420p`、1080×1920、30fps、单声道 AAC MP4，并能完整解码。
- `out/`、`work/`、SMB 原文件和现有正式成片不得在迁移中被覆盖或删除。

## 3. 生产流程

```text
用户文案（唯一必需输入）
  → Codex 识别产品和逐句卖点
  → 检索 SMB catalog 并查看候选联系表
  → Codex 自主选择、裁切和组合对应镜头
  → 内部生产计划 JSON 校验
  → IndexTTS 2.5 单次加载、逐句生成本地 WAV
  → ffprobe 获取每句真实时长
  → 生成以语音为时钟的 Remotion Props
  → Remotion 一次渲染最终 MP4
  → ffprobe / FFmpeg / 联系表质检
  → 成品与 manifest
```

素材库扫描是独立的低频准备工作，不放进每次成片的关键路径。Codex 从已有 catalog、联系表和代理素材中按文案语义自主选镜头；先按产品、动作、卖点和场景检索，再实际查看候选联系表，不凭文件名猜画面。确定性脚本只负责验证和执行，不假装自动理解画面。若没有可信的对应素材，必须报告具体缺口，不能使用无关画面或把选片工作转交给用户。

## 4. 单一生产计划

用户输入仍是原始文案；Codex 在完成拆句和选片后，才把自己的决策写成一个内部 JSON 文件。该文件是可审计、可恢复的执行记录，不是要求用户准备的接口。工具不额外支持多套互相兼容的历史格式。

```json
{
  "schemaVersion": 1,
  "id": "s5max-01",
  "title": "视频标题",
  "sourceText": "用户提供的完整文案",
  "catalogPath": "work/asset-library/catalog.json",
  "voice": {
    "promptPath": "work/voices/reference.wav",
    "durationFactor": 1.0
  },
  "sentences": [
    {
      "id": "sentence-01",
      "text": "显示在字幕中的原句。",
      "ttsText": "用于正确发音的原句。",
      "shot": {
        "sourceId": "catalog-source-id",
        "sourceInSeconds": 1.2,
        "sourceOutSeconds": 5.8,
        "fit": "cover",
        "focusX": 0.5,
        "focusY": 0.5
      }
    }
  ]
}
```

内部计划保存到本地任务目录。`catalogPath` 指向已生成联系表的本地 SMB catalog，`sourceId` 必须能在该 catalog 中解析；生产入口从 catalog 取得只读 SMB 源路径并只为已选素材生成本地代理。`sourceText` 与全部 `text` 按统一空白规则拼接后必须相等。`ttsText` 只能为发音做等义替换，例如将 `S5Max` 转为更自然的读法；原字幕和 manifest 必须保留用户原文。文案数量不再写死为 30，一份计划对应一条成片，多份计划组成一个批次。

## 5. 语音驱动的时间线

IndexTTS 2.5 在一个批次中只加载一次模型。每句生成独立 WAV，输出由模型配置、参考音色、文本和时长因子的内容哈希决定；哈希和 WAV 完整性都匹配时才允许复用。

对第 `i` 句：

- `voiceFrames = ceil(wavDurationSeconds × fps)`，最少 1 帧。
- `pauseFrames = 5`，最后一句为 0。
- `startFrame` 为此前全部 `voiceFrames + pauseFrames` 的累加值。
- 字幕范围为 `[startFrame, startFrame + voiceFrames)`。
- 镜头范围为 `[startFrame, startFrame + voiceFrames + pauseFrames)`。
- 本地 WAV 由 Remotion `<Audio>` 在 `startFrame` 开始播放。

语音保持 IndexTTS 2.5 的自然速度，不再用 `atempo` 强行适配旧视频。素材有效区间必须至少覆盖发声帧；句间 5 帧可以停留在镜头末帧。素材不足时停止并要求重新选镜头，不循环、不拉伸、不用无关素材补齐。

## 6. Remotion 画面

生产 Composition 只消费已校验的 Props：句子、镜头、语音路径和精确帧范围。每句使用一个 `Sequence`，内部播放对应的 SMB 本地代理素材；字幕使用同一句的帧范围。现有字幕条作为默认样式，保留后续增加标题、卖点卡和品牌动画的能力，但本轮不增加新视觉组件。

Remotion 直接输出带本地语音的最终 MP4，不再先生成无声视频、再用 FFmpeg 替换音轨。源素材音轨默认静音，最终只保留本地人声；音乐能力继续延后。

## 7. 最小文件结构

保留：

- `packages/remotion-video/`：唯一视频模板、语音时间线、字幕和校验。
- `scripts/asset-library.mjs` 与必要的 `scripts/lib/`：SMB 只读扫描、代理、联系表和检索。
- `scripts/indextts25-batch.py`：本地 IndexTTS 2.5 批处理和缓存。
- 一个正式生产入口：校验计划、调用 TTS、生成 Props、调用 Remotion、执行 QC。
- `skills/auto-edit-product-video/`：把“用户只给文案”转换为自主检索、视觉确认、选片、生成内部计划并执行生产入口的 Codex 工作流。
- 对应的最小 Node/Python 测试。

在同素材对照片通过后删除：

- `apps/web/`。
- `packages/shared/` 和 `packages/core/`；仍需要的类型与校验移入 `packages/remotion-video/`。
- `ProductMarketingDemo`、占位场景和网页专用示例数据。
- Edge TTS、macOS `say` 和相关回退分支。
- `scripts/s5max-30-render.py`、`scripts/s5max-indextts2-replace.py` 及其历史入口。
- 被新生产入口取代的重复自动剪辑入口和过时设计/任务文档。

资产库模块保持当前职责边界，不为了减少文件数量合并成单个大文件。

## 8. 失败与恢复

- 任何 URL、远端模型路径或远端语音配置都必须拒绝。
- 参考音色、模型、SMB 代理、文案句子或镜头映射缺失时立即失败。
- 只把 `.partial` 文件原子改名为最终文件；默认拒绝覆盖已有成品。
- TTS 可按内容哈希断点复用；Remotion 成片在完整 QC 前不得标记完成。
- 单条失败必须记录句子 ID、素材 ID、阶段和错误；不得生成伪成品。
- SMB 始终只读，所有代理、WAV、Props、日志和成片只写本地 `work/` 或 `out/`。

## 9. 性能原则

- 一个批次只加载一次 IndexTTS 2.5 模型。
- 每条视频只进行一次 Remotion 最终编码。
- 未改变的 WAV 和已准备代理按哈希复用。
- 不增加队列服务、数据库、Web API 或自定义缓存层。
- 只有实测证明单任务吞吐不足时，才增加有界并发。

## 10. 验证与迁移门槛

先使用现有 `s5max-01` 的原文和镜头计划，在新目录生成一条 Remotion + IndexTTS 2.5 对照片，不覆盖正式成片。必须同时满足：

1. 原文与所有字幕句完整对应，所有句子均有有效 WAV。
2. 用户侧只提供原始文案；镜头映射和内部计划由 Codex 自主生成。
3. 语音帧、字幕帧、镜头帧和 5 帧句间停顿可由 manifest 逐项核对。
4. 画面内容与各句卖点对应，并有 catalog/联系表选择证据；字幕可读且不越界。
5. 输出为 H.264/AAC、1080×1920、30fps、`yuv420p`，帧数等于 Timeline 总帧数。
6. 完整 FFmpeg 解码、非静音检查和首中尾联系表检查通过。
7. manifest 记录 Remotion 命令、IndexTTS 版本、参考音色哈希、每句文本/WAV/镜头及最终文件哈希。
8. 人工对比现有正式 `s5max-01`，确认视觉和节奏不低于基准。

只有这条对照片通过，才删除旧源码和过时文档。现有正式成片与中间产物始终保留。
