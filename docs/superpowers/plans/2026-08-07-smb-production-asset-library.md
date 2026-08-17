# SMB 可生产内容资产库实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use parallel bounded workers for independent tasks; run the verification commands after integration.

**Goal:** 在不写入 SMB、不生成全量代理的前提下，建立可恢复、可检索的全 SMB 素材基础库，并生成每条素材的联系表与 CTA 四帧检查图。

**Architecture:** 保留现有单批次 `index-assets.mjs` 和 `prepare-media.mjs` 契约不变；新增独立的资产库记录模型、逐文件 checkpoint、源视频直接抽帧模块和 `asset-library` CLI。所有衍生物写入 `work/asset-library/`，只有完整且可验证的扫描才原子发布 `catalog.json`。

**Tech Stack:** Node.js 20 内置模块、现有 `ffprobe`/`ffmpeg`、JSON 原子写入、现有 node:test；不增加数据库、向量库、模型服务或 npm 依赖。

## Global Constraints

- SMB 源目录只读；任何源文件写操作都必须被测试守护。
- 产物仅写 `work/asset-library/`，不生成全量 `proxies/`。
- 支持 `.mp4`、`.mov`、`.m4v`，沿用现有排除目录与自然排序。
- 资产状态限定为 `discovered|probed|fingerprinted|frames_ready|complete|failed`。
- `catalog.json` 只能在本次扫描完整结束、源目录可复读、JSON 重读校验通过后原子替换。
- 单文件失败继续处理并记录阶段；源目录断开/不可读时 run 失败且保留旧 catalog。
- 无变化二次运行不得重新 ffprobe、指纹或有效 JPEG；损坏/缺失衍生物只补对应阶段。
- 视觉质量标记只能提示人工复核，不能自动淘汰素材。

---

### Task 1: 资产库核心扫描与记录模型

**Files:**
- Create: `scripts/lib/asset-library.mjs`
- Create: `scripts/lib/asset-library.test.mjs`
- Modify: `scripts/lib/index-assets.mjs`（仅导出可复用发现函数，必要时修正逐文件指纹隔离）

**Interfaces:**
- `scanAssetLibrary({sourceRoot, workDir, previousCatalog, checkpoint, probe, now}) -> {catalog, checkpoint, metrics, missing, warnings}`
- `searchAssets(catalog, filters) -> AssetRecord[]`
- `extractTags(relativePath) -> string[]`
- `qualityFlagsForMetadata(record, thresholds) -> string[]`
- `assetId = createSourceId(relativePath, sizeBytes, mtimeMs)`；复用现有实现。

- [ ] 为每个发现的视频建立独立记录，保存相对路径、大小、mtime、ffprobe 字段、状态、错误阶段、标签、指纹、重复组和衍生物相对路径。
- [ ] 读取并复用旧 catalog/checkpoint 中三元组未变化且产物仍通过 `isJpeg` 的记录；对新增/变化文件从 probe 阶段开始。
- [ ] 每个成功探测的文件都计算 quick fingerprint；指纹/探测单文件失败不能终止整库。
- [ ] 按 `sizeBytes + quickFingerprint` 为至少两项的组赋 `duplicateGroup` 与 `duplicate_candidate`，不删除文件。
- [ ] 实现目录/文件名标签归一和确定性技术质量标记；保留原始 `relativePath`。
- [ ] checkpoint 每个文件原子写入；完整扫描返回前后源快照（count/bytes/max mtime），源不可读时抛错而不发布 catalog。
- [ ] 测试：全失败仍保留失败记录、重复分组、标签、增量缓存、文件消失 missing、单文件失败继续、源断开不改旧 catalog。

### Task 2: 源视频联系表、CTA 四帧和视觉提示

**Files:**
- Create: `scripts/lib/asset-library-media.mjs`
- Create: `scripts/lib/asset-library-media.test.mjs`

**Interfaces:**
- `ctaSamples(durationInSeconds) -> Array<{seconds,timecode}>`
- `sourceContactSamples(durationInSeconds) -> Array<{seconds,timecode}>`
- `renderSourceSheet({sourcePath, relativePath, samples, outputPath, stagingDir, execFileImpl}) -> void`
- `renderAssetSheets({record, paths, execFileImpl}) -> {contactSheetPath, ctaSheetPath, qualityFlags}`
- `isJpeg`/原子 `.partial.jpg` 校验逻辑复用现有实现或等价实现。

- [ ] 直接把源路径作为 ffmpeg 输入抽帧，绝不先生成代理；staging 使用 `work/asset-library/.staging/`。
- [ ] 联系表遵循 1/3/8 帧时长区间；CTA 遵循 `d-4,d-3,d-2,d-.25`，短于 4 秒使用 10/40/70/95%。
- [ ] 生成带相对路径与时间码的 JPEG；验证 SOI/EOI、非空和普通文件后同目录原子 rename；无效 final 视为 cache miss。
- [ ] 用可注入的灰度帧统计实现 `mostly_black`、`frozen_tail`、`empty_tail_candidate`；阈值是常量，标记不阻断。
- [ ] 测试时只 mock execFile，断言源路径只作为输入参数、没有 `proxies/` 写入；覆盖时点边界、JPEG 恢复、黑帧/冻结/尾部突变。

### Task 3: `asset-library` CLI、运行状态和检索

**Files:**
- Create: `scripts/asset-library.mjs`
- Create: `scripts/asset-library.test.mjs`
- Modify: `package.json`（增加 `asset-library` 脚本）

**Interfaces:**
- `node scripts/asset-library.mjs scan --source-root <absolute-path> [--work-dir <path>] [--resume <run-id>]`
- `node scripts/asset-library.mjs search [keyword] --catalog <path> [filters] [--json]`
- `parseCli(argv)`, `runScan(options)`, `runSearch(options)` 均导出供 node:test 使用。

- [ ] 默认工作目录为 `work/asset-library`；创建 `catalog.json`、`manifest.json`、`runs/<run-id>.json`、`contacts/`、`cta/` 和 checkpoint。
- [ ] scan 读取旧 catalog/checkpoint，串接 Task 1 与 Task 2，逐文件写 run 状态，完成后重读临时 catalog 再原子替换。
- [ ] `search` 支持关键词、重复 `--tag`、`--state`、`--flag`、`--exclude-flag`、`--orientation`、`--codec`、时长边界；默认精简表格，`--json` 输出完整记录。
- [ ] run 失败时保留错误、旧 catalog 和已验证衍生物；支持同一 run resume，不能把 partial 当 cache hit。
- [ ] 测试 CLI 解析、筛选、原子发布、断点恢复、源断开、二次零处理和 no-SMB-write 守护。

### Task 4: 集成回归与文档对齐

**Files:**
- Modify: `docs/DEFERRED_CAPABILITIES.md`（移除已实现的 NAS 全量基础库条目，保留视觉 AI/向量库/后台队列为后续）
- Modify: `docs/PROJECT_PLAN.md`（更新生产顺序和当前边界）

- [ ] 保持旧 `auto-edit` 的 `index.json`、按需代理、Timeline、Remotion 渲染/QC 行为不变。
- [ ] 运行 `npm run test:auto-edit`、`npm run typecheck`、`npm run build`。
- [ ] 在临时本地 fake mount 上完成完整 scan/search/resume 验收；不运行默认 SMB 全量命令。
- [ ] 最终只停在真实 `/Volumes/192.168.50.79` 全量 scan 前，向用户报告命令、预计写入目录和需要人工确认的最后一步。

