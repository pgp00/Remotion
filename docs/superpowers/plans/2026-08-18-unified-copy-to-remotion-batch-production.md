# 文案到 Remotion 单条/批量统一生产 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有单条 Remotion 生产内核与 S5Max 批量协调器合并成一个用户工作流：用户只给原始文案和模式，系统可随机生产 1 条或经单样片批准后生产默认 300 条跨历史双重唯一成片。

**Architecture:** 保留 `scripts/produce.mjs` 作为不可复制的单条生产内核；扩展 `scripts/s5max-daily.py` 作为唯一协调层，负责内部文案池、容量证明、历史签名、一次性随机批次、本地 TTS 预热、精确选片、样片闸门和断点续跑。`skills/auto-edit-product-video` 是唯一用户入口，内部 CSV、ProductionPlan 和 manifest 都由 Codex 创建。

**Tech Stack:** Python 3 标准库、Node.js >=20、IndexTTS 2.5、本地 SMB、Remotion、FFmpeg/FFprobe、`unittest`、`node:test`。

## Global Constraints

- 用户唯一必需输入是未经分类的原始文案；模式未指定时默认单条。
- 单条固定 1 条；批量默认目标 300，昂贵阶段前必须报告容量、耗时和空间并等待数量确认。
- 每条结构固定为 `1 hook + 2–4 个不同类别卖点/场景 + 1 CTA`。
- 文案只能拆句、分类、排序、去重和轻量顺句，不得新增产品事实、数字、价格、赠品或承诺。
- 每批只随机一次并封存；重试、重启和续跑不得重新组合。
- 文案最终文本和完整镜头序列都必须避开当前批次、已预留批次和所有历史正式成片。
- 素材仅来自本地 SMB；语义匹配优先，容量不足时扩展并视觉核验 SMB，禁止网络素材回退。
- 语音仅使用本地 IndexTTS 2.5；禁止网络 TTS、静音、截断、拉伸和静默降级。
- 30fps；非末句恰好 5 帧停顿；字幕只覆盖语音帧；语音期间镜头必须有真实源帧。
- 最终 MP4 只能由 `ProductMarketingProduction` Remotion Composition 编码并通过现有 QC。
- 批量先渲染 1 条代表性样片；拒绝时归档整批并释放预留，批准后才渲染剩余 `targetCount - 1` 条。
- 不新增数据库、网页、上传、投放、第二套代理、第二套 TTS、第二套渲染或第二套 QC。
- 保留现有 `work/`、`out/` 产物，不迁移、不覆盖、不删除。

## File Map

- Modify: `scripts/s5max-daily.py` — 唯一单条/批量协调器、状态与历史。
- Modify: `scripts/test_s5max_daily.py` — 协调器纯逻辑、状态、恢复和 CLI 测试。
- Modify: `skills/auto-edit-product-video/SKILL.md` — 唯一用户工作流和样片批准规则。
- Modify: `skills/auto-edit-product-video/agents/openai.yaml` — 默认提示同步单条/批量行为。
- Modify: `skills/auto-edit-product-video/references/production-plan-contract.md` — 说明 ProductionPlan 的 `sourceText` 是某条已选组合，而非整个用户句子池。
- Modify: `scripts/skill-contract.test.mjs` — 锁定新的唯一入口合同。
- Modify: `docs/PROJECT_PLAN.md` — 记录统一生产入口和内部命令。
- Reuse unchanged: `scripts/produce.mjs`, `scripts/indextts25-batch.py`, `packages/remotion-video/src/production-contract.js`, `packages/remotion-video/src/production-video.tsx`, `scripts/lib/render-qc.mjs`, `scripts/asset-library.mjs`。

---

### Task 1: 让现有组合器支持单条、任意目标数量和一次性随机批次

**Files:**
- Modify: `scripts/s5max-daily.py:151-270`
- Modify: `scripts/test_s5max_daily.py:21-93`

**Interfaces:**
- Consumes: 现有内部 `category,text` CSV、素材矩阵、catalog 路径和音色路径。
- Produces: `plan_batch(*, batch_id, seed, copy_csv, materials_path, catalog_path, voice_path, count, forbidden)`；返回含 `batchId`、`seed`、`targetCount`、文案签名、画面签名和 ProductionPlan 的字典。
- `forbidden` 精确结构：`{"copy": set[str], "text": set[str], "visual": set[str]}`。
- 容量不足统一抛出 `CapacityError(exact, missing)`；后续预检不得解析异常文本。

- [ ] **Step 1: 写单条、固定随机种子和历史排除的失败测试**

在 `DailyPlanTest` 增加：

```python
def test_one_video_uses_one_locked_seed_and_avoids_history(self):
    module = load_module()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        csv_path, assets_path = fixture(root)
        common = dict(
            batch_id="single-a",
            seed="seed-a",
            copy_csv=csv_path,
            materials_path=assets_path,
            catalog_path="catalog.json",
            voice_path="voice.wav",
            count=1,
        )
        first = module.plan_batch(**common, forbidden={"copy": set(), "text": set(), "visual": set()})
        resumed = module.plan_batch(**common, forbidden={"copy": set(), "text": set(), "visual": set()})
        blocked = {
            "copy": {first["items"][0]["copySignature"]},
            "text": {first["items"][0]["textSignature"]},
            "visual": {first["items"][0]["visualSignature"]},
        }
        next_batch = module.plan_batch(**{**common, "batch_id": "single-b", "seed": "seed-b"}, forbidden=blocked)

    self.assertEqual(first, resumed)
    self.assertEqual(first["targetCount"], 1)
    self.assertIn(first["items"][0]["sellingPointCount"], (2, 3, 4))
    self.assertTrue(all(sentence["sourceText"] and sentence["normalizedText"] and sentence["sentenceId"]
                        for sentence in first["items"][0]["sourceSentences"]))
    self.assertNotEqual(first["items"][0]["copySignature"], next_batch["items"][0]["copySignature"])
    self.assertNotEqual(first["items"][0]["visualSignature"], next_batch["items"][0]["visualSignature"])
```

同时把现有 300 条测试的 `kwargs` 加上 `batch_id="batch-a"`、`seed="seed-a"` 和空 `forbidden`。

再增加一个强制走穷举回退的回归：

```python
def test_exhaustive_fallback_has_no_fixed_attempt_ceiling(self):
    module = load_module()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        csv_path, assets_path = fixture(root)
        with patch.object(module, "FAST_ATTEMPTS", 0):
            batch = module.plan_batch(
                batch_id="fallback", seed="fallback-seed", copy_csv=csv_path,
                materials_path=assets_path, catalog_path="catalog.json", voice_path="voice.wav",
                count=4, forbidden={"copy": set(), "text": set(), "visual": set()},
            )
    self.assertEqual(len(batch["items"]), 4)
    self.assertEqual(len({item["visualSignature"] for item in batch["items"]}), 4)
```

- [ ] **Step 2: 运行测试，确认 RED**

Run:

```bash
python3 -m unittest scripts/test_s5max_daily.py
```

Expected: FAIL，指出 `plan_batch()` 不接受 `batch_id`、`seed` 或 `forbidden`。

- [ ] **Step 3: 最小修改组合器入口和数量分布**

保留现有 `_pick_balanced`、`_smooth`、`_tts_text` 和候选循环；替换 `_selling_counts` 为：

```python
def _selling_counts(count, seed):
    if not isinstance(count, int) or isinstance(count, bool) or count < 1:
        raise ValueError("target count must be a positive integer")
    if count == 1:
        return [2 + _rank(seed, "single-selling-count") % 3]
    quarters = count // 4
    values = [2] * quarters + [3] * (count // 2) + [4] * (count - quarters - count // 2)
    random.Random(_rank(seed, "selling-counts")).shuffle(values)
    return values
```

保留 `category,text` 两列，但在 `load_copy_pool` 中同时保存原单元格与规范化文本；稳定 ID 只由类别和规范化文本决定：

```python
raw_text = (row.get("text") or "").strip()
text = _normalized_text(raw_text)
if not text:
    raise ValueError(f"empty text at CSV line {line}")
pools[category].append({
    "sentenceId": _sha(f"{category}\0{text}")[:16],
    "sourceText": raw_text,
    "normalizedText": text,
})
```

`_smooth` 从 `normalizedText` 读取字幕；manifest 的 `sourceSentences` 保留三字段，确保每句能回溯到原始 CSV 单元格：

```python
"sourceSentences": [{key: sentence[key] for key in ("sentenceId", "sourceText", "normalizedText")}
                    for sentence in selected_sentences],
```

增加结构化容量错误：

```python
class CapacityError(ValueError):
    def __init__(self, exact, missing):
        self.exact = exact
        self.missing = missing
        super().__init__(f"capacity exhausted at {exact}: {missing[0]['message']}")
```

将当前常量提取为 `FAST_ATTEMPTS = 10_000`。保留当前平衡选择作为达到目标的快速路径，但删除“尝试 10,000 次就当作耗尽”的语义。只有快速路径失败时才调用下面的惰性穷举；它按 seed 排序每一维，并遍历完整候选空间，因此不足目标时 `exact` 不是猜测值：

```python
def _seeded(items, seed, *salt, key=lambda value: value):
    return sorted(items, key=lambda value: (_rank(seed, *salt, key(value)), key(value)))


def _exhaustive_copy_candidates(pools, active, seed):
    hooks = _seeded(pools["hook"], seed, "all-hooks", key=lambda item: item["sentenceId"])
    ctas = _seeded(pools["cta"], seed, "all-ctas", key=lambda item: item["sentenceId"])
    counts = _seeded((2, 3, 4), seed, "all-counts")
    for selling_count in counts:
        combinations = _seeded(tuple(itertools.combinations(active, selling_count)), seed, "all-categories")
        for selected_categories in combinations:
            for template_index in _seeded(tuple(range(len(TEMPLATES))), seed, "all-templates"):
                priority = {category: position for position, category in enumerate(TEMPLATES[template_index])}
                ordered = tuple(sorted(selected_categories, key=priority.get))
                choices = [hooks, *(
                    _seeded(pools[category], seed, "all-copy", category,
                            key=lambda item: item["sentenceId"])
                    for category in ordered
                ), ctas]
                yield ordered, itertools.product(*choices)


def _exhaustive_visual_candidates(item, visual_pools, seed, audio_durations):
    choices = []
    for slot, (category, text) in enumerate(zip(item["categories"], item["subtitleTexts"])):
        required = audio_durations[_tts_text(text)] if audio_durations is not None else _estimated_voice_seconds(text)
        eligible = [clip for clip in visual_pools[category]
                    if clip["sourceOutSeconds"] - clip["sourceInSeconds"] >= required]
        choices.append(_seeded(eligible, seed, "all-visual", slot, key=lambda clip: clip["clipId"]))
    for selected in itertools.product(*choices):
        clip_ids = [clip["clipId"] for clip in selected]
        fingerprints = [clip["quickFingerprint"] for clip in selected]
        if len(set(clip_ids)) == len(clip_ids) and len(set(fingerprints)) == len(fingerprints):
            yield selected
```

快速路径失败后从这两个 generator 的开头重建结果、按 `copySignature`/`textSignature`/`visualSignature` 去重并避开 `forbidden`，达到 `count` 立即停止；只有 generator 完整结束仍不足时才抛 `CapacityError`。针对一个可手算的小 fixture 增加断言：请求 `exact + 1` 返回的 `capacityExact` 恰等于穷举得到的签名数，防止重新引入固定尝试上限。

把函数签名改为：

```python
def plan_batch(*, batch_id, seed, copy_csv, materials_path, catalog_path, voice_path, count=300, forbidden=None, audio_durations=None):
```

入口立即规范化集合：

```python
    forbidden = forbidden or {"copy": set(), "text": set(), "visual": set()}
    required_forbidden = {"copy", "text", "visual"}
    if set(forbidden) != required_forbidden or any(not isinstance(forbidden[key], set) for key in required_forbidden):
        raise ValueError("forbidden must contain copy, text, and visual sets")
    if not isinstance(batch_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", batch_id):
        raise ValueError("batch_id must be filename-safe")
    if not isinstance(seed, str) or not seed:
        raise ValueError("seed must be non-empty")
```

在文件 imports 加入 `re`。删除由日期和输入哈希派生 seed 的旧行；ID 改为：

```python
video_id = f"{PRODUCT_SKU}-{batch_id}-{index + 1:03d}"
```

候选接受条件必须同时避开历史：

```python
if (
    copy_signature not in copy_signatures
    and copy_signature not in forbidden["copy"]
    and text_signature not in text_signatures
    and text_signature not in forbidden["text"]
):
    break
```

候选循环耗尽时不再构造供程序解析的字符串，改为：

```python
raise CapacityError(len(items), [{
    "kind": "copy",
    "message": "add more hook, CTA, or selling sentences",
}])
```

画面接受条件改为：

```python
if visual_signature not in visual_signatures and visual_signature not in forbidden["visual"]:
    break
```

画面没有足够时长或组合耗尽时分别抛出 `CapacityError(index, [{"kind": "material", "category": category, "sentenceId": source_id, "requiredSeconds": required_seconds, "message": message}])`；`exact` 始终是已经完整生成的条数。

返回头部固定包含：

```python
{
    "schemaVersion": 2,
    "batchId": batch_id,
    "productSku": PRODUCT_SKU,
    "inputHash": input_hash,
    "seed": seed,
    "targetCount": count,
}
```

- [ ] **Step 4: 运行测试，确认 GREEN**

Run:

```bash
python3 -m unittest scripts/test_s5max_daily.py
```

Expected: `OK`，单条固定重跑一致，新 seed 避开旧签名，300 条分布仍为 75/150/75。

- [ ] **Step 5: 提交 Task 1**

```bash
git add scripts/s5max-daily.py scripts/test_s5max_daily.py
git commit -m "feat: generalize S5Max batch planning"
```

---

### Task 2: 定义有意义的镜头身份并读取跨历史签名

**Files:**
- Modify: `scripts/s5max-daily.py:79-125,220-252,273-334`
- Modify: `scripts/test_s5max_daily.py`

**Interfaces:**
- Consumes: 新批次 manifest、旧 `work/s5max-daily/*/manifest.json`、旧 `work/production/*/manifest.json` 和视觉核验素材矩阵。
- Produces: `history_signatures(workspace, excluding=None)`、`reserve_batch(workspace, manifest_path)`、`archive_batch(workspace, manifest_path, reason)`。
- 镜头身份优先使用素材矩阵中经视觉核验的 `clipId`；旧条目回退为 `assetId`。画面签名只使用有序 `clipId`，不使用文件名、编码、焦点或细小 trim 偏移。

- [ ] **Step 1: 写历史兼容、镜头身份和并发预留的失败测试**

增加测试：

```python
def test_history_reads_legacy_outputs_and_reserves_only_live_batches(self):
    module = load_module()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        legacy = root / "work/production/legacy/manifest.json"
        legacy.parent.mkdir(parents=True)
        output = root / "out/legacy.mp4"
        output.parent.mkdir(parents=True)
        output.write_bytes(b"verified-video")
        legacy.write_text(json.dumps({
            "sentences": [
                {"text": "旧文案。", "shot": {"sourceId": "asset-old"}},
                {"text": "旧收尾。", "shot": {"sourceId": "asset-cta"}},
            ],
            "output": {"path": str(output)},
        }, ensure_ascii=False), encoding="utf-8")
        live = root / "work/production-batches/live/manifest.json"
        live.parent.mkdir(parents=True)
        live.write_text(json.dumps({
            "schemaVersion": 2,
            "batchStatus": "sealed",
            "items": [{"id": "live-001", "copySignature": "copy-live", "textSignature": "text-live", "visualSignature": "visual-live"}],
        }), encoding="utf-8")
        archived = root / "work/production-batches/old/manifest.json"
        archived.parent.mkdir(parents=True)
        archived.write_text(json.dumps({
            "schemaVersion": 2,
            "batchStatus": "archived",
            "items": [{"id": "old-001", "copySignature": "ignored", "textSignature": "ignored", "visualSignature": "ignored"}],
        }), encoding="utf-8")

        history = module.history_signatures(root)

    self.assertIn("text-live", history["text"])
    self.assertIn("visual-live", history["visual"])
    self.assertNotIn("ignored", history["copy"])
    self.assertIn(module._text_signature(["旧文案。", "旧收尾。"]), history["text"])
    self.assertIn(module._sha("asset-old\0asset-cta"), history["visual"])
```

再增加真实的原子冲突测试：

```python
def test_second_batch_cannot_reserve_the_same_signatures(self):
    module = load_module()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        paths = []
        for name in ("first", "second"):
            path = root / f"work/production-batches/{name}/manifest.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({
                "schemaVersion": 2, "batchStatus": "audio_ready",
                "items": [{"id": f"{name}-001", "copySignature": "same-copy",
                           "textSignature": "same-text", "visualSignature": "same-visual"}],
            }), encoding="utf-8")
            paths.append(path)
        module.reserve_batch(root, paths[0])
        with self.assertRaisesRegex(ValueError, "history conflict"):
            module.reserve_batch(root, paths[1])
        self.assertEqual(json.loads(paths[0].read_text(encoding="utf-8"))["batchStatus"], "sealed")
```

在 fixture 的每个 clip 增加 `clipId`，并增加：

```python
def test_visual_signature_uses_ordered_meaningful_clip_ids_only(self):
    module = load_module()
    first = [{"clipId": "face-shave", "sourceInSeconds": 0.0},
             {"clipId": "blade-closeup", "sourceInSeconds": 0.0}]
    trim_changed = [{"clipId": "face-shave", "sourceInSeconds": 0.2},
                    {"clipId": "blade-closeup", "sourceInSeconds": 0.4}]
    self.assertEqual(module._visual_signature([clip["clipId"] for clip in first]),
                     module._visual_signature([clip["clipId"] for clip in trim_changed]))
    self.assertNotEqual(module._visual_signature(["face-shave", "blade-closeup"]),
                        module._visual_signature(["blade-closeup", "face-shave"]))
```

- [ ] **Step 2: 运行测试，确认 RED**

Run:

```bash
python3 -m unittest scripts/test_s5max_daily.py
```

Expected: FAIL，缺少 `history_signatures`，且当前 visual signature 仍包含 trim。

- [ ] **Step 3: 实现稳定签名与 manifest 扫描**

加入：

```python
from contextlib import contextmanager
import fcntl


LIVE_BATCH_STATES = {"sealed", "sample_pending", "sample_approved", "rendering"}


def _text_signature(texts):
    connectors = ("同时", "而且", "另外", "然后", "并且")
    normalized = []
    for text in texts:
        text = unicodedata.normalize("NFKC", text).strip()
        if text.startswith(connectors):
            text = text[2:]
        normalized.append("".join(character for character in text
                                  if not character.isspace() and not unicodedata.category(character).startswith("P")))
    return _sha("\0".join(normalized))


def _visual_signature(clip_ids):
    return _sha("\0".join(clip_ids))


def _history_manifest_paths(workspace):
    root = Path(workspace)
    return sorted({
        *root.glob("work/production-batches/*/manifest.json"),
        *root.glob("work/s5max-daily/*/manifest.json"),
        *root.glob("work/production/*/manifest.json"),
    })


def history_signatures(workspace, excluding=None):
    signatures = {"copy": set(), "text": set(), "visual": set()}
    excluded = Path(excluding).resolve() if excluding else None
    paths = _history_manifest_paths(workspace)
    batch_values = {}
    owned_video_ids = set()
    for manifest_path in paths:
        value = json.loads(manifest_path.read_text(encoding="utf-8"))
        if value.get("schemaVersion") == 2 and "batchStatus" in value:
            batch_values[manifest_path] = value
            owned_video_ids.update(item["id"] for item in value.get("items", []))
    for manifest_path in paths:
        if excluded and manifest_path.resolve() == excluded:
            continue
        value = batch_values.get(manifest_path)
        if value is not None:
            if value.get("batchStatus") == "archived":
                continue
            if value.get("batchStatus") not in LIVE_BATCH_STATES | {"complete"}:
                continue
            items = value.get("items", [])
            for item in items:
                signatures["copy"].add(item["copySignature"])
                signatures["text"].add(item["textSignature"])
                signatures["visual"].add(item["visualSignature"])
            continue
        if manifest_path.parent.name in owned_video_ids:
            continue
        value = json.loads(manifest_path.read_text(encoding="utf-8"))
        if "items" in value:
            for item in value["items"]:
                if item.get("status") == "verified":
                    for key in signatures:
                        if item.get(f"{key}Signature"):
                            signatures[key].add(item[f"{key}Signature"])
            continue
        if value.get("output") and Path(value["output"].get("path", "")).is_file() and value.get("sentences"):
            signatures["text"].add(_text_signature([item["text"] for item in value["sentences"]]))
            signatures["visual"].add(_visual_signature([item["shot"]["sourceId"] for item in value["sentences"]]))
    return signatures


@contextmanager
def _history_lock(workspace):
    lock_path = Path(workspace) / "work/production-batches/.history.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
```

`owned_video_ids` 让 schema v2 批次成为其底层 `work/production/<videoId>/manifest.json` 的唯一状态所有者：归档批次即使保留完整诊断，也不会被底层单条 manifest 重新登记为历史。

在 `load_visual_pools` 中为每条记录设置并校验：

```python
clip_id = clip.get("clipId") or clip["assetId"]
if not re.fullmatch(r"[A-Za-z0-9_-]+", clip_id):
    raise ValueError(f"material clipId must be filename-safe: {clip_id}")
clip = {**clip, "clipId": clip_id}
```

把 `load_visual_pools.unique()` 的键和 `_pick_balanced()` 的素材身份从 `assetId` 改为 `clipId`；同一条视频的 `excluded_ids`/`used_ids` 同样存 `clipId`，`quickFingerprint` 继续作为第二道重复保护。`shot.sourceId` 仍使用 catalog 的 `assetId`，因此不改动单条生产合同。

画面签名只调用：

```python
visual_signature = _visual_signature([clip["clipId"] for clip in selected])
```

并把 `clipId` 写入每个 `visualSlot`。

- [ ] **Step 4: 原子预留和归档**

加入：

```python
def reserve_batch(workspace, manifest_path):
    manifest_path = _inside(workspace, manifest_path, "manifest")
    with _history_lock(workspace):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        history = history_signatures(workspace, excluding=manifest_path)
        for item in manifest["items"]:
            for key in ("copy", "text", "visual"):
                if item[f"{key}Signature"] in history[key]:
                    raise ValueError(f"history conflict for {key}: {item['id']}")
        manifest["batchStatus"] = "sealed"
        manifest["sealedAt"] = datetime.now().astimezone().isoformat()
        _atomic_json(manifest_path, manifest)
    return manifest


def archive_batch(workspace, manifest_path, reason):
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError("archive reason must be non-empty")
    manifest_path = _inside(workspace, manifest_path, "manifest")
    with _history_lock(workspace):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("batchStatus") == "complete":
            raise ValueError("completed batches cannot be archived")
        manifest["batchStatus"] = "archived"
        manifest["archivedAt"] = datetime.now().astimezone().isoformat()
        manifest["archiveReason"] = reason.strip()
        _atomic_json(manifest_path, manifest)
    return manifest
```

- [ ] **Step 5: 运行测试并提交 Task 2**

Run:

```bash
python3 -m unittest scripts/test_s5max_daily.py
```

Expected: `OK`；旧正式成片进入历史、归档批次被忽略、live 批次被预留、trim 微调不制造新画面组合。

```bash
git add scripts/s5max-daily.py scripts/test_s5max_daily.py
git commit -m "feat: reserve unique production history"
```

---

### Task 3: 在封存前完成容量证明、一次 TTS 预热和真实时长选片

**Files:**
- Modify: `scripts/s5max-daily.py:151-334`
- Modify: `scripts/test_s5max_daily.py`

**Interfaces:**
- Consumes: Task 1 的 `plan_batch`、Task 2 的历史集合、现有 IndexTTS worker。
- Produces: `capacity_report(*, workspace, target_count, jobs=2, **plan_options)` 和 `prepare_batch(*, workspace, mode, source_copy, copy_csv, materials_path, catalog_path, voice_path, model_dir, index_python, target_count, batch_id, seed, device="mps")`。
- `capacity_report` 达到目标时返回 `capacityAtLeast`；不足时返回精确 `capacityExact` 和结构化 `missing`，不枚举超过目标的无用组合。
- 报告同时返回 `estimatedTtsMinutes`、`estimatedProxyMinutes`、`estimatedRenderMinutes`、`estimatedElapsedMinutes`、`estimatedDiskGiB` 和可审计的 `estimateBasis`。
- `prepare_batch` 只在用户确认数量后调用，预热所有唯一句子一次，读取真实 WAV 时长，重新执行同 seed 选片，写入统一目录并原子封存。

- [ ] **Step 1: 写容量和真实 WAV 时长的失败测试**

增加：

```python
def test_capacity_stops_after_proving_target_and_prepare_uses_real_wav_duration(self):
    module = load_module()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        csv_path, assets_path = fixture(root)
        materials = json.loads(assets_path.read_text(encoding="utf-8"))
        catalog = root / "catalog.json"
        catalog.write_text(json.dumps({"assets": [
            {"id": clip["assetId"], "durationInSeconds": clip["sourceOutSeconds"]}
            for clip in materials["selection"]["clipLibrary"]
        ]}), encoding="utf-8")
        source = root / "source-copy.txt"
        source.write_text("测试原始文案。", encoding="utf-8")
        voice = root / "voice.wav"
        write_wav(voice, seconds=1.0)
        model = root / "model"
        model.mkdir()
        (model / "config.yaml").write_text("model: test\n", encoding="utf-8")
        python = root / "python"
        python.write_text("python", encoding="utf-8")

        report = module.capacity_report(
            workspace=root, batch_id="capacity-a", seed="seed-a", copy_csv=csv_path, materials_path=assets_path,
            catalog_path=str(catalog), voice_path=str(voice), target_count=300,
            forbidden={"copy": set(), "text": set(), "visual": set()},
        )

        calls = []
        def fake_run(command, **_kwargs):
            calls.append(command)
            manifest_path = Path(command[command.index("--manifest") + 1])
            batch_file = Path(command[command.index("--batch-file") + 1])
            items = []
            for line, task in enumerate(map(json.loads, batch_file.read_text(encoding="utf-8").splitlines()), 1):
                wav_path = root / "work/indextts25/cache" / f"sentence-{line}.wav"
                write_wav(wav_path, seconds=5.5)
                items.append({"line": line, "text": task["text"], "outputPath": str(wav_path),
                              "durationFactor": 1, "contentKey": f"{line:064x}",
                              "sha256": module._sha_file(wav_path)})
            manifest_path.write_text(json.dumps({
                "engine": "IndexTTS-2.5", "engineVersion": "v2.5.0",
                "voiceSha256": module._sha_file(voice),
                "modelConfigSha256": module._sha_file(model / "config.yaml"),
                "items": items,
            }), encoding="utf-8")

        with patch.object(module.subprocess, "run", side_effect=fake_run):
            manifest_path = module.prepare_batch(
                workspace=root, mode="batch", source_copy=source, copy_csv=csv_path,
                materials_path=assets_path, catalog_path=catalog, voice_path=voice,
                model_dir=model, index_python=python, target_count=4, batch_id="prepare-a",
                seed="seed-a", device="cpu",
            )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    self.assertEqual(report["capacityAtLeast"], 300)
    self.assertGreater(report["estimatedElapsedMinutes"][0], 0)
    self.assertGreater(report["estimatedDiskGiB"], 0)
    self.assertEqual(len(calls), 1)
    self.assertEqual(manifest["batchStatus"], "sealed")
    self.assertTrue(all(slot["sourceOutSeconds"] - slot["sourceInSeconds"] >= 5.5
                        for item in manifest["items"] for slot in item["visualSlots"]))
```

给测试文件增加一个标准库 `wave` 写入 helper：

```python
def write_wav(path: Path, seconds=1.0):
    import wave
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = int(22050 * seconds)
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, 22050, frames, "NONE", "not compressed"))
        output.writeframes(b"\0\0" * frames)
```

- [ ] **Step 2: 运行测试，确认 RED**

Run:

```bash
python3 -m unittest scripts/test_s5max_daily.py
```

Expected: FAIL，缺少 `capacity_report`、`prepare_batch` 或仍使用估算语速选片。

- [ ] **Step 3: 实现有界容量报告**

加入 `statistics` import，并让预检同时返回可解释的耗时/空间估算。优先使用现有正式 MP4 的中位大小；没有历史时保守按 50 MiB/条。后续新批次条目会记录 `renderStartedAt`/`verifiedAt`，因此时间估算优先使用历史中位值；没有样本时按 180 秒/条：

```python
import statistics


def _resource_estimate(workspace, target_count, jobs, batch=None, catalog_path=None):
    manifests = [json.loads(path.read_text(encoding="utf-8"))
                 for path in Path(workspace).glob("work/production-batches/*/manifest.json")]
    elapsed = []
    for manifest in manifests:
        for item in manifest.get("items", []):
            if item.get("renderStartedAt") and item.get("verifiedAt"):
                start = datetime.fromisoformat(item["renderStartedAt"])
                end = datetime.fromisoformat(item["verifiedAt"])
                elapsed.append((end - start).total_seconds())
    sizes = [path.stat().st_size for path in Path(workspace).glob("out/**/*.mp4") if path.is_file()]
    seconds_per_video = statistics.median(elapsed) if elapsed else 180
    bytes_per_video = statistics.median(sizes) if sizes else 50 * 1024 * 1024
    render_minutes = target_count * seconds_per_video / max(1, jobs) / 60
    sentence_count = len({sentence["ttsText"] for item in (batch or {}).get("items", [])
                          for sentence in item["plan"]["sentences"]}) or target_count * 5
    selected_assets = {slot["assetId"] for item in (batch or {}).get("items", []) for slot in item["visualSlots"]}
    assets = {asset.get("id"): asset for asset in json.loads(Path(catalog_path).read_text(encoding="utf-8")).get("assets", [])} if catalog_path else {}
    missing_proxies = sum(not assets.get(asset_id, {}).get("proxyPath") or
                          not Path(assets[asset_id]["proxyPath"]).is_file()
                          for asset_id in selected_assets if asset_id in assets)
    tts_minutes = [round(sentence_count * 0.1, 1), round(sentence_count * 0.25, 1)]
    proxy_minutes = [round(missing_proxies * 0.25, 1), round(missing_proxies * 1.0, 1)]
    render_range = [round(render_minutes * 0.8, 1), round(render_minutes * 1.25, 1)]
    return {
        "estimatedTtsMinutes": tts_minutes,
        "estimatedProxyMinutes": proxy_minutes,
        "estimatedRenderMinutes": render_range,
        "estimatedElapsedMinutes": [round(tts_minutes[0] + proxy_minutes[0] + render_range[0], 1),
                                    round(tts_minutes[1] + proxy_minutes[1] + render_range[1], 1)],
        "estimatedDiskGiB": round(target_count * bytes_per_video * 1.25 / 1024 ** 3, 2),
        "estimateBasis": {"uniqueSentences": sentence_count, "missingProxies": missing_proxies,
                          "secondsPerVideo": seconds_per_video, "bytesPerVideo": bytes_per_video,
                          "jobs": max(1, jobs)},
    }


def capacity_report(*, workspace, target_count, jobs=2, **plan_options):
    try:
        batch = plan_batch(count=target_count, **plan_options)
        _validate_catalog(batch, plan_options["catalog_path"])
    except CapacityError as error:
        estimate = _resource_estimate(workspace, target_count, jobs)
        return {**estimate,
            "targetCount": target_count,
            "canProduce": False,
            "capacityExact": error.exact,
            "missing": error.missing,
        }
    except ValueError as error:
        estimate = _resource_estimate(workspace, target_count, jobs)
        return {**estimate,
            "targetCount": target_count,
            "canProduce": False,
            "capacityExact": 0,
            "missing": [{"kind": "input", "message": str(error)}],
        }
    estimate = _resource_estimate(workspace, target_count, jobs, batch, plan_options["catalog_path"])
    return {**estimate,
        "targetCount": target_count,
        "canProduce": True,
        "capacityAtLeast": target_count,
        "missing": [],
    }
```

容量报告只证明目标是否可达；达到目标后立即停止，符合默认 300 条需求。

- [ ] **Step 4: 让 `plan_batch` 接受真实音频时长**

加入：

```python
def _wav_seconds(path):
    import wave
    with wave.open(str(path), "rb") as audio:
        frames = audio.getnframes()
        rate = audio.getframerate()
        if frames <= 0 or rate <= 0 or len(audio.readframes(frames)) != frames * audio.getnchannels() * audio.getsampwidth():
            raise ValueError(f"invalid prewarmed WAV: {path}")
        return frames / rate
```

选片处把估算改成精确优先：

```python
required_seconds = (
    audio_durations[_tts_text(item["subtitleTexts"][slot])]
    if audio_durations is not None
    else _estimated_voice_seconds(item["subtitleTexts"][slot])
)
```

如果传入 `audio_durations` 却缺少任何 `ttsText`，立即报错，不回退估算：

```python
if audio_durations is not None:
    missing = sorted({_tts_text(text) for item in items for text in item["subtitleTexts"]} - set(audio_durations))
    if missing:
        raise ValueError(f"audio durations are missing {len(missing)} sentence(s): {missing[0]}")
```

最终每个 item 同时记录样片选择所需的真实计划时长：

```python
durations = [audio_durations[_tts_text(text)] for text in item["subtitleTexts"]]
item["plannedDurationSeconds"] = sum(durations) + max(0, len(durations) - 1) * 5 / 30
```

只在 `audio_durations` 已提供时写此字段；封存批次总会包含它，纯容量预检不需要它。

- [ ] **Step 5: 实现一次预热和统一批次目录**

`prepare_batch` 必须按以下顺序完成：

```python
def _sha_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _snapshot_once(path, value):
    path = Path(path)
    if path.exists() and path.read_text(encoding="utf-8") != value:
        raise ValueError(f"batch snapshot already differs: {path}")
    if not path.exists():
        _atomic_text(path, value)


def _prewarm_durations(manifest_path, texts, voice_path, model_dir, cache_dir):
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    if (manifest.get("engine"), manifest.get("engineVersion")) != ("IndexTTS-2.5", "v2.5.0"):
        raise ValueError("prewarm manifest must be local IndexTTS 2.5")
    if manifest.get("voiceSha256") != _sha_file(voice_path):
        raise ValueError("prewarm voice hash mismatch")
    if manifest.get("modelConfigSha256") != _sha_file(Path(model_dir) / "config.yaml"):
        raise ValueError("prewarm model config hash mismatch")
    if [item.get("text") for item in manifest.get("items", [])] != texts:
        raise ValueError("prewarm sentence mapping mismatch")
    durations = {}
    for item in manifest["items"]:
        output = _inside(cache_dir, item["outputPath"], "prewarm WAV")
        if not re.fullmatch(r"[a-f0-9]{64}", item.get("contentKey", "")) or item.get("sha256") != _sha_file(output):
            raise ValueError("prewarm WAV hash mismatch")
        durations[item["text"]] = _wav_seconds(output)
    return durations


def prepare_batch(*, workspace, mode, source_copy, copy_csv, materials_path, catalog_path,
                  voice_path, model_dir, index_python, target_count, batch_id, seed, device="mps"):
    workspace = Path(workspace).resolve()
    if mode not in {"single", "batch"}:
        raise ValueError("mode must be single or batch")
    if (mode == "single") != (target_count == 1):
        raise ValueError("single mode requires target_count 1")
    batch_dir = workspace / "work/production-batches" / batch_id
    batch_dir.mkdir(parents=True, exist_ok=True)
    if (batch_dir / "manifest.json").exists():
        raise ValueError(f"batch is already prepared: {batch_id}")
    _snapshot_once(batch_dir / "source-copy.txt", Path(source_copy).read_text(encoding="utf-8"))
    _snapshot_once(batch_dir / "copy-pool.csv", Path(copy_csv).read_text(encoding="utf-8-sig"))
    draft_path = batch_dir / "draft-plan.json"
    if draft_path.exists():
        draft = json.loads(draft_path.read_text(encoding="utf-8"))
        if (draft.get("batchId"), draft.get("seed"), draft.get("targetCount")) != (batch_id, seed, target_count):
            raise ValueError("existing draft does not match batch id, seed, and target count")
        forbidden = {key: set(values) for key, values in draft["forbidden"].items()}
        provisional = draft["provisional"]
    else:
        forbidden = history_signatures(workspace)
        provisional = plan_batch(
            batch_id=batch_id, seed=seed, copy_csv=batch_dir / "copy-pool.csv", materials_path=materials_path,
            catalog_path=catalog_path, voice_path=voice_path, count=target_count,
            forbidden=forbidden,
        )
        _atomic_json(draft_path, {
            "batchId": batch_id, "seed": seed, "targetCount": target_count,
            "forbidden": {key: sorted(values) for key, values in forbidden.items()},
            "provisional": provisional,
        })
    unique_texts = list(dict.fromkeys(
        sentence["ttsText"] for item in provisional["items"] for sentence in item["plan"]["sentences"]
    ))
    prewarm_path = batch_dir / "tts-prewarm.jsonl"
    _atomic_text(prewarm_path, "".join(json.dumps({"text": text, "duration_factor": 1}, ensure_ascii=False) + "\n" for text in unique_texts))
    tts_manifest_path = batch_dir / "tts-prewarm-manifest.json"
    subprocess.run([
        str(index_python), str(workspace / "scripts/indextts25-batch.py"),
        "--batch-file", str(prewarm_path), "--voice", str(voice_path),
        "--model-dir", str(model_dir), "--output-dir", str(workspace / "work/indextts25/cache"),
        "--expected-count", str(len(unique_texts)), "--output-prefix", "sentence",
        "--manifest", str(tts_manifest_path), "--device", device,
    ], cwd=workspace, check=True)
    tts_manifest = json.loads(tts_manifest_path.read_text(encoding="utf-8"))
    durations = _prewarm_durations(tts_manifest_path, unique_texts, voice_path, model_dir,
                                   workspace / "work/indextts25/cache")
    final = plan_batch(
        batch_id=batch_id, seed=seed, copy_csv=batch_dir / "copy-pool.csv", materials_path=materials_path,
        catalog_path=catalog_path, voice_path=voice_path, count=target_count,
        forbidden=forbidden, audio_durations=durations,
    )
    _validate_catalog(final, catalog_path)
    manifest_path = write_batch(final, batch_dir, batch_dir / "copy-pool.csv", mode=mode,
                                source_copy_path=batch_dir / "source-copy.txt",
                                materials_path=materials_path, output_dir=workspace / "out/production-batches" / batch_id)
    reserve_batch(workspace, manifest_path)
    return manifest_path
```

`write_batch(batch, batch_dir, copy_csv, *, mode, source_copy_path, materials_path, output_dir)` 的 manifest 使用 `schemaVersion: 2`，并保存 `mode`、`batchId`、`targetCount`、`batchStatus: "audio_ready"`、`sourceCopyPath`、`copyPoolPath`、`materialsPath`、`catalogPath`、`voice`、`outputDir`、`items`。`scripts.json` 继续保存每条的 `sourceSentences`、最终字幕和签名；manifest 条目保留 `id`、`planPath`、`sellingPointCount`、`plannedDurationSeconds` 和三种签名。所有条目初始为 `voiced`，因为封存前已完成整批预热；输出目录固定为 `out/production-batches/<batchId>`。

`draft-plan.json` 只用于 TTS 失败后的同 seed 恢复，不占用历史签名；`reserve_batch` 仍在最终 exact-duration plans 写好后重新持锁检查当前历史。若并发 Session 已抢先占用同一签名，当前批次停止在 `audio_ready` 并要求归档后用新 batch ID 重建，绝不静默改组合。

- [ ] **Step 6: 运行测试并提交 Task 3**

Run:

```bash
python3 -m unittest scripts/test_s5max_daily.py scripts/test_indextts25_batch.py
```

Expected: `OK`；一次预热调用、真实 WAV 时长选片、损坏 WAV 回归全部通过。

```bash
git add scripts/s5max-daily.py scripts/test_s5max_daily.py
git commit -m "feat: seal batches with exact local audio"
```

---

### Task 4: 增加单样片批准、拒绝归档和可恢复批量渲染

**Files:**
- Modify: `scripts/s5max-daily.py:336-473`
- Modify: `scripts/test_s5max_daily.py`

**Interfaces:**
- Produces: `render_sample(*, manifest_path, workspace, model_dir, index_python, jobs=1)`、`approve_sample(*, manifest_path)`、`reject_sample(*, manifest_path, workspace, reason)` 和 `render_batch(*, manifest_path, workspace, model_dir, index_python, jobs=1)`。
- 单条：`sealed → rendering → complete`。
- 批量：`sealed → sample_pending → sample_approved → rendering → complete`；拒绝进入 `archived`。

- [ ] **Step 1: 写样片状态和拒绝释放的失败测试**

增加：

```python
def make_prepared_manifest(root, mode="batch", count=4):
    batch_dir = root / "work/production-batches/test-batch"
    plans = batch_dir / "plans"
    plans.mkdir(parents=True)
    items = []
    for index in range(count):
        video_id = f"s5max-test-{index + 1:03d}"
        plan_path = plans / f"{video_id}.json"
        plan_path.write_text(json.dumps({"id": video_id}), encoding="utf-8")
        items.append({
            "id": video_id, "planPath": str(plan_path.relative_to(batch_dir)),
            "sellingPointCount": 2 + index % 3, "copySignature": f"copy-{index}",
            "textSignature": f"text-{index}", "visualSignature": f"visual-{index}",
            "plannedDurationSeconds": 12 + index, "status": "voiced",
        })
    manifest = batch_dir / "manifest.json"
    manifest.write_text(json.dumps({
        "schemaVersion": 2, "batchId": "test-batch", "mode": mode,
        "batchStatus": "sealed", "targetCount": count,
        "outputDir": str(root / "out/production-batches/test-batch"), "items": items,
    }), encoding="utf-8")
    return manifest


def test_batch_requires_one_sample_and_rejection_archives_whole_batch(self):
    module = load_module()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        manifest_path = make_prepared_manifest(root, mode="batch", count=4)
        calls = []
        def fake_producer(*, item, out_dir, workspace, **_kwargs):
            calls.append(item["id"])
            output = Path(out_dir) / f"{item['id']}.mp4"
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(b"verified")
            production = Path(workspace) / "work/production" / item["id"]
            production.mkdir(parents=True, exist_ok=True)
            (production / "manifest.json").write_text("{}", encoding="utf-8")
            return str(output)
        runtime = {"model_dir": root / "model", "index_python": root / "python"}
        with patch.object(module, "_run_producer", side_effect=fake_producer):
            sample = module.render_sample(manifest_path=manifest_path, workspace=root, jobs=1, **runtime)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(len(calls), 1)
        self.assertEqual(manifest["batchStatus"], "sample_pending")
        self.assertEqual(sample["sampleId"], manifest["sampleId"])
        with self.assertRaisesRegex(ValueError, "approval"):
            module.render_batch(manifest_path=manifest_path, workspace=root, jobs=2, **runtime)

        module.reject_sample(manifest_path=manifest_path, workspace=root, reason="镜头不匹配")
        archived = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(archived["batchStatus"], "archived")
        self.assertEqual(module.history_signatures(root), {"copy": set(), "text": set(), "visual": set()})
```

再增加批准路径：

```python
def test_approved_sample_counts_toward_target_and_resume_is_zero_work(self):
    module = load_module()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        manifest_path = make_prepared_manifest(root, mode="batch", count=4)
        calls = []
        def fake_producer(*, item, out_dir, workspace, **_kwargs):
            calls.append(item["id"])
            output = Path(out_dir) / f"{item['id']}.mp4"
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(b"verified")
            production = Path(workspace) / "work/production" / item["id"]
            production.mkdir(parents=True, exist_ok=True)
            (production / "manifest.json").write_text("{}", encoding="utf-8")
            return str(output)
        runtime = {"model_dir": root / "model", "index_python": root / "python"}
        with patch.object(module, "_run_producer", side_effect=fake_producer):
            module.render_sample(manifest_path=manifest_path, workspace=root, jobs=1, **runtime)
            module.approve_sample(manifest_path=manifest_path)
            module.render_batch(manifest_path=manifest_path, workspace=root, jobs=2, **runtime)
            self.assertEqual(len(calls), 4)
            calls.clear()
            result = module.render_batch(manifest_path=manifest_path, workspace=root, jobs=2, **runtime)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    self.assertEqual(calls, [])
    self.assertEqual(result["rendered"], 0)
    self.assertEqual(manifest["batchStatus"], "complete")
    self.assertTrue(all(item["status"] == "verified" for item in manifest["items"]))
```

- [ ] **Step 2: 运行测试，确认 RED**

Run:

```bash
python3 -m unittest scripts/test_s5max_daily.py
```

Expected: FAIL，缺少样片方法和状态守卫。

- [ ] **Step 3: 抽出唯一 producer 调用并选择代表样片**

把现有嵌套 `produce` 抽为：

```python
def _run_producer(*, item, batch_dir, workspace, model_dir, index_python, out_dir):
    output = out_dir / f"{item['id']}.mp4"
    if output.exists():
        raise ValueError(f"unverified final output already exists: {output}")
    work_dir = workspace / "work/production" / item["id"]
    partial = out_dir / f"{item['id']}.partial.mp4"
    stale = [path for path in (work_dir, partial) if path.exists()]
    if stale:
        retry_dir = batch_dir / "retries" / f"{item['id']}-{datetime.now().strftime('%Y%m%dT%H%M%S%f')}"
        retry_dir.mkdir(parents=True)
        for path in stale:
            shutil.move(str(path), retry_dir / path.name)
    subprocess.run([
        "node", str(workspace / "scripts/produce.mjs"), "--plan", str(_inside(batch_dir, batch_dir / item["planPath"], "plan")),
        "--model-dir", str(model_dir), "--python", str(index_python), "--out-dir", str(out_dir),
    ], cwd=workspace, check=True)
    production_manifest = workspace / "work/production" / item["id"] / "manifest.json"
    if not output.is_file() or not production_manifest.is_file():
        raise RuntimeError(f"producer did not atomically publish {item['id']}")
    return str(output)
```

代表样片使用已封存计划中的中位结构，不重新随机：

```python
def _representative_sample(items):
    median_duration = statistics.median(item["plannedDurationSeconds"] for item in items)
    return min(items, key=lambda item: (
        abs(item["sellingPointCount"] - 3),
        abs(item["plannedDurationSeconds"] - median_duration),
        item["id"],
    ))["id"]
```

用一个共享的、只在主线程写 manifest 的最小 runner 支持样片、单条和批量续跑：

```python
def _render_items(*, manifest, manifest_path, workspace, model_dir, index_python, item_ids, jobs):
    batch_dir = Path(manifest_path).parent
    out_dir = _inside(workspace, manifest["outputDir"], "out-dir")
    out_dir.mkdir(parents=True, exist_ok=True)
    by_id = {item["id"]: item for item in manifest["items"]}
    pending = []
    for item_id in item_ids:
        item = by_id[item_id]
        output = out_dir / f"{item_id}.mp4"
        production = Path(workspace) / "work/production" / item_id / "manifest.json"
        if item.get("status") == "verified" or (output.is_file() and production.is_file()):
            item.update(status="verified", outputPath=str(output))
            continue
        item["renderStartedAt"] = datetime.now().astimezone().isoformat()
        item.pop("failedStage", None)
        item.pop("error", None)
        pending.append(item)
    _atomic_json(manifest_path, manifest)

    failures = []
    with ThreadPoolExecutor(max_workers=max(1, jobs)) as executor:
        futures = {executor.submit(
            _run_producer, item=item, batch_dir=batch_dir, workspace=Path(workspace),
            model_dir=model_dir, index_python=index_python, out_dir=out_dir,
        ): item for item in pending}
        for future in as_completed(futures):
            item = futures[future]
            try:
                item["outputPath"] = future.result()
                item["status"] = "verified"
                item["verifiedAt"] = datetime.now().astimezone().isoformat()
            except Exception as error:
                item["status"] = "voiced"
                item["failedStage"] = "produce"
                item["error"] = str(error)
                failures.append(item["id"])
            _atomic_json(manifest_path, manifest)
    return {"rendered": len(pending), "failures": failures}


def render_sample(*, manifest_path, workspace, model_dir, index_python, jobs=1):
    manifest_path = _inside(workspace, manifest_path, "manifest")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("mode") != "batch":
        raise ValueError("sample is only available in batch mode")
    if manifest.get("batchStatus") == "sample_pending":
        return {"sampleId": manifest["sampleId"], "rendered": 0}
    if manifest.get("batchStatus") != "sealed":
        raise ValueError("sample requires a sealed batch")
    manifest["sampleId"] = manifest.get("sampleId") or _representative_sample(manifest["items"])
    _atomic_json(manifest_path, manifest)
    result = _render_items(
        manifest=manifest, manifest_path=manifest_path, workspace=workspace,
        model_dir=model_dir, index_python=index_python,
        item_ids=[manifest["sampleId"]], jobs=jobs,
    )
    if result["failures"]:
        raise RuntimeError(f"sample failed: {result['failures'][0]}")
    manifest["batchStatus"] = "sample_pending"
    manifest["sampleRenderedAt"] = datetime.now().astimezone().isoformat()
    _atomic_json(manifest_path, manifest)
    return {"sampleId": manifest["sampleId"], "rendered": result["rendered"]}
```

- [ ] **Step 4: 实现批准、拒绝和状态守卫**

```python
def approve_sample(*, manifest_path):
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    if manifest.get("batchStatus") in {"sample_approved", "rendering", "complete"}:
        return manifest
    sample = next(item for item in manifest["items"] if item["id"] == manifest.get("sampleId"))
    if manifest.get("batchStatus") != "sample_pending" or sample.get("status") != "verified":
        raise ValueError("a verified sample is required before approval")
    manifest["batchStatus"] = "sample_approved"
    manifest["sampleApprovedAt"] = datetime.now().astimezone().isoformat()
    _atomic_json(manifest_path, manifest)
    return manifest


def reject_sample(*, manifest_path, workspace, reason):
    manifest_path = _inside(workspace, manifest_path, "manifest")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("batchStatus") not in {"audio_ready", "sealed", "sample_pending", "sample_approved"}:
        raise ValueError("only a non-rendering unfinished batch can be rejected")
    sample = next((item for item in manifest["items"] if item["id"] == manifest.get("sampleId")), None)
    rejected_dir = Path(manifest_path).parent / "rejected-sample"
    rejected_dir.mkdir(parents=True, exist_ok=True)
    if sample and sample.get("outputPath") and Path(sample["outputPath"]).exists():
        output = _inside(manifest["outputDir"], sample["outputPath"], "sample output")
        rejected = rejected_dir / output.name
        shutil.move(output, rejected)
        sample["archivedOutputPath"] = str(rejected)
        sample.pop("outputPath", None)
    if sample:
        production = Path(workspace) / "work/production" / sample["id"]
        if production.exists():
            shutil.move(production, rejected_dir / "work-production")
    _atomic_json(manifest_path, manifest)
    return archive_batch(workspace, manifest_path, reason)


def render_batch(*, manifest_path, workspace, model_dir, index_python, jobs=1):
    manifest_path = _inside(workspace, manifest_path, "manifest")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    status = manifest.get("batchStatus")
    if status == "complete":
        return {"rendered": 0, "verified": manifest["targetCount"], "outDir": manifest["outputDir"]}
    allowed = {"sealed", "rendering"} if manifest.get("mode") == "single" else {"sample_approved", "rendering"}
    if status not in allowed:
        raise ValueError("batch sample approval is required before render")
    manifest["batchStatus"] = "rendering"
    _atomic_json(manifest_path, manifest)
    result = _render_items(
        manifest=manifest, manifest_path=manifest_path, workspace=workspace,
        model_dir=model_dir, index_python=index_python,
        item_ids=[item["id"] for item in manifest["items"]], jobs=jobs,
    )
    verified = sum(item.get("status") == "verified" for item in manifest["items"])
    if verified == manifest["targetCount"]:
        manifest["batchStatus"] = "complete"
        manifest["completedAt"] = datetime.now().astimezone().isoformat()
    _atomic_json(manifest_path, manifest)
    if result["failures"]:
        raise RuntimeError(f"{len(result['failures'])} render(s) failed: {', '.join(result['failures'][:10])}")
    return {"rendered": result["rendered"], "verified": verified, "outDir": manifest["outputDir"]}
```

- [ ] **Step 5: 运行测试并提交 Task 4**

Run:

```bash
python3 -m unittest scripts/test_s5max_daily.py
```

Expected: `OK`；未批准不能批量、样片批准后只跑剩余项、拒绝归档并释放签名、完成项零调用续跑。

```bash
git add scripts/s5max-daily.py scripts/test_s5max_daily.py
git commit -m "feat: gate batch rendering on one sample"
```

---

### Task 5: 收敛协调器 CLI 为容量、准备、样片、批准、拒绝和续跑

**Files:**
- Modify: `scripts/s5max-daily.py:424-473`
- Modify: `scripts/test_s5max_daily.py`

**Interfaces:**
- `capacity`: 纯预检，不生成 TTS 或视频。
- `prepare`: 用户确认数量后预热 TTS、精确选片并封存。
- `sample`: 批量只生产代表样片。
- `approve` / `reject`: 持久化用户决策。
- `render`: 单条直接生产；批量只在批准后续跑。

- [ ] **Step 1: 写 CLI 失败测试**

```python
def test_cli_has_one_coordinator_state_machine(self):
    module = load_module()
    capacity = module.parse_args(["capacity", "--copy-csv", "pool.csv", "--count", "300"])
    prepare = module.parse_args(["prepare", "--mode", "single", "--source-copy", "copy.txt", "--copy-csv", "pool.csv"])
    sample = module.parse_args(["sample", "--manifest", "work/production-batches/a/manifest.json"])
    approve = module.parse_args(["approve", "--manifest", "work/production-batches/a/manifest.json"])
    reject = module.parse_args(["reject", "--manifest", "work/production-batches/a/manifest.json", "--reason", "不匹配"])
    render = module.parse_args(["render", "--manifest", "work/production-batches/a/manifest.json"])

    self.assertEqual(capacity.command, "capacity")
    self.assertEqual(capacity.count, 300)
    self.assertEqual(prepare.mode, "single")
    self.assertEqual(sample.command, "sample")
    self.assertEqual(approve.command, "approve")
    self.assertEqual(reject.reason, "不匹配")
    self.assertEqual(render.command, "render")
```

- [ ] **Step 2: 运行测试，确认 RED**

Run:

```bash
python3 -m unittest scripts/test_s5max_daily.py
```

Expected: FAIL，旧 CLI 只有 `plan`/`render` 且写死 300。

- [ ] **Step 3: 实现六个内部命令**

在 imports 加 `secrets`。默认值固定为：

```python
DEFAULT_MATERIALS = Path("work/s5max-30-unique/smb-expanded-materials.json")
DEFAULT_CATALOG = Path("work/asset-library/catalog.json")
DEFAULT_VOICE = Path("work/indextts2-s5max/voice_03.wav")
DEFAULT_MODEL = Path("work/indextts25/index-tts/checkpoints")
DEFAULT_PYTHON = Path("work/indextts25/index-tts/.venv/bin/python")
```

替换 `parse_args`：

```python
def _add_runtime(parser, *, jobs=False):
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--python", dest="index_python", type=Path, default=DEFAULT_PYTHON)
    if jobs:
        parser.add_argument("--jobs", type=int, default=1)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    capacity = commands.add_parser("capacity")
    capacity.add_argument("--copy-csv", required=True, type=Path)
    capacity.add_argument("--materials", type=Path, default=DEFAULT_MATERIALS)
    capacity.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    capacity.add_argument("--voice", type=Path, default=DEFAULT_VOICE)
    capacity.add_argument("--count", type=int, default=300)
    capacity.add_argument("--jobs", type=int, default=2)
    capacity.add_argument("--workspace", type=Path, default=Path.cwd())

    prepare = commands.add_parser("prepare")
    prepare.add_argument("--mode", choices=("single", "batch"), required=True)
    prepare.add_argument("--source-copy", required=True, type=Path)
    prepare.add_argument("--copy-csv", required=True, type=Path)
    prepare.add_argument("--materials", type=Path, default=DEFAULT_MATERIALS)
    prepare.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    prepare.add_argument("--voice", type=Path, default=DEFAULT_VOICE)
    prepare.add_argument("--count", type=int)
    prepare.add_argument("--batch-id")
    prepare.add_argument("--seed")
    prepare.add_argument("--device", choices=("mps", "cpu"), default="mps")
    _add_runtime(prepare)

    sample = commands.add_parser("sample")
    sample.add_argument("--manifest", required=True, type=Path)
    _add_runtime(sample, jobs=True)

    approve = commands.add_parser("approve")
    approve.add_argument("--manifest", required=True, type=Path)

    reject = commands.add_parser("reject")
    reject.add_argument("--manifest", required=True, type=Path)
    reject.add_argument("--workspace", type=Path, default=Path.cwd())
    reject.add_argument("--reason", required=True)

    render = commands.add_parser("render")
    render.add_argument("--manifest", required=True, type=Path)
    _add_runtime(render, jobs=True)
    return parser.parse_args(argv)
```

替换 `main`；`prepare` 未提供 batch ID/seed 时只生成一次并输出，`capacity` 用输入内容派生稳定的只读 seed：

```python
def main(argv=None):
    args = parse_args(argv)
    if args.command == "capacity":
        workspace = args.workspace.resolve()
        result = capacity_report(
            workspace=workspace, target_count=args.count, jobs=args.jobs,
            batch_id="capacity", seed=_sha(Path(args.copy_csv).read_text(encoding="utf-8-sig")),
            copy_csv=args.copy_csv, materials_path=args.materials, catalog_path=args.catalog,
            voice_path=args.voice, forbidden=history_signatures(workspace),
        )
    elif args.command == "prepare":
        count = args.count if args.count is not None else (1 if args.mode == "single" else 300)
        if args.mode == "single" and count != 1:
            raise ValueError("single mode requires count 1")
        batch_id = args.batch_id or f"{datetime.now().strftime('%Y%m%d')}-{secrets.token_hex(4)}"
        seed = args.seed or _sha(batch_id)
        print(json.dumps({"batchId": batch_id, "seed": seed, "status": "preparing"}, ensure_ascii=False),
              file=sys.stderr, flush=True)
        manifest_path = prepare_batch(
            workspace=args.workspace, mode=args.mode, source_copy=args.source_copy,
            copy_csv=args.copy_csv, materials_path=args.materials, catalog_path=args.catalog,
            voice_path=args.voice, model_dir=args.model_dir, index_python=args.index_python,
            target_count=count, batch_id=batch_id, seed=seed, device=args.device,
        )
        result = {"batchId": batch_id, "seed": seed, "manifest": str(manifest_path)}
    elif args.command == "sample":
        result = render_sample(
            manifest_path=args.manifest, workspace=args.workspace, model_dir=args.model_dir,
            index_python=args.index_python, jobs=args.jobs,
        )
    elif args.command == "approve":
        result = approve_sample(manifest_path=args.manifest)
    elif args.command == "reject":
        result = reject_sample(manifest_path=args.manifest, workspace=args.workspace, reason=args.reason)
    else:
        result = render_batch(
            manifest_path=args.manifest, workspace=args.workspace, model_dir=args.model_dir,
            index_python=args.index_python, jobs=args.jobs,
        )
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
```

默认 `--count`：single 为 1，batch 为 300；显式 count 与 mode 冲突时拒绝。所有命令以单行 JSON 输出结果，便于技能读取。

- [ ] **Step 4: 运行 CLI 和全部 Python 回归**

Run:

```bash
python3 -m unittest scripts/test_s5max_daily.py scripts/test_indextts25_batch.py
```

Expected: `OK`。

Run:

```bash
python3 scripts/s5max-daily.py --help
```

Expected: 帮助文本只列出 `capacity, prepare, sample, approve, reject, render` 六个协调命令，不再把旧的日期固定批次作为主入口。

- [ ] **Step 5: 提交 Task 5**

```bash
git add scripts/s5max-daily.py scripts/test_s5max_daily.py
git commit -m "feat: expose unified production coordinator"
```

---

### Task 6: 更新唯一技能入口，让 Codex 自主生成内部 CSV 并执行样片闸门

**Files:**
- Modify: `skills/auto-edit-product-video/SKILL.md`
- Modify: `skills/auto-edit-product-video/agents/openai.yaml`
- Modify: `skills/auto-edit-product-video/references/production-plan-contract.md`
- Modify: `scripts/skill-contract.test.mjs`
- Modify: `docs/PROJECT_PLAN.md`

**Interfaces:**
- Consumes: 用户原始文案和可选模式。
- Produces: 内部 `source-copy.txt`、`copy-pool.csv`、协调器命令、样片批准请求和最终 MP4 目录。
- 用户永远不提供 CSV、ProductionPlan、时间线或镜头表。

- [ ] **Step 1: 先把技能合同测试改成新流程并确认 RED**

把主测试的关键断言改为：

```javascript
assert.match(skill, /唯一必需输入[^\n]*原始文案/u);
assert.match(skill, /未指定[^\n]*默认单条/u);
assert.match(skill, /内部[^\n]*category,text[^\n]*CSV[^\n]*不要求用户/u);
assert.match(skill, /sourceText[^\n]*normalizedText[^\n]*sentenceId/u);
assert.match(skill, /不得新增[^\n]*(事实|数字|价格|承诺)/u);
assert.match(skill, /1[^\n]*hook[^\n]*2[^\n]*4[^\n]*(卖点|场景)[^\n]*1[^\n]*CTA/iu);
assert.match(skill, /capacity[^\n]*300/u);
assert.match(skill, /view_image[^\n]*contactSheetPath[^\n]*ctaSheetPath/u);
assert.match(skill, /prepare[^\n]*本地 IndexTTS 2\.5/u);
assert.match(skill, /sample[^\n]*1 条[^\n]*批准/u);
assert.match(skill, /approve[^\n]*剩余/u);
assert.match(skill, /reject[^\n]*整批[^\n]*归档/u);
assert.match(skill, /跨历史[^\n]*文案[^\n]*素材/u);
assert.match(skill, /produce\.mjs[^\n]*唯一[^\n]*单条生产内核/u);
assert.doesNotMatch(skill, /要求用户[^\n]*(CSV|JSON|ProductionPlan)/u);
assert.match(contract, /sourceText[^\n]*当前成片[^\n]*不是[^\n]*整个句子池/u);
assert.match(agent, /single[^\n]*default|默认单条/iu);
assert.match(agent, /batch[^\n]*300/iu);
assert.match(agent, /local IndexTTS 2\.5/iu);
assert.match(agent, /Remotion/u);
```

Run:

```bash
node --test scripts/skill-contract.test.mjs
```

Expected: FAIL，旧技能仍要求“完整全文逐句成一条”，没有批量、历史和样片状态。

- [ ] **Step 2: 将技能改为一条九步工作流**

`SKILL.md` 必须依次说明：

1. 保存用户原始文案并识别模式；未指定默认单条。
2. Codex 拆句、分类，内部写 `category,text` CSV；不得要求用户填写。每个条目保留 `sourceText`、`normalizedText`、`sentenceId` 的来源合同；不得新增事实、数字、价格或承诺。
3. 执行 `capacity`；单条直接继续，批量报告默认 300 的容量/耗时/空间并等待数量确认。
4. 容量不足时运行现有 `asset-library.mjs scan/search`，用 `view_image` 打开 contact/CTA sheets，只把视觉核验合格镜头加入内部素材矩阵，再次执行 capacity。
5. 执行 `prepare`，一次预热本地 IndexTTS 2.5，按真实 WAV 时长选片并封存 manifest。
6. 单条执行 `render` 并交付；批量执行 `sample` 只渲染 1 条。
7. 样片批准时执行 `approve` 和 `render`；拒绝时执行 `reject`，归档整批并根据反馈重新准备。
8. 检查 manifest、联系表、媒体 QC、逐句 WAV/帧、5 帧停顿和跨历史双重签名。
9. 只交付正式 MP4 目录和简短汇总；内部产物保留。

技能必须明确 `produce.mjs` 仍是唯一单条内核，协调器不得自行编码视频。

- [ ] **Step 3: 更新 ProductionPlan 说明和 agent 默认提示**

在 `production-plan-contract.md` 将 `sourceText` 定义改为：

```text
`sourceText` 是当前这一条视频选中的全部字幕文本按顺序连接后的结果，不是用户提交的整个句子池；整个句子池由批次目录中的 `source-copy.txt` 和 `copy-pool.csv` 保留。ProductionPlan 仍必须满足所有 sentence.text 连接后等于 sourceText。
```

`openai.yaml` 的 `default_prompt` 改为：

```yaml
default_prompt: "Use $auto-edit-product-video as the only workflow. Accept the user's raw copy, default to one unique video, or plan a user-confirmed batch of 300; create the classified copy pool internally, use visually verified local SMB footage and local IndexTTS 2.5, gate a batch on one approved sample, and render every final MP4 through the single Remotion production core."
```

- [ ] **Step 4: 更新项目计划并运行合同测试**

`docs/PROJECT_PLAN.md` 只保留一个用户工作流，并列出六个内部协调命令；注明旧 `work/s5max-daily` 和 `out/s5max-daily` 是保留的历史产物，不是新入口。

Run:

```bash
node --test scripts/skill-contract.test.mjs
```

Expected: PASS。

- [ ] **Step 5: 提交 Task 6**

```bash
git add skills/auto-edit-product-video/SKILL.md skills/auto-edit-product-video/agents/openai.yaml skills/auto-edit-product-video/references/production-plan-contract.md scripts/skill-contract.test.mjs docs/PROJECT_PLAN.md
git commit -m "docs: unify product video production workflow"
```

---

### Task 7: 回归、300 条 dry-run、真实单条和单样片验收

**Files:**
- Verify only: all source files changed by Tasks 1–6
- Produce: `work/production-batches/merge-single-smoke/`
- Produce: `out/production-batches/merge-single-smoke/`
- Produce: `work/production-batches/merge-batch-smoke/`
- Produce: `out/production-batches/merge-batch-smoke/`

**Interfaces:**
- Consumes: `scripts/fixtures/s5max-copy-pool.example.csv`、现有 SMB 素材矩阵、catalog、音色和 IndexTTS 2.5 安装。
- Produces: 一个真实单条 MP4、一个真实批量样片、300 条封存计划；样片得到用户批准后再生产剩余 299 条。

- [ ] **Step 1: 跑全部非浏览器回归**

Run:

```bash
python3 -m unittest scripts/test_s5max_daily.py scripts/test_indextts25_batch.py
```

Expected: exit 0，`OK`。

Run:

```bash
node --test scripts/produce.test.mjs scripts/production-contract.test.mjs scripts/skill-contract.test.mjs scripts/lib/render-qc.test.mjs
```

Expected: exit 0，全部测试 pass、0 fail。

Run:

```bash
npm run typecheck
```

Expected: exit 0。

- [ ] **Step 2: 确认核心生产文件没有被批量层复制或改写**

Run:

```bash
shasum -a 256 scripts/produce.mjs scripts/indextts25-batch.py packages/remotion-video/src/production-contract.js packages/remotion-video/src/production-video.tsx scripts/lib/render-qc.mjs
```

Expected:

```text
ea2f35eae7217024bbef96e4aa9f1eba4c2da9364b3f63fbd83868e42b5e9fdc  scripts/produce.mjs
4484e92437fe235bce333ca916fe0b09fc2f8b26f9032fc9c346e26ecc603e00  scripts/indextts25-batch.py
42a05280d497b7afab0c8687a23aa24265369908b86a7bfef81ee5b68d2f8300  packages/remotion-video/src/production-contract.js
7c3e12cb6801cb67b3a2b4920723745e4525c75c42fac3a11bbbdd54f0b610d2  packages/remotion-video/src/production-video.tsx
1a8e4b52eff67e5cbc09f02ee9729ff4923e8a574956ea292ec7a1c2fa5fed34  scripts/lib/render-qc.mjs
```

若任一哈希不同，先检查差异；本计划不授权修改这些核心文件。

- [ ] **Step 3: 用固定内部文案池完成 300 条容量证明和 prepare**

这里使用已存在的内部 CSV 作为合成 smoke-test 文本快照；真实任务仍把用户原文文件传给 `--source-copy`，用户不接触 CSV。

Run:

```bash
python3 scripts/s5max-daily.py capacity --copy-csv scripts/fixtures/s5max-copy-pool.example.csv --materials work/s5max-30-unique/smb-expanded-materials.json --count 300
```

Expected: JSON 中 `canProduce: true`、`capacityAtLeast: 300`、`missing: []`。

Run:

```bash
python3 scripts/s5max-daily.py prepare --mode batch --source-copy scripts/fixtures/s5max-copy-pool.example.csv --copy-csv scripts/fixtures/s5max-copy-pool.example.csv --materials work/s5max-30-unique/smb-expanded-materials.json --catalog work/asset-library/catalog.json --voice work/indextts2-s5max/voice_03.wav --model-dir work/indextts25/index-tts/checkpoints --python work/indextts25/index-tts/.venv/bin/python --count 300 --batch-id merge-batch-smoke --seed merge-batch-smoke-seed --device mps
```

Expected: `work/production-batches/merge-batch-smoke/manifest.json`，状态 `sealed`，300 个 copy/text/visual 签名分别唯一且避开历史，所有镜头区间覆盖真实 WAV。

Run:

```bash
python3 - <<'PY'
import json
from pathlib import Path

manifest = json.loads(Path("work/production-batches/merge-batch-smoke/manifest.json").read_text(encoding="utf-8"))
assert manifest["batchStatus"] == "sealed"
assert len(manifest["items"]) == 300
for key in ("copySignature", "textSignature", "visualSignature"):
    assert len({item[key] for item in manifest["items"]}) == 300
for plan_path in (Path("work/production-batches/merge-batch-smoke") / item["planPath"] for item in manifest["items"]):
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    assert 4 <= len(plan["sentences"]) <= 6
print("sealed plans: 300")
PY
```

Expected: `sealed plans: 300`。

- [ ] **Step 4: 真实单条端到端**

Run:

```bash
python3 scripts/s5max-daily.py prepare --mode single --source-copy scripts/fixtures/s5max-copy-pool.example.csv --copy-csv scripts/fixtures/s5max-copy-pool.example.csv --materials work/s5max-30-unique/smb-expanded-materials.json --catalog work/asset-library/catalog.json --voice work/indextts2-s5max/voice_03.wav --model-dir work/indextts25/index-tts/checkpoints --python work/indextts25/index-tts/.venv/bin/python --count 1 --batch-id merge-single-smoke --seed merge-single-smoke-seed --device mps
```

Run:

```bash
python3 scripts/s5max-daily.py render --manifest work/production-batches/merge-single-smoke/manifest.json --jobs 1
```

Expected: manifest 为 `complete` 且 `out/production-batches/merge-single-smoke/` 恰有 1 个正式 MP4。

- [ ] **Step 5: 真实批量样片并停在用户闸门**

Run:

```bash
python3 scripts/s5max-daily.py sample --manifest work/production-batches/merge-batch-smoke/manifest.json --jobs 1
```

Expected: manifest 为 `sample_pending`，输出目录只有 1 个正式 MP4；使用 `ffprobe`、最终联系表和人工观看确认文案、语音、字幕、镜头与停顿。

把该 MP4 交给用户。不得代表用户自动批准。

- [ ] **Step 6: 用户批准后续跑 299 条**

仅在用户明确批准样片后运行：

```bash
python3 scripts/s5max-daily.py approve --manifest work/production-batches/merge-batch-smoke/manifest.json
python3 scripts/s5max-daily.py render --manifest work/production-batches/merge-batch-smoke/manifest.json --jobs 2
```

Expected: 样片不重渲染，剩余 299 条继续；中断后原命令可续跑。

若用户拒绝，改为运行：

```bash
python3 scripts/s5max-daily.py reject --manifest work/production-batches/merge-batch-smoke/manifest.json --reason "用户拒绝合并验收样片"
```

Expected: 批次为 `archived`，样片移入批次归档目录，300 组预留签名立即释放；根据用户反馈创建新的固定 ID 批次，不修改原 manifest。

- [ ] **Step 7: 300/300 最终媒体验收**

批准并完成后运行：

```bash
python3 - <<'PY'
import json
import re
import subprocess
from pathlib import Path

manifest = json.loads(Path("work/production-batches/merge-batch-smoke/manifest.json").read_text(encoding="utf-8"))
out_dir = Path(manifest["outputDir"])
outputs = sorted(out_dir.glob("*.mp4"))
assert manifest["batchStatus"] == "complete"
assert len(manifest["items"]) == len(outputs) == 300
assert not list(out_dir.glob("*.partial.mp4"))
assert all(item["status"] == "verified" for item in manifest["items"])
for output in outputs:
    probe = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries",
        "stream=codec_type,codec_name,pix_fmt,width,height,avg_frame_rate,channels",
        "-of", "json", str(output),
    ]))
    video = next(stream for stream in probe["streams"] if stream["codec_type"] == "video")
    audio = next(stream for stream in probe["streams"] if stream["codec_type"] == "audio")
    assert (video["codec_name"], video["width"], video["height"], video["pix_fmt"], video["avg_frame_rate"]) == ("h264", 1080, 1920, "yuv420p", "30/1")
    assert (audio["codec_name"], audio["channels"]) == ("aac", 1)
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(output), "-f", "null", "-"], check=True)
    volume = subprocess.run([
        "ffmpeg", "-nostats", "-i", str(output), "-af", "volumedetect", "-f", "null", "-",
    ], text=True, capture_output=True, check=True).stderr
    match = re.search(r"mean_volume:\s*(-?[0-9.]+) dB", volume)
    assert match and float(match.group(1)) > -60
print("verified media: 300/300")
PY
```

Expected: `verified media: 300/300`。

- [ ] **Step 8: 最终提交与报告**

Run:

```bash
git diff --check
git status --short
```

Expected: 无 whitespace error；已有用户改动保持原状，本计划涉及的源码和文档均已在各任务提交中。

最终报告必须分别列出：单条 MP4、批量样片、用户批准结果、300 条状态、测试命令、媒体 QC、未触碰的核心文件和所有保留产物路径。
