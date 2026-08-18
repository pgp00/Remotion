---
name: auto-edit-product-video
description: Use when the user asks Codex to turn raw product copy into local SMB-footage, local-voice Remotion videos.
---

# 原始文案到 Remotion 单条/批量生产

用户唯一必需输入是原始文案，可选输入是模式 `single` 或 `batch`；未指定模式时默认单条。用户只提交文案与模式，分类 CSV、ProductionPlan、时间线和镜头表均由 Codex 内部生成。素材必须来自本地 SMB，语音必须来自本地 IndexTTS 2.5，最终 MP4 必须由 Remotion 生成。

## 九步统一生产流程

1. 保存用户原始文案为批次目录中的 `source-copy.txt`，识别模式；未指定时默认单条。产品身份无法从当前文案和本地资料确认时，报告具体缺口并停止。
2. Codex 自主拆句、分类和去重，内部写 `category,text` CSV，不要求用户填写。每个条目保留 `sourceText`、`normalizedText`、`sentenceId` 的来源合同；只允许拆句、排序、规范化和轻量顺句，不得新增产品事实、数字、价格或承诺。每条固定为 `1 hook + 2–4 个不同类别卖点/场景 + 1 CTA`。
3. 批量先执行 `capacity`；单条固定 1 条并直接继续，批量默认目标为 `300`，先报告有效容量、预计耗时和磁盘空间，再等待用户确认最终数量。
4. 若容量不足，运行现有 `asset-library.mjs scan/search` 扩展本地 SMB；用 `view_image` 打开每个候选的 `contactSheetPath` 与 `ctaSheetPath`，只把语义、质量和时长均视觉核验合格的镜头加入内部素材矩阵，再次执行 `capacity`。禁止网络素材回退。
5. 执行 `prepare`，一次预热本地 IndexTTS 2.5；按真实 WAV 时长选择足够覆盖语音的 SMB 镜头，写入并封存 manifest。每批只随机一次，重试、重启和续跑不得重新组合。
6. `single` 执行 `render` 并交付 1 条；`batch` 执行 `sample`，只渲染 1 条代表性样片，等待用户批准，不提前渲染其余条目。
7. 样片批准后执行 `approve`，再执行 `render` 渲染剩余条目；样片拒绝时执行 `reject`，整批归档、释放预留签名，并根据反馈重新准备新批次。
8. 检查 manifest、联系表、媒体 QC、逐句 WAV 与帧时钟、非末句恰好 5 帧停顿、语音期间真实镜头，以及跨历史文案与素材双重签名唯一性。字幕只覆盖对应语音帧，Remotion 负责逐句音画对齐。
9. 只交付正式 MP4 目录和简短汇总；保留 `source-copy.txt`、`copy-pool.csv`、计划、manifest、TTS 缓存、联系表、QC 和重试产物，便于审计与续跑。

## 唯一协调入口

公开协调器只提供六个命令：`capacity`、`prepare`、`sample`、`approve`、`reject`、`render`。这些命令只协调现有能力；`scripts/produce.mjs` 仍是唯一的单条生产内核，协调器不得自行编码视频或创建第二套 TTS、Remotion、QC 路径。

批量的文案签名和完整镜头序列必须同时避开当前批次、已预留批次及所有历史正式成片；拒绝的整批只保留归档证据，不进入永久历史。`single` 固定 1 条且一次随机，`batch` 的默认目标是 300 条有意义且唯一的组合。

## 输出和硬边界

- 单条和批量都使用同一 `ProductionPlan` 契约、同一本地 IndexTTS 2.5、同一个 `ProductMarketingProduction` Remotion Composition 和现有 QC。
- 30fps；`voiceFrames = ceil(真实 WAV 秒数 × 30)`，非末句恰好 5 帧停顿，末句无停顿；语音不得截断、拉伸或静音替代。
- 每句镜头区间必须覆盖完整语音帧；语音期间不得靠冻结补足，停顿期间才可冻结句末画面。
- 旧 `work/s5max-daily`、`out/s5max-daily` 以及既有 `work/`、`out/` 产物均保留，不迁移、不覆盖、不删除。
- 缺少产品、合格 SMB 镜头、本地音色/模型或 QC 证据时，报告准确的本地 blocker；不得改用远程服务或占位成片。
