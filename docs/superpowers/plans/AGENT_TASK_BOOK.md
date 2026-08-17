# Agent Task Book

## Objective

生成 30 条文案、镜头编排和最终文件均不同的精品 S5Max 竖屏宣传片；每条 20–30 秒、中文配音、同步字幕、真实产品素材，并逐条完成技术与视觉验证。

## Baseline

- Workspace: `/Users/gilgamesharcher/Repo/Remotion`（无 Git 元数据）
- Assets: `work/asset-library/catalog.json`，2955 条；SMB `/Volumes/192.168.50.79` 已挂载
- Preserve: 现有文件；新产物只写任务指定路径
- Concurrency: 24；所有子代理使用 `gpt-5.6-luna`、reasoning `max`

## Work graph

```text
Lead 定义 manifest 契约
├── CONTENT_A 01–06   ├── CONTENT_B 07–12   ├── CONTENT_C 13–18
├── CONTENT_D 19–24   ├── CONTENT_E 25–30   ├── PIPELINE
└── REVIEWER
        ↓
Lead 合并 → 代理/TTS/渲染 → 全量 QC → APPROVE/BLOCK
```

## Manifest contract

每组写 JSON 数组，每项为 `{"id","title","segments"}`；每个 segment 为：

```json
{"kind":"hook|appearance|shave|power|water|charge|cta","text":"字幕","voiceText":"配音","assetId":"catalog id","sourcePath":"绝对路径","sourceInSeconds":0,"durationInSeconds":3}
```

每条 6–8 段，首段 hook、末段 cta；文案全文和 asset/order 编排全局唯一；素材必须来自 catalog 且实际查看联系表；产品事实只取自 CSV。

## Role matrix

| Role | Tier | Objective | Skills | Write ownership | Deliverable |
| --- | --- | --- | --- | --- | --- |
| PROJECT_LEAD | L | 契约、整合、渲染、审批 | multi-agent-project-lead, ponytail | shared docs/integration | 30 MP4 + verdict |
| CONTENT_A–E | S | 各交付 6 条精品脚本与选片 | ponytail | `work/s5max-30-unique/plans/group-[a-e].json` 和独立 result | 6 manifests |
| PIPELINE | E | 最小批量生产脚本 | ponytail, test-driven-development | `scripts/render-s5max-batch.py`, test, result | renderer |
| REVIEWER | R | 独立验收设计 | verification-before-completion | reviewer result | acceptance report |

## Shared constraints

- SMB 只读；代理、音频、字幕、成片写入仓库。
- 不新增依赖；使用 Python 标准库、`say`、FFmpeg/ffprobe。
- 每个代理只写自己的所有权路径，不改共享文件或其他组文件。
- 每个素材必须有 catalog 和联系表证据，不凭文件名猜测。
- 报告文件、命令、证据、风险；禁止只写“完成”。

## Role briefs

### CONTENT_A–E

- Tier S；目标：指定 6 个编号的精品 manifest。
- Read: CSV、catalog、contacts/、cta/、既有 demo props。
- Write: 自己的 group JSON 与 `results/content-[a-e].md`。
- Must: 从完整 CSV 选择完整脚本；逐句看联系表选片；确保编号、全文、顺序、核心素材不同；验证 assetId 存在。
- Must not: 修改代码/SMB/他组文件；虚构参数；复用整条时间线。
- Acceptance: 6 个连续 ID、每条 6–8 段、首 hook 末 cta、JSON 可解析、所有素材存在、同组全文/编排哈希唯一。
- Stop: 联系表缺失或无法确认产品。

### PIPELINE

- Tier E；目标：将 manifest 生成代理、逐句配音、ASS 字幕和最终 MP4。
- Skills: ponytail、test-driven-development，必须完整阅读后执行。
- Write: `scripts/render-s5max-batch.py`、`scripts/test_render_s5max_batch.py`、`work/s5max-30-unique/results/pipeline.md`。
- Must: 校验 manifest；`say -v Tingting -r 230`；按音频实测时长裁画面；FFmpeg 输出 1080×1920/30fps/H.264/yuv420p/AAC；支持 `--jobs` 与 `--validate-only`。
- Must not: 写死内容、下载依赖、修改 Remotion、覆盖现有输出。
- Acceptance: 测试通过；拒绝重复 ID/缺素材/错误首尾；单条 smoke 满足规格。

### REVIEWER

- Tier R；目标：建立能阻止伪差异、静音、黑帧、错品、字幕越界的验收矩阵。
- Skills: verification-before-completion，必须完整阅读。
- Write: `work/s5max-30-unique/results/reviewer.md`；其他只读。
- Acceptance: 每项需求都有直接证据与命令，明确 APPROVE/BLOCK 条件。

## Integration order

1. Lead 验证 5 组 manifests 与 catalog 引用。
2. Pipeline 测试并完成单条 smoke。
3. Lead 合并为 `work/s5max-30-unique/manifest.json`。
4. 有界并发生成代理、TTS、字幕、30 条成片。
5. Lead 按 Reviewer 规则完成全量技术/视觉回归。

## Acceptance matrix

| Requirement | Owner | Verification | Status |
| --- | --- | --- | --- |
| 30 条不同文案 | Content/Lead | 全文 SHA-256 去重为 30 | PENDING |
| 30 套不同编排 | Content/Lead | asset/order SHA-256 去重为 30 | PENDING |
| 完整素材库选片 | Content | assetId 存在且联系表已查看 | PENDING |
| 中文非静音配音 | Pipeline/Lead | AAC + volumedetect | PENDING |
| 发布技术规格 | Pipeline/Lead | ffprobe + 完整解码 | PENDING |
| 精品视觉门槛 | Reviewer/Lead | 每条首中尾联系表 | PENDING |
| 30 文件不同 | Lead | MP4 SHA-256 去重为 30 | PENDING |
