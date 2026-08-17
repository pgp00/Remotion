# Remotion 单批次自动剪辑 MVP 设计

**状态：** 已批准（A 档）  
**日期：** 2026-08-06  
**目标平台：** 本机 Codex + Remotion + 已挂载 SMB 素材盘

## 1. 决策摘要

首版只处理一个显式指定的素材批次和一份用户提供的脚本，生成一条可审核的 20–40 秒竖屏商品视频。确定性程序负责扫描、代理、联系表、校验和渲染；Codex 根据脚本、目录语义和联系表做剪辑决策；Remotion 根据现有 `Timeline` 契约渲染真实素材。

首版不建设数据库、后台队列、模型服务、全 NAS 索引、TTS、BGM、三候选或网页编辑器。源 SMB 永远只读，所有衍生文件写入本机。

## 2. 当前基线

仓库已有：

- `packages/shared/src/index.ts`：`Product`、`AssetShot`、`Timeline` 等共享类型。
- `packages/core/src/validate-timeline.ts`：时间线基础校验。
- `packages/core/src/ports.ts`：素材搜索与 TTS 的端口定义，真实实现尚未配置。
- `packages/remotion-video/src/root.tsx`：仅注册 `ProductMarketingDemo`。
- `packages/remotion-video/src/product-marketing-video.tsx`：仅渲染程序化占位场景。
- `apps/web/src/app.tsx`：只读演示审核界面，导入和渲染按钮未启用。
- `skills/auto-edit-product-video/SKILL.md`：Codex 剪辑工作流和真实性约束。
- `out/demo-product.mp4`：1080×1920、30fps、24 秒的演示成片。

基线验证：`npm run typecheck` 已通过；当前目录没有 `.git`，因此无法提交文档。

SMB 挂载点为 `/Volumes/192.168.50.79`，容量约 465 GiB，已用约 97%。素材同时存在按日期、型号、场景和相机编号组织的目录；编码和规格混有 H.264/HEVC、1080p/2.5K/4K、29.97/30/50/59.94/60fps。D 盘不得存放新代理或渲染结果。

首轮真实烟雾测试使用：

- 小批次：`/Volumes/192.168.50.79/S16素材`，2 个竖屏 MP4。
- 扩展批次：`/Volumes/192.168.50.79/4.27拍摄视频`，76 个统一竖屏 MP4。

## 3. MVP 范围

### 3.1 输入

每个任务需要一个 UTF-8 JSON 配置文件，至少包含：

```json
{
  "schemaVersion": 1,
  "jobId": "s16-smoke",
  "sourceRoot": "/Volumes/192.168.50.79/S16素材",
  "scriptPath": "examples/scripts/shaver-smoke.txt",
  "product": {
    "sku": "SHAVER-SMOKE",
    "name": "剃须刀素材测试",
    "sellingPoints": ["产品展示", "使用展示"],
    "aliases": ["剃须刀", "刮胡刀"],
    "referenceImages": []
  },
  "target": {
    "width": 1080,
    "height": 1920,
    "fps": 30,
    "minDurationSeconds": 20,
    "maxDurationSeconds": 40
  }
}
```

`examples/scripts/shaver-smoke.txt` 只用于验证流程，内容使用“产品展示、使用展示、结束提示”等中性描述，不声明未经用户确认的商品功效。

### 3.2 输出

```text
work/<job-id>/
├── index.json
├── timeline.json
├── props.json
├── result.json
├── contacts/
│   ├── <source-id>.jpg
│   └── final-cut.jpg
└── public/
    └── proxies/
        └── <source-id>.mp4

out/<job-id>.mp4
```

`work/` 和 `out/` 都位于本机仓库，加入 `.gitignore`。`public/` 是该任务传给 Remotion `--public-dir` 的目录；Composition 通过 `staticFile()` 读取其中代理文件。

### 3.3 明确不做

- 不扫描 `/Volumes/192.168.50.79` 全盘。
- 不修改、重命名、移动、删除或生成 SMB 相邻文件。
- 不调用云端 TTS、视觉模型或音乐服务。
- 不自动撰写、改写或补充商品功效声明。
- 不实现三候选、后台任务队列、数据库或 Web 编辑器。
- 不实现人物跟踪、智能重构图或自动 LOG 调色。

## 4. 最小架构

```text
任务 JSON + 用户脚本
          │
          ▼
单批次 SMB 只读扫描 ── ffprobe ──► work/<job>/index.json
          │
          ▼
本机代理与联系表生成 ── ffmpeg ──► work/<job>/public + contacts
          │
          ▼
Codex 技能：脚本拆段、召回候选、查看联系表、选择入出点
          │
          ▼
work/<job>/timeline.json + props.json
          │
          ▼
validateTimeline() + 真实素材阻断校验
          │
          ▼
Remotion ProductMarketingReal ──► out/<job>.partial.mp4
          │
          ▼
ffprobe + 切点抽帧 QC ──► out/<job>.mp4 + result.json
```

实现采用一个 Node `.mjs` CLI 作为入口，并用子命令支持断点执行：

```text
index → prepare → validate → render → qc
run --through prepare → 执行索引和准备后停在 needs_review
run --from validate   → Timeline 获批后执行校验、渲染和 QC
```

Codex 选镜位于两段 `run` 之间，不伪装成无人值守的模型服务。项目技能负责调用第一段、生成 Timeline、取得人工批准，再调用第二段。CLI 只使用 Node 标准库、系统 `ffmpeg`/`ffprobe` 和仓库已经安装的 Remotion CLI。

## 5. 数据契约

### 5.1 新增源文件索引类型

`AssetShot.sourceId` 已暗示源文件实体，因此补充一个最小 `AssetSource`，不引入数据库模型：

```ts
export interface AssetSource {
  id: string;
  sourcePath: string;
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
  durationInSeconds: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  rotation: number;
  hasAudio: boolean;
  quickFingerprint: string | null;
  proxyPath: string | null;
  contactSheetPath: string | null;
  status: "indexed" | "prepared" | "skipped" | "failed";
  error: string | null;
}

export interface AssetIndex {
  schemaVersion: 1;
  sourceRoot: string;
  scannedAt: string;
  sources: AssetSource[];
  shots: AssetShot[];
}
```

MVP 将一个源视频视为一个 `AssetShot`，其范围为 `0..durationInSeconds`。Timeline 仍可从该范围内选择更短的 `sourceInSeconds/sourceOutSeconds`，无需首版实现自动切镜算法。

### 5.2 渲染 Props

```ts
export interface RenderJobProps {
  timeline: Timeline;
  shots: Record<string, AssetShot>;
}
```

`TimelineClip.assetShotId` 是唯一关联键；Composition 不直接猜测路径。

### 5.3 画面适配

给 `TimelineClip` 增加三个可选字段：

```ts
fit?: "cover" | "contain";
focusX?: number; // 0..1，默认 0.5
focusY?: number; // 0..1，默认 0.5
```

首版横屏素材默认居中 `cover`。Codex 可根据联系表调整焦点；不实现自动人物跟踪。

## 6. 素材索引

### 6.1 信任边界

CLI 在扫描前必须：

1. 对挂载根和 `sourceRoot` 执行 `realpath`。
2. 确认挂载根存在且 `sourceRoot` 是其后代目录。
3. 拒绝符号链接逃逸出素材根。
4. 仅以读模式打开 SMB 文件。
5. 将所有写路径约束在 `work/<job-id>` 和 `out/`。

`jobId` 只允许 ASCII 字母、数字、连字符和下划线，防止路径穿越。

### 6.2 文件过滤

接受扩展名（不区分大小写）：`.mp4`、`.mov`、`.m4v`。

排除：

- `.accelerate`
- `.DS_Store`
- `Thumbs.db`
- `*.lnk`
- `$RECYCLE.BIN`
- `System Volume Information`
- 以 `._` 开头的 AppleDouble 文件

遍历结果使用 `Intl.Collator("zh-CN", {numeric: true, sensitivity: "base"})` 自然排序，确保 `1, 2, 10` 顺序正确。

### 6.3 增量缓存

源 ID 由相对路径、文件大小和 `mtimeMs` 的 SHA-256 生成。若同一相对路径的大小和修改时间未变化，则直接复用已有 ffprobe 结果。

重复检测只对文件大小相同的候选组执行：读取首 1 MiB 和末 1 MiB，计算 SHA-256。小于 2 MiB 的文件计算全文件 SHA-256。快速指纹一致只标记为“重复候选”；正式排除前仍需人工确认或全文件哈希。

### 6.4 探测字段

每个文件用 `ffprobe` 获取：

- 容器和视频编码。
- 时长、宽高、旋转和平均帧率。
- 像素格式与色彩信息（存在时）。
- 是否存在音轨及采样率。
- ffprobe 退出码和错误文本。

单个文件失败不会终止整个扫描；它被标记为 `failed` 并保留明确错误。挂载断开、根目录不可读或没有任何可用视频则终止阶段并返回非零退出码。

## 7. 代理与联系表

### 7.1 代理

代理保留原始宽高比，最长边不超过 1920 像素，统一为：

- H.264
- `yuv420p`
- 30fps
- CRF 18
- 无音频

代理写入 `work/<job-id>/public/proxies/`，文件名使用源 ID。源时间仍以秒记录，因此代理帧率变化不会改变 Timeline 的入出点语义。

最终 MVP 渲染使用本机代理而不是直接读取 SMB 母片，优先保证 Studio 预览和重复渲染稳定。需要更高母版质量时，再增加“从源文件重连渲染”阶段。

### 7.2 联系表

抽帧规则：

- 时长不超过 8 秒：中点 1 帧。
- 8–30 秒：20%、50%、80% 各 1 帧。
- 超过 30 秒：每 10 秒 1 帧，最多 8 帧。

每帧烧录相对路径和时间码，拼成单个 JPEG。联系表仅用于选择，不改变源视频。

## 8. Codex 选镜

`skills/auto-edit-product-video/SKILL.md` 继续作为决策入口，执行顺序固定：

1. 读取任务 JSON、用户脚本、`index.json` 和联系表。
2. 将脚本拆为钩子、主体卖点、证明镜头和 CTA；不得扩写功效。
3. 从目录层级提取标签，并应用商品别名，例如“剃须刀/刮胡刀”。
4. 先保证 SKU/商品正确，再比较卖点相关性、画质和视觉变化。
5. 从联系表选择源文件与时间区间，每个普通镜头默认 2–4 秒。
6. 同一源时间区间不得重复；快速指纹相同的候选不得同时使用。
7. 低置信度选择写入 `result.json` 并将状态置为 `needs_review`。
8. 生成一份 `timeline.json`；真实模式禁止 `assetShotId: null`。
9. 用户确认候选镜头后，将 Timeline 状态改为 `approved`；`render` 拒绝其他状态。

若某个脚本段没有可信素材，流程必须停止要求人工选择，不得回退到演示占位场景或无关产品。

## 9. Timeline 生成规则

- `schemaVersion` 固定为 `1`。
- 画布固定为 1080×1920，帧率固定为 30fps。
- 总时长为 600–1200 帧，即 20–40 秒。
- 镜头按播放顺序连续排列，不允许重叠或意外空白。
- 钩子优先控制在前 3 秒。
- 普通镜头 2–4 秒；必要的口播/证明镜头可更长，但不得超过源范围。
- 字幕只来自用户脚本，并按脚本段对应的镜头区间排布。
- 首版所有素材音频静音，并强制输出静音 AAC 音轨。
- `voiceover` 和 `music` 均保持 `source: null`、`state: "not_configured"`。
- 每个真实镜头必须可追溯到 `AssetShot.id`、源路径和源入出点。

## 10. Remotion 渲染

### 10.1 Composition

保留 `ProductMarketingDemo`，新增 `ProductMarketingReal`：

- `defaultProps` 复用现有演示 Timeline，仅保证 Studio 能发现 Composition；`render` 子命令明确拒绝演示 SKU、`assetShotId: null` 和未批准状态，因此演示默认值不能成为正式输出。
- `calculateMetadata()` 从输入 Timeline 返回实际 `durationInFrames`、宽、高和 fps。
- 每个剪辑用 `<Sequence>` 放置。
- 实拍画面用现有 `remotion` 包中的 `<OffthreadVideo>`，不新增媒体依赖。
- `trimBefore` 和 `trimAfter` 由源秒数乘 Timeline fps 换算。
- `fit` 和焦点坐标控制 `object-fit` 与 `object-position`。
- 字幕、品牌角标和 CTA 继续复用现有组件。

Remotion 官方文档确认 `<OffthreadVideo>` 可在渲染期间使用 FFmpeg 精确抽帧，支持 H.264/H.265，并可通过 `trimBefore`/`trimAfter` 裁切：[OffthreadVideo](https://www.remotion.dev/docs/offthreadvideo)。

### 10.2 命令边界

渲染通过现有 Remotion CLI 完成：

- `--props` 指向 `work/<job-id>/props.json`。
- `--public-dir` 指向 `work/<job-id>/public`。
- 输出编码为 H.264、`yuv420p`，并启用静音音轨。
- `--overwrite=false`，避免覆盖已审核成片。

官方 CLI 支持将 JSON 文件作为 `--props`，并允许覆盖 public 目录：[Remotion render CLI](https://www.remotion.dev/docs/cli/render)。动态时长使用 `calculateMetadata()`：[Variable duration and dimensions](https://www.remotion.dev/docs/dynamic-metadata)。

CLI 先渲染到 `out/<job-id>.partial.mp4`。只有后置 QC 全部通过，才原子重命名为 `out/<job-id>.mp4`。

## 11. 验证与失败处理

### 11.1 渲染前阻断校验

保留现有 `validateTimeline(timeline)` 签名并补齐 Timeline 内部规则；另新增 `validateRenderJob(props)` 先调用它，再检查跨实体和文件规则，避免破坏 Web 现有调用方。

`validateTimeline()` 检查：

- Clip 和 Subtitle ID 唯一。
- 所有帧范围合法且位于 Timeline 内。
- 镜头按顺序连续，无重叠和空白。
- 字幕不越界。
- `fit` 合法，焦点位于 `0..1`。

`validateRenderJob()` 检查：

- 真实 Timeline 的 `assetShotId` 不为 `null`。
- 每个 `assetShotId` 都能解析到 `AssetShot`。
- 每个源入出点位于 `AssetShot` 范围内。
- 代理存在且可读。
- 总时长、画布和 fps 符合 MVP 目标。
- Timeline 状态为 `approved`，SKU 不是演示 SKU。

任一错误都阻止 Remotion 启动，并写入 `result.json`。

### 11.2 渲染后 QC

对 `.partial.mp4` 执行：

1. 确认文件存在且非零。
2. `ffprobe` 验证 H.264、1080×1920、30fps、AAC 和 20–40 秒时长。
3. 用 FFmpeg 完整解码到空输出，确认无解码错误。
4. 在第一帧、最后一帧及每个切点后一帧抽图，生成 `contacts/final-cut.jpg`。
5. 记录最终大小、时长、编码、渲染命令、耗时和所用镜头。

任何 QC 失败都保留 `.partial.mp4` 和日志用于诊断，但不生成最终文件。

### 11.3 任务状态

`result.json` 的状态只有：

```text
index_failed | indexed | prepare_failed | prepared | needs_review |
validation_failed | render_failed | qc_failed | complete
```

每次运行覆盖同一任务的 `result.json`，但不覆盖最终 MP4。

## 12. 测试策略

不增加测试框架。确定性 CLI 使用 Node 内置 `node:test` 和 `assert`：

- 自然排序与排除规则。
- 路径逃逸和非法 `jobId`。
- ffprobe JSON 解析与错误状态。
- 缓存命中判断。
- 同尺寸文件快速指纹分组。
- Timeline 连续性、源范围和真实素材校验。

`.mjs` 单元使用 Node 直接执行。TypeScript 的 `validateTimeline()` 和 `validateRenderJob()` 通过 Remotion CLI 的 Composition 元数据求值执行集成检查：合法 Props 必须成功，非法 Props 必须非零退出；不增加 TypeScript 运行器或测试框架。

本地集成测试使用现有 `out/demo-product.mp4`，不依赖 SMB。真实烟雾测试使用 `S16素材`，并在执行前后比较源目录文件清单、大小和修改时间，证明流程未写入 SMB。

每个阶段都必须继续通过：

```bash
npm run typecheck
```

## 13. 分阶段实施与验收

### 阶段 0：保护现有基线

**交付：** 保持演示 Composition 和 Web 演示可用。  
**验收：** `npm run typecheck` 通过；`out/demo-product.mp4` 仍可被 ffprobe 识别为 1080×1920、30fps。

### 阶段 1：单批次索引

**交付：** 任务配置、扫描 CLI、`AssetSource/AssetIndex`、缓存和测试。  
**验收：** `S16素材` 正确得到 2 个可用源；第二次扫描报告 `cached=2, probed=0`；SMB 文件清单、大小和修改时间不变；挂载缺失时非零退出。

### 阶段 2：代理与联系表

**交付：** 本机 H.264 代理、抽帧联系表和阶段恢复。  
**验收：** 两个 S16 视频都产生本机代理和带时间码联系表；代理为 H.264/yuv420p/30fps；D 盘没有新增文件。

### 阶段 3：Codex 选镜与 Timeline

**交付：** 中性烟雾脚本、更新后的项目技能、真实 Timeline Props 和完整校验。  
**验收：** 一次 Codex 工作流生成一份 600–1200 帧 Timeline；所有镜头可追溯；无 `assetShotId: null`；无占位场景；用户审核后状态为 `approved`；校验通过。

### 阶段 4：真实素材渲染与 QC

**交付：** `ProductMarketingReal`、渲染子命令、后置 QC。  
**验收：** 生成 `out/s16-smoke.mp4`；H.264/AAC、1080×1920、30fps、20–40 秒；完整解码成功；切点联系表存在；`result.json.status` 为 `complete`。

### 阶段 5：扩大到 76 个素材

**交付：** 对 `4.27拍摄视频` 的规模验证和问题修正。  
**验收：** 76 个 MP4 全部按自然序建立索引；二次扫描报告 `cached=76, probed=0`；候选召回不会因 `11 (10)`、`11 (2)` 等名称产生字典序错误；能够产出并渲染一条真实 Timeline。

## 14. 后续升级触发条件

仅在 MVP 数据证明需要时增加：

- **全 NAS 增量索引：** 单批次流程稳定，且日常确实需要跨批次召回。
- **全文件哈希：** 快速指纹产生误判或需要自动删除重复项；删除仍需单独授权。
- **源文件重连渲染：** 代理成片质量无法满足发布要求。
- **TTS/BGM：** 用户提供服务、授权和明确音色/音乐要求。
- **三候选：** 一条草稿无法满足审核效率。
- **数据库与队列：** 单机文件任务出现并发、恢复或查询瓶颈。
- **Web 编辑器：** Studio 和成片联系表无法满足人工审核。
- **主体跟踪与自动重构图：** 横屏素材居中裁切的误切率可量化且不可接受。

## 15. 完成定义

本设计的 MVP 只有在以下条件全部成立时完成：

- 指定批次可以只读索引、缓存、生成代理和联系表。
- Codex 能从用户脚本和真实素材生成一份可追溯 Timeline。
- 所有阻断校验通过后，Remotion 才能渲染。
- 输出 MP4 通过格式、时长、完整解码和切点抽帧 QC。
- `S16素材` 和 `4.27拍摄视频` 两个验收批次均通过。
- SMB 源目录没有任何由本流程造成的写入。
- 未配置能力不会以占位或伪造结果冒充成功。
