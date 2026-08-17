# CTA 视觉质量门实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不引入计算机视觉模型的前提下，为最终 CTA 镜头增加可追溯的首帧、中帧、末段和末帧视觉复核门；复核未通过时保留 partial，禁止生成最终 MP4。

**Architecture:** 继续使用 `result.json.reviewNotes.selectedShots[].purpose === "cta"` 识别 CTA，并要求它唯一且对应 Timeline 最后一个 clip。技术 QC 复用现有 `MediaContactSheet`，在 `final-cut.jpg` 增加 CTA START、MIDDLE、PRE-END、END 四个采样帧；`result.json.reviewNotes.ctaQuality` 与本次 render 的 `propsSha256` 绑定，只有全部人工/Codex 视觉检查通过，`qcRender()` 才原子提升 partial。缺失、失败或过期的视觉复核属于 `needs_review`，不是 `qc_failed`。

**Tech Stack:** Node.js 20+、原生 `node:test`、Remotion 4.0.496、FFmpeg/ffprobe、现有原子 JSON/result 写入链路；不增加 npm 依赖。

## Global Constraints

- `sourceRoot` 和 SMB 素材始终只读；所有新增或更新内容只能位于仓库的 `work/`、`out/`、`scripts/`、`skills/` 和 `docs/`。
- 不引入 OpenCV、目标检测、分割模型、第三方视觉 API 或新的 npm 包；MVP 的视觉判断由 Codex 或人工完成，CLI 只校验结构和状态。
- CTA 必须恰好一个，并且是 `timeline.clips` 的最后一项；不依赖 clip ID、文件名或 CTA 文案猜测。
- CTA 采样固定为 START、MIDDLE、PRE-END、END；PRE-END 与 END 相隔最多 15 帧，即 30fps 下的 0.5 秒。
- 商品在四个 CTA 采样帧中都必须可辨；PRE-END 到 END 不得继续移出画面；关键商品不得被画面边缘裁断，主体不得主要位于左右最外侧 10% 区域。
- CTA 复核必须绑定当前 `render.propsSha256`、CTA clip ID 和精确采样帧；Timeline、Props 或 CTA 范围变化后，旧复核不得复用。
- 缺少复核或任一检查为 false 时：保留 `.partial.mp4` 和 `final-cut.jpg`，最终 MP4 不存在，`result.status` 为 `needs_review`。
- H.264、yuv420p、1080×1920、30fps、AAC、20–40 秒、完整解码和帧数检查保持原样。
- 当前目录执行 `git status` 返回“not a git repository”；实施时不得运行 `git init`。每个任务的 commit 步骤仅在有效 Git 元数据恢复后执行。

---

## 当前证据与最小范围

当前链路已经具备可复用能力：

- `scripts/lib/render-qc.mjs:121` 的 `buildContactSamples()` 已生成最终联系表。
- `packages/remotion-video/src/contact-sheet.tsx:15` 已支持 1–64 个采样帧，不需要修改 Remotion 组件。
- `scripts/lib/render-qc.mjs:155` 的 `qcRender()` 已完成技术 QC、生成联系表并原子提升 partial。
- `scripts/lib/job.mjs:169` 的 `writeResult()` 会保留已有 `reviewNotes`。
- `scripts/auto-edit.mjs:112` 当前在 `qcRender()` 返回后无条件写入 `complete`；这是本计划的主要改动点。

本计划只修改五个现有文件：

- `scripts/lib/render-qc.mjs`：CTA 定位、reviewNotes 一致性、采样、视觉复核和 partial 提升门。
- `scripts/lib/render-qc.test.mjs`：纯函数与 partial 提升集成测试。
- `scripts/auto-edit.mjs`：根据 `reviewRequired` 写入 `needs_review` 或 `complete`。
- `scripts/auto-edit.test.mjs`：QC 状态分支测试。
- `skills/auto-edit-product-video/SKILL.md`：选镜元数据及两次 QC 的操作契约。

明确不修改：

- `packages/shared/src/index.ts`
- `packages/core/src/validate-timeline.ts`
- `packages/remotion-video/src/contact-sheet.tsx`
- `packages/remotion-video/src/product-marketing-real.tsx`

## ReviewNotes 数据契约

`result.json.reviewNotes` 使用以下精确形状：

```ts
interface ReviewNotes {
  selectedShots: Array<{
    clipId: string;
    assetShotId: string;
    sourcePath: string;
    sourceInSeconds: number;
    sourceOutSeconds: number;
    purpose: "hook" | "body" | "proof" | "cta";
    confidence: number;
    reviewState: "unreviewed" | "confirmed" | "rejected";
  }>;
  lowConfidence: Array<{
    clipId: string;
    reason: string;
  }>;
  ctaQuality?: {
    clipId: string;
    propsSha256: string;
    frames: {
      start: number;
      middle: number;
      preEnd: number;
      end: number;
    };
    productVisible: {
      start: boolean;
      middle: boolean;
      preEnd: boolean;
      end: boolean;
    };
    endingStable: boolean;
    subjectWithinSafeArea: boolean;
    reviewState: "confirmed" | "rejected";
    note: string;
  };
}
```

`AssetShot.confidence/reviewState` 继续表示素材索引级元数据，不把逐 clip 的选镜置信度写回整个源素材。最终 `qc.usedShots` 的 `confidence/reviewState` 改为来自 `reviewNotes.selectedShots`；CTA 的最终 `reviewState` 由 `ctaQuality.reviewState` 覆盖。

---

### Task 1: 校验选镜记录并可靠定位 CTA

**Files:**

- Modify: `scripts/lib/render-qc.mjs:16-85`
- Test: `scripts/lib/render-qc.test.mjs:25-126`

**Interfaces:**

- Consumes: `Timeline`、`AssetIndex`、`result.reviewNotes`
- Produces: `findCtaClip(timeline, index, reviewNotes) => {clip, selection, selections}`
- Produces: `buildUsedShots(timeline, index, reviewNotes, ctaReview) => UsedShot[]`

- [ ] **Step 1: 添加失败测试，覆盖唯一 CTA、末 clip 和逐项匹配**

在 `scripts/lib/render-qc.test.mjs` 的 import 中加入 `findCtaClip`、`buildUsedShots`，并在现有 fixture 后增加：

```js
const selectedShot = {
  clipId: "clip-1",
  assetShotId: "shot-1",
  sourcePath: "/Volumes/share/1.mp4",
  sourceInSeconds: 0,
  sourceOutSeconds: 20,
  purpose: "cta",
  confidence: 0.86,
  reviewState: "confirmed",
};

const reviewNotes = {
  selectedShots: [selectedShot],
  lowConfidence: [],
};

const index = {
  sources: [{id: "source-1", quickFingerprint: null}],
  shots: [validProps.shots["shot-1"]],
};

test("CTA selection is unique, traceable, and is the final clip", () => {
  const found = findCtaClip(timeline, index, reviewNotes);
  assert.equal(found.clip.id, "clip-1");
  assert.equal(found.selection.confidence, 0.86);

  assert.throws(
    () => findCtaClip(timeline, index, {...reviewNotes, selectedShots: []}),
    /selected shot/i,
  );
  assert.throws(
    () => findCtaClip(timeline, index, {
      ...reviewNotes,
      selectedShots: [selectedShot, {...selectedShot, clipId: "duplicate"}],
    }),
    /selected shot/i,
  );
  assert.throws(
    () => findCtaClip(timeline, index, {
      ...reviewNotes,
      selectedShots: [{...selectedShot, assetShotId: "wrong"}],
    }),
    /assetShotId/i,
  );
  assert.throws(
    () => findCtaClip(timeline, index, {
      ...reviewNotes,
      selectedShots: [{...selectedShot, sourceOutSeconds: 19}],
    }),
    /source range/i,
  );
  assert.throws(
    () => findCtaClip(timeline, index, {
      ...reviewNotes,
      selectedShots: [{...selectedShot, reviewState: "unreviewed"}],
    }),
    /confirmed/i,
  );
});

test("CTA purpose must belong to the final Timeline clip", () => {
  const twoClips = {
    ...timeline,
    clips: [
      {...timeline.clips[0], id: "clip-cta", durationInFrames: 300, sourceOutSeconds: 10},
      {...timeline.clips[0], id: "clip-body", startFrame: 300, durationInFrames: 300, sourceInSeconds: 10},
    ],
  };
  const notes = {
    selectedShots: [
      {...selectedShot, clipId: "clip-cta", sourceOutSeconds: 10},
      {...selectedShot, clipId: "clip-body", sourceInSeconds: 10, purpose: "body"},
    ],
    lowConfidence: [],
  };
  assert.throws(() => findCtaClip(twoClips, index, notes), /final clip/i);
  assert.throws(() => findCtaClip(twoClips, index, {
    ...notes,
    selectedShots: notes.selectedShots.map((selection) => ({...selection, purpose: "cta"})),
  }), /exactly one CTA/i);
});
```

- [ ] **Step 2: 运行测试，确认新导出缺失**

Run:

```bash
node --test scripts/lib/render-qc.test.mjs
```

Expected: FAIL，错误包含 `does not provide an export named 'findCtaClip'`。

- [ ] **Step 3: 实现最小的一致性校验**

在 `scripts/lib/render-qc.mjs` 的基础 helper 后加入：

```js
const PURPOSES = new Set(["hook", "body", "proof", "cta"]);
const REVIEW_STATES = new Set(["unreviewed", "confirmed", "rejected"]);
const sameSecond = (left, right) =>
  Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.001;

export const findCtaClip = (timeline, index, reviewNotes) => {
  const selectedShots = reviewNotes?.selectedShots;
  if (!Array.isArray(selectedShots) || selectedShots.length !== timeline.clips.length) {
    throw new Error("Review notes must contain exactly one selected shot for every Timeline clip.");
  }

  const shots = new Map(index.shots.map((shot) => [shot.id, shot]));
  const selections = new Map();
  for (const selection of selectedShots) {
    if (selections.has(selection.clipId)) {
      throw new Error(`Review notes contain duplicate selected shot ${selection.clipId}.`);
    }
    if (!PURPOSES.has(selection.purpose)) {
      throw new Error(`Selected shot ${selection.clipId} has an invalid purpose.`);
    }
    if (!Number.isFinite(selection.confidence) || selection.confidence < 0 || selection.confidence > 1) {
      throw new Error(`Selected shot ${selection.clipId} confidence must be 0..1.`);
    }
    if (!REVIEW_STATES.has(selection.reviewState)) {
      throw new Error(`Selected shot ${selection.clipId} has an invalid reviewState.`);
    }
    if (selection.reviewState !== "confirmed") {
      throw new Error(`Selected shot ${selection.clipId} must be confirmed before rendering.`);
    }
    selections.set(selection.clipId, selection);
  }

  for (const clip of timeline.clips) {
    const selection = selections.get(clip.id);
    const shot = shots.get(clip.assetShotId);
    if (!selection) throw new Error(`Clip ${clip.id} has no selected shot review.`);
    if (!shot) throw new Error(`Clip ${clip.id} references missing shot ${clip.assetShotId}.`);
    if (selection.assetShotId !== clip.assetShotId) {
      throw new Error(`Selected shot ${clip.id} assetShotId does not match the Timeline.`);
    }
    if (selection.sourcePath !== shot.sourcePath) {
      throw new Error(`Selected shot ${clip.id} sourcePath does not match the index.`);
    }
    if (
      !sameSecond(selection.sourceInSeconds, clip.sourceInSeconds) ||
      !sameSecond(selection.sourceOutSeconds, clip.sourceOutSeconds)
    ) {
      throw new Error(`Selected shot ${clip.id} source range does not match the Timeline.`);
    }
  }

  const ctaSelections = selectedShots.filter((selection) => selection.purpose === "cta");
  if (ctaSelections.length !== 1) throw new Error("Review notes must contain exactly one CTA selection.");
  const clip = timeline.clips.at(-1);
  const selection = ctaSelections[0];
  if (!clip || selection.clipId !== clip.id) throw new Error("CTA selection must be the final clip.");
  return {clip, selection, selections};
};
```

修改 `validateWithRemotion()`，把 `result.json` 纳入并行读取，并在写 Props 之前校验：

```js
const [index, timeline, scriptText, result] = await Promise.all([
  readJson(paths.indexPath),
  readJson(paths.timelinePath),
  readFile(config.scriptPath, "utf8"),
  readJson(paths.resultPath),
]);

findCtaClip(timeline, index, result.reviewNotes);
```

- [ ] **Step 4: 增加 usedShots 来源修正并验证**

在 `scripts/lib/render-qc.mjs` 加入：

```js
export const buildUsedShots = (timeline, index, reviewNotes, ctaReview) => {
  const shots = new Map(index.shots.map((shot) => [shot.id, shot]));
  const {clip: ctaClip, selections} = findCtaClip(timeline, index, reviewNotes);
  return timeline.clips.map((clip) => {
    const shot = shots.get(clip.assetShotId);
    const selection = selections.get(clip.id);
    return {
      clipId: clip.id,
      assetShotId: clip.assetShotId,
      sourceId: shot.sourceId,
      sourcePath: shot.sourcePath,
      sourceInSeconds: clip.sourceInSeconds,
      sourceOutSeconds: clip.sourceOutSeconds,
      confidence: selection.confidence,
      reviewState: clip.id === ctaClip.id
        ? (ctaReview.reviewRequired ? "unreviewed" : "confirmed")
        : selection.reviewState,
    };
  });
};
```

在测试中加入：

```js
test("usedShots reports per-clip review metadata instead of index defaults", () => {
  const used = buildUsedShots(timeline, index, reviewNotes, {reviewRequired: false});
  assert.equal(used[0].confidence, 0.86);
  assert.equal(used[0].reviewState, "confirmed");
});
```

Run:

```bash
node --test scripts/lib/render-qc.test.mjs
```

Expected: PASS；原有 Composition、格式、manifest 测试仍通过。

- [ ] **Step 5: 在 Git 可用时提交**

```bash
git add scripts/lib/render-qc.mjs scripts/lib/render-qc.test.mjs
git commit -m "feat: validate CTA selection metadata"
```

---

### Task 2: 增加 CTA 四帧采样与视觉复核判定

**Files:**

- Modify: `scripts/lib/render-qc.mjs:121-153`
- Test: `scripts/lib/render-qc.test.mjs:120-169`

**Interfaces:**

- Consumes: 最终 CTA `TimelineClip`、`reviewNotes.ctaQuality`、render `propsSha256`
- Produces: `ctaSampleFrames(clip) => {start, middle, preEnd, end}`
- Produces: `buildContactSamples(timeline, ctaClip) => Array<{frame, label}>`
- Produces: `evaluateCtaReview({reviewNotes, clip, propsSha256}) => CtaReviewResult`

- [ ] **Step 1: 写采样和失败矩阵测试**

在 `scripts/lib/render-qc.test.mjs` 的 import 中加入 `evaluateCtaReview`；将现有 `final contact samples cover first, cuts, and last` 测试替换为：

```js
test("final contact samples include CTA start, middle, pre-end, and end", () => {
  const twoClips = {
    ...timeline,
    clips: [
      {...timeline.clips[0], durationInFrames: 300, sourceOutSeconds: 10},
      {...timeline.clips[0], id: "clip-2", startFrame: 300, durationInFrames: 300, sourceInSeconds: 10},
    ],
  };
  const samples = buildContactSamples(twoClips, twoClips.clips[1]);
  assert.deepEqual(samples.map(({frame}) => frame), [0, 300, 301, 449, 584, 599]);
  assert.match(samples.find(({frame}) => frame === 584).label, /CTA PRE-END/);
  assert.match(samples.find(({frame}) => frame === 599).label, /CTA END/);
});
```

加入视觉复核测试：

```js
test("CTA review is bound to the render manifest and every visual check", () => {
  const frames = {start: 0, middle: 299, preEnd: 584, end: 599};
  const ctaQuality = {
    clipId: "clip-1",
    propsSha256: "hash",
    frames,
    productVisible: {start: true, middle: true, preEnd: true, end: true},
    endingStable: true,
    subjectWithinSafeArea: true,
    reviewState: "confirmed",
    note: "商品全程可见，末段稳定居中。",
  };

  assert.equal(evaluateCtaReview({
    reviewNotes: {...reviewNotes, ctaQuality},
    clip: timeline.clips[0],
    propsSha256: "hash",
  }).reviewRequired, false);

  for (const mutate of [
    (value) => { value.propsSha256 = "stale"; },
    (value) => { value.frames.end = 598; },
    (value) => { value.productVisible.start = false; },
    (value) => { value.productVisible.middle = false; },
    (value) => { value.productVisible.preEnd = false; },
    (value) => { value.productVisible.end = false; },
    (value) => { value.endingStable = false; },
    (value) => { value.subjectWithinSafeArea = false; },
    (value) => { value.reviewState = "rejected"; },
  ]) {
    const changed = structuredClone(ctaQuality);
    mutate(changed);
    assert.equal(evaluateCtaReview({
      reviewNotes: {...reviewNotes, ctaQuality: changed},
      clip: timeline.clips[0],
      propsSha256: "hash",
    }).reviewRequired, true);
  }

  assert.equal(evaluateCtaReview({
    reviewNotes,
    clip: timeline.clips[0],
    propsSha256: "hash",
  }).reviewRequired, true);
});
```

- [ ] **Step 2: 运行测试，确认新行为尚未实现**

Run:

```bash
node --test scripts/lib/render-qc.test.mjs
```

Expected: FAIL，缺少 `evaluateCtaReview` 导出，且联系表帧列表仍为 `[0, 301, 599]`。

- [ ] **Step 3: 实现固定 CTA 帧计算**

在 `scripts/lib/render-qc.mjs` 加入：

```js
export const ctaSampleFrames = (clip) => {
  const start = clip.startFrame;
  const end = start + clip.durationInFrames - 1;
  return {
    start,
    middle: start + Math.floor((clip.durationInFrames - 1) / 2),
    preEnd: Math.max(start, end - Math.min(15, clip.durationInFrames - 1)),
    end,
  };
};

export const buildContactSamples = (timeline, ctaClip) => {
  const frames = ctaSampleFrames(ctaClip);
  const candidates = [
    {frame: 0, label: "START · frame 0"},
    ...timeline.clips.slice(1).map((clip) => ({
      frame: Math.min(timeline.durationInFrames - 1, clip.startFrame + 1),
      label: `CUT · ${clip.id} · frame ${clip.startFrame + 1}`,
    })),
    {frame: timeline.durationInFrames - 1, label: `END · frame ${timeline.durationInFrames - 1}`},
    {frame: frames.start, label: `CTA START · ${ctaClip.id} · frame ${frames.start}`},
    {frame: frames.middle, label: `CTA MIDDLE · ${ctaClip.id} · frame ${frames.middle}`},
    {frame: frames.preEnd, label: `CTA PRE-END · ${ctaClip.id} · frame ${frames.preEnd}`},
    {frame: frames.end, label: `CTA END · ${ctaClip.id} · frame ${frames.end}`},
  ];
  return [...new Map(candidates.map((sample) => [sample.frame, sample])).values()]
    .sort((left, right) => left.frame - right.frame);
};
```

- [ ] **Step 4: 实现纯数据视觉复核判定**

在同一文件加入：

```js
export const evaluateCtaReview = ({reviewNotes, clip, propsSha256}) => {
  const expected = {
    clipId: clip.id,
    propsSha256,
    frames: ctaSampleFrames(clip),
  };
  const review = reviewNotes?.ctaQuality;
  const reasons = [];
  if (!review || typeof review !== "object") {
    reasons.push("CTA quality review is missing.");
  } else {
    if (review.clipId !== expected.clipId) reasons.push("CTA review clipId is stale.");
    if (review.propsSha256 !== expected.propsSha256) reasons.push("CTA review propsSha256 is stale.");
    for (const key of ["start", "middle", "preEnd", "end"]) {
      if (review.frames?.[key] !== expected.frames[key]) reasons.push(`CTA review frame ${key} is stale.`);
      if (review.productVisible?.[key] !== true) reasons.push(`CTA product is not confirmed at ${key}.`);
    }
    if (review.endingStable !== true) reasons.push("CTA ending is not confirmed stable.");
    if (review.subjectWithinSafeArea !== true) reasons.push("CTA subject is not confirmed inside the safe area.");
    if (review.reviewState !== "confirmed") reasons.push("CTA reviewState is not confirmed.");
    if (typeof review.note !== "string" || review.note.trim().length === 0) {
      reasons.push("CTA review note must be a non-empty string.");
    }
  }
  return {
    reviewRequired: reasons.length > 0,
    reviewState: reasons.length > 0 ? "unreviewed" : "confirmed",
    reasons,
    expected,
  };
};
```

- [ ] **Step 5: 运行测试并提交**

```bash
node --test scripts/lib/render-qc.test.mjs
git add scripts/lib/render-qc.mjs scripts/lib/render-qc.test.mjs
git commit -m "feat: sample and assess CTA ending"
```

Expected: 所有 `render-qc` 测试通过；Git 不可用时仅跳过两条 Git 命令。

---

### Task 3: 在视觉复核前禁止 partial 提升

**Files:**

- Modify: `scripts/lib/render-qc.mjs:155-215`
- Modify: `scripts/auto-edit.mjs:106-118`
- Test: `scripts/lib/render-qc.test.mjs`
- Test: `scripts/auto-edit.test.mjs`

**Interfaces:**

- Consumes: 技术 QC 结果、`result.reviewNotes`、render manifest
- Produces: `qcRender()` 返回 `reviewRequired: boolean` 和 `ctaReview.expected`
- Produces: `qcStatus(qc) => "needs_review" | "complete"`

- [ ] **Step 1: 为 CLI 状态分支写失败测试**

在 `scripts/auto-edit.test.mjs` import 中加入 `qcStatus`，并增加：

```js
test("QC stays in needs_review until CTA review passes", () => {
  assert.equal(qcStatus({reviewRequired: true}), "needs_review");
  assert.equal(qcStatus({reviewRequired: false}), "complete");
});
```

Run:

```bash
node --test scripts/auto-edit.test.mjs
```

Expected: FAIL，缺少 `qcStatus` 导出。

- [ ] **Step 2: 添加 partial 保留和最终提升集成测试**

在 `scripts/lib/render-qc.test.mjs` import 中加入 `qcRender`，并增加所需的 `access`、`readFile` import。添加以下测试；它只使用临时目录和 fake 子进程，不启动 FFmpeg 或 Chromium：

```js
test("QC keeps partial before CTA approval and promotes it after approval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "auto-edit-cta-qc-"));
  const contactsDir = path.join(root, "contacts");
  await mkdir(contactsDir);
  const paths = {
    jobId: "cta-qc-test",
    workspaceRoot: root,
    contactsDir,
    timelinePath: path.join(root, "timeline.json"),
    indexPath: path.join(root, "index.json"),
    resultPath: path.join(root, "result.json"),
    propsPath: path.join(root, "props.json"),
    partialOutputPath: path.join(root, "job.partial.mp4"),
    outputPath: path.join(root, "job.mp4"),
    finalCutContactPath: path.join(contactsDir, "final-cut.jpg"),
  };
  const propsBytes = Buffer.from(`${JSON.stringify(validProps, null, 2)}\n`);
  const propsSha256 = createHash("sha256").update(propsBytes).digest("hex");
  const result = {render: {propsSha256}, reviewNotes};
  await Promise.all([
    writeFile(paths.timelinePath, JSON.stringify(timeline)),
    writeFile(paths.indexPath, JSON.stringify(index)),
    writeFile(paths.resultPath, JSON.stringify(result)),
    writeFile(paths.propsPath, propsBytes),
    writeFile(paths.partialOutputPath, "partial-video"),
  ]);

  const probe = {
    format: {duration: "20.04", size: "123456"},
    streams: [
      {codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: 1080, height: 1920, avg_frame_rate: "30/1", nb_read_frames: "600"},
      {codec_type: "audio", codec_name: "aac"},
    ],
  };
  const fakeExec = async (command, args) => {
    if (command === "ffprobe") return {stdout: JSON.stringify(probe)};
    if (command === "ffmpeg") return {stdout: ""};
    if (command.endsWith("node_modules/.bin/remotion")) {
      await writeFile(args[3], Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      return {stdout: ""};
    }
    throw new Error(`Unexpected command: ${command}`);
  };

  const waiting = await qcRender({paths, execFileImpl: fakeExec});
  assert.equal(waiting.reviewRequired, true);
  await access(paths.partialOutputPath);
  await assert.rejects(access(paths.outputPath), {code: "ENOENT"});

  const expected = waiting.ctaReview.expected;
  result.reviewNotes.ctaQuality = {
    ...expected,
    productVisible: {start: true, middle: true, preEnd: true, end: true},
    endingStable: true,
    subjectWithinSafeArea: true,
    reviewState: "confirmed",
    note: "CTA 四帧商品可见，末段稳定，主体位于安全区。",
  };
  await writeFile(paths.resultPath, JSON.stringify(result));

  const approved = await qcRender({paths, execFileImpl: fakeExec});
  assert.equal(approved.reviewRequired, false);
  assert.equal(await readFile(paths.outputPath, "utf8"), "partial-video");
  await assert.rejects(access(paths.partialOutputPath), {code: "ENOENT"});
});
```

Run:

```bash
node --test scripts/lib/render-qc.test.mjs
```

Expected: FAIL；当前第一次 `qcRender()` 会直接 rename，无法保留 partial。

- [ ] **Step 3: 在 qcRender 中接入 CTA 门**

将 `assertRenderManifest(result, propsBytes)` 的返回值保存为 `propsSha256`，定位 CTA，并把原来的内联 `usedShots` 替换为以下顺序：

```js
const propsSha256 = assertRenderManifest(result, propsBytes);
const {clip: ctaClip} = findCtaClip(timeline, index, result.reviewNotes);

// ffprobe、完整解码保持现有顺序。

const samples = buildContactSamples(timeline, ctaClip);
// final-cut.jpg 生成和 JPEG 安全检查保持现有实现。

const ctaReview = evaluateCtaReview({
  reviewNotes: result.reviewNotes,
  clip: ctaClip,
  propsSha256,
});
const usedShots = buildUsedShots(
  timeline,
  index,
  result.reviewNotes,
  ctaReview,
);
const qcElapsedMs = Math.round(now() - started);

if (ctaReview.reviewRequired) {
  return {
    outputPath: null,
    partialOutputPath: paths.partialOutputPath,
    finalCutContactPath: paths.finalCutContactPath,
    ...media,
    qcElapsedMs,
    usedShots,
    reviewRequired: true,
    ctaReview,
  };
}

if (await exists(paths.outputPath)) {
  throw new Error(`Final output appeared during QC: ${paths.outputPath}`);
}
await rename(paths.partialOutputPath, paths.outputPath);
return {
  outputPath: paths.outputPath,
  partialOutputPath: null,
  finalCutContactPath: paths.finalCutContactPath,
  ...media,
  qcElapsedMs,
  usedShots,
  reviewRequired: false,
  ctaReview,
};
```

删除原先在视觉复核之前执行的 `rename(paths.partialOutputPath, paths.outputPath)` 和旧的 index 级 `usedShots` map。

- [ ] **Step 4: 修改 QC handler 的状态和 nextAction**

在 `scripts/auto-edit.mjs` 导出：

```js
export const qcStatus = (qc) =>
  qc.reviewRequired ? "needs_review" : "complete";
```

将 QC handler 改为：

```js
qc: async () => {
  const qc = await qcRender({paths});
  const status = qcStatus(qc);
  const nextAction = qc.reviewRequired
    ? `Review ${paths.finalCutContactPath}, record result.json reviewNotes.ctaQuality from qc.ctaReview.expected, then rerun qc.`
    : null;
  await writeResult(paths, status, {qc, nextAction, error: null});
  process.stdout.write(qc.reviewRequired
    ? `needs review ${paths.finalCutContactPath}\n`
    : `complete ${paths.outputPath}\n`);
},
```

明确写入 `nextAction: null`，防止第二次 QC 完成后残留旧的复核提示。

- [ ] **Step 5: 运行分层测试**

```bash
node --test --test-concurrency=1 scripts/lib/render-qc.test.mjs scripts/auto-edit.test.mjs
node --test --test-concurrency=1 scripts/auto-edit.test.mjs scripts/lib/*.test.mjs
npm run typecheck
```

Expected:

- CTA 复核缺失时，partial 仍存在、final 不存在。
- CTA 复核通过时，partial 被原子 rename 为 final。
- `reviewRequired` 对应 `needs_review`，通过对应 `complete`。
- 所有既有测试和四个 workspace typecheck 退出 0。

- [ ] **Step 6: 在 Git 可用时提交**

```bash
git add scripts/lib/render-qc.mjs scripts/lib/render-qc.test.mjs scripts/auto-edit.mjs scripts/auto-edit.test.mjs
git commit -m "feat: gate final output on CTA review"
```

---

### Task 4: 更新自动剪辑技能的复核契约

**Files:**

- Modify: `skills/auto-edit-product-video/SKILL.md:28-59`
- Modify: `skills/auto-edit-product-video/SKILL.md:73-93`

**Interfaces:**

- Consumes: 第一次 QC 返回的 `qc.ctaReview.expected` 与 `final-cut.jpg`
- Produces: 完整 `result.json.reviewNotes.ctaQuality`，供第二次 QC 校验

- [ ] **Step 1: 收紧选镜记录要求**

在 “Select one Timeline” 中明确加入以下规则：

```markdown
- `reviewNotes.selectedShots` 必须逐 clip 填写 `assetShotId`、精确源范围、`confidence` 和 `reviewState`。
- 必须恰有一个 `purpose: "cta"`，并且它对应 Timeline 最后一个 clip。
- Timeline 获得明确批准后，已确认的选镜写 `reviewState: "confirmed"`；仍未确认或已拒绝的镜头不得进入最终渲染。
```

- [ ] **Step 2: 把 Pass 2 改成两次 QC 门**

在 “Pass 2” 中写入以下精确流程：

```markdown
1. 运行 `node scripts/auto-edit.mjs run --config examples/jobs/4-27-scale.json --from validate`。
2. 如果状态为 `needs_review`，打开 `work/4-27-scale/contacts/final-cut.jpg`，定位 CTA START、MIDDLE、PRE-END、END 四格。
3. 只有四格商品都清晰可辨、PRE-END 到 END 稳定、关键商品未被边缘裁断且主体不主要位于左右最外侧 10% 时，才把 `qc.ctaReview.expected` 原样复制到 `reviewNotes.ctaQuality`，补齐四个可见性布尔值、稳定性、安全区、`reviewState: "confirmed"` 和真实说明。
4. 运行 `node scripts/auto-edit.mjs qc --config examples/jobs/4-27-scale.json`。
5. 只有 `result.status === "complete"` 且 final 存在、partial 不存在时才报告成片完成。
```

若任一 CTA 检查失败，记录 `reviewState: "rejected"` 和具体 `note`，保留当前 job 作为审计记录；修改 Timeline 时使用新 job ID，不提升旧 partial。

- [ ] **Step 3: 用本计划的 ReviewNotes 接口替换旧接口**

把技能文件第 73 行开始的旧 `ReviewNotes` 代码块替换为本计划“ReviewNotes 数据契约”中的完整接口，不保留缺少 `assetShotId`、`reviewState` 或 `ctaQuality` 的旧形状。

- [ ] **Step 4: 运行文档与代码回归**

```bash
rg -n 'purpose: "cta"|CTA START|CTA PRE-END|ctaQuality|propsSha256|reviewState' skills/auto-edit-product-video/SKILL.md
node --test --test-concurrency=1 scripts/auto-edit.test.mjs scripts/lib/*.test.mjs
npm run typecheck
```

Expected:

- `rg` 至少匹配上述六类契约关键词。
- 测试和 typecheck 全部通过。
- 技能不声称 CLI 会自动识别商品，也不要求新增视觉模型。

当前机器上并发 Remotion Composition 负例会偶发在 Chromium `Target.closeTarget` 阶段退出；相同 34 项测试在 `--test-concurrency=1` 下稳定通过，因此以上单并发命令是本计划的验收口径，不把浏览器关闭竞态误判为 CTA 逻辑失败。

- [ ] **Step 5: 在 Git 可用时提交**

```bash
git add skills/auto-edit-product-video/SKILL.md
git commit -m "docs: require CTA visual approval"
```

---

## 端到端验收场景

### 负例：当前 4.27 CTA

现有 `4-27-scale` 的 CTA 为 `666-15.mp4` 的 0–4 秒。新联系表应出现对应 CTA 四格；首格接近空桌面，末格商品贴左且留白过大，因此至少 `productVisible.start` 或 `subjectWithinSafeArea` 不能确认为 true。预期结果：

```text
out/4-27-scale.partial.mp4  保留
out/4-27-scale.mp4          不由新 job 生成
result.status               needs_review
qc.reviewRequired           true
```

现有已经完成的 `out/4-27-scale.mp4` 作为历史产物保留，不覆盖、不删除；新门禁只作用于实施后的新 job。

### 正例：稳定 CTA

一个 CTA 的四个采样帧均可见商品，PRE-END 与 END 构图稳定，主体位于安全区。第一次 QC 生成联系表并返回 `qc.ctaReview.expected`；Codex/人工按实际画面填入：

```json
{
  "clipId": "clip-cta-approved",
  "propsSha256": "由 qc.ctaReview.expected 提供的 64 位 SHA-256",
  "frames": {
    "start": 600,
    "middle": 659,
    "preEnd": 704,
    "end": 719
  },
  "productVisible": {
    "start": true,
    "middle": true,
    "preEnd": true,
    "end": true
  },
  "endingStable": true,
  "subjectWithinSafeArea": true,
  "reviewState": "confirmed",
  "note": "四个采样帧商品可见，最后 0.5 秒构图稳定，主体未贴边。"
}
```

上例中的 clip ID、hash 和 frames 只说明字段形状；实际复核必须逐字段复制该 job 的 `qc.ctaReview.expected`，不得手工沿用示例值。第二次 QC 的预期结果：

```text
partial                         不存在
final                           存在且非零
result.status                   complete
qc.reviewRequired               false
qc.usedShots CTA confidence     等于 selectedShots 对应 confidence
qc.usedShots CTA reviewState    confirmed
```

## 当前日产能基线

以下口径均为单台 Apple M4、10 核、24 GiB 内存、8 小时工作日；不包含上传、发布和平台审核。

当前可重复核验的数据：

| 项目 | 实测 |
|---|---:|
| 4.27 素材数与总时长 | 76 条，661.23 秒 |
| 76 条素材冷准备代理与联系表 | 约 507 秒 |
| 24 秒成片 Render | 32.719 秒 |
| 24 秒成片技术 QC | 9.709 秒 |
| 准备完成到 Timeline 写入 | 约 1,058 秒，包含选镜、交互和等待 |
| 首个代理开始到最终 result | 约 1,647 秒 |
| S16 21 秒成片 Render + QC | 24.476 秒 |

计算公式：

```text
日产量 = 28,800 秒 ÷
  (索引 + 代理准备 + 自动选镜 + CTA 视觉复核 + 验证/渲染/QC)
```

方向 3 实施后，首次 QC 生成联系表，复核后第二次 QC 才提升 final。按 4.27 较慢样本，纯机器核心约为：

```text
32.719 秒 Render + 2 × 9.709 秒 QC = 52.137 秒/条
```

因此采用以下生产口径：

| 档位 | 条件 | 8 小时产能 |
|---|---|---:|
| 可承诺 | 每条都是 76 素材冷任务，包含选镜与 CTA 视觉验收，并保留异常余量 | **15 条/天** |
| 当前观测区间 | 与 4.27 完整流程相近 | 15–17 条/天 |
| 同批素材已准备 | 复用已生成代理/联系表，仍包含 Codex/人工视觉验收 | 20–25 条/天 |
| 自动化目标 | 冷准备不变，自动选镜控制在 2–3 分钟且无人等待 | 约 38–40 条/天 |
| 技术天花板 | 代理全热、Timeline 已就绪、无等待，只跑 Render 和两次 QC | 约 500–550 条/天 |

“技术天花板”不是可交付成片承诺；当前唯一足够完整的端到端样本只支持先承诺 **15 条/8 小时工作日**。

存储也是实际约束：当前 76 素材 job 的代理约 892 MiB、联系表约 7.6 MiB、成片约 43 MiB。15 个互不复用的冷任务约增加 14 GiB/天；自动化目标 40 条约增加 36–40 GiB/天。队列达到该档位前，需要另立归档/清理方案，本计划不加入自动删除。

## 完成定义

- `findCtaClip()` 在 render 前阻断缺 CTA、多个 CTA、CTA 非末 clip 和 reviewNotes 漂移。
- `final-cut.jpg` 包含 CTA START、MIDDLE、PRE-END、END 四格及精确帧号。
- 视觉复核缺失、false、rejected、clip/hash/frame 过期时，partial 不提升且状态为 `needs_review`。
- 四格可见性、末段稳定、安全区和 manifest 全部通过后，第二次 QC 原子生成 final 并写 `complete`。
- `qc.usedShots` 使用逐 clip 的 selection confidence，CTA reviewState 与 `ctaQuality` 一致，不再显示错误的 `0/unreviewed`。
- `node --test --test-concurrency=1 scripts/auto-edit.test.mjs scripts/lib/*.test.mjs` 和 `npm run typecheck` 全部通过。
- 4.27 当前弱 CTA 能作为负例被拦截，历史成片不被覆盖或删除。

## 本轮明确不做

- 不做商品自动检测、主体分割或空桌面数值评分。
- 不自动改入出点、不自动换 CTA 素材、不自动重渲染新 Timeline。
- 不增加队列、并行渲染、上传、发布或平台审核。
- 不自动删除代理、联系表、partial 或历史成片。

当 15 条/天的流程连续运行并积累至少 20 条 CTA 复核样本后，再根据实际误拦截和漏拦截数据决定是否值得加入视觉模型；在此之前，结构化人工/Codex 门禁已经覆盖当前问题。
