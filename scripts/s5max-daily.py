#!/usr/bin/env python3
"""Plan and render one deterministic daily batch of S5Max videos."""

import argparse
import csv
from contextlib import contextmanager
import fcntl
import hashlib
import itertools
import json
import os
import random
import re
import secrets
import shutil
import statistics
import subprocess
import sys
import unicodedata
import wave
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path


PRODUCT_SKU = "s5max"
DEFAULT_MATERIALS = Path("work/s5max-30-unique/smb-expanded-materials.json")
DEFAULT_CATALOG = Path("work/asset-library/catalog.json")
DEFAULT_VOICE = Path("work/indextts2-s5max/voice_03.wav")
DEFAULT_MODEL = Path("work/indextts25/index-tts/checkpoints")
DEFAULT_PYTHON = Path("work/indextts25/index-tts/.venv/bin/python")
SELLING = ("shave", "blade", "power", "water", "charge", "appearance", "scene")
ALLOWED = {"hook", "cta", *SELLING}
TEMPLATES = (
    ("blade", "power", "shave", "water", "charge", "appearance", "scene"),
    ("scene", "shave", "blade", "power", "water", "charge", "appearance"),
    ("shave", "blade", "power", "water", "charge", "appearance", "scene"),
    ("appearance", "scene", "blade", "power", "shave", "water", "charge"),
)
LIVE_BATCH_STATES = {"sealed", "sample_pending", "sample_approved", "rendering"}
ARCHIVABLE_BATCH_STATES = {"audio_ready", "sealed", "sample_pending", "sample_approved"}


def _sha(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _normalized_text(value):
    value = " ".join(unicodedata.normalize("NFKC", value or "").split()).strip()
    if value and value[-1] not in "。！？!?…":
        value += "。"
    return value


def _rank(seed, *parts):
    return int(_sha("|".join((seed, *(str(part) for part in parts)))), 16)


def load_copy_pool(path):
    pools = defaultdict(list)
    seen = {}
    with Path(path).open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames or not {"category", "text"}.issubset(reader.fieldnames):
            raise ValueError("CSV must contain category,text columns")
        for line, row in enumerate(reader, 2):
            category = (row.get("category") or "").strip().lower()
            raw_text = (row.get("text") or "").strip()
            text = _normalized_text(raw_text)
            if category not in ALLOWED:
                raise ValueError(f"unknown category at CSV line {line}: {category or '<empty>'}")
            if not text:
                raise ValueError(f"empty text at CSV line {line}")
            duplicate_key = "".join(text.split())
            if duplicate_key in seen:
                raise ValueError(f"duplicate normalized text at CSV lines {seen[duplicate_key]} and {line}")
            seen[duplicate_key] = line
            pools[category].append({
                "sentenceId": _sha(f"{category}\0{text}")[:16],
                "sourceText": raw_text,
                "normalizedText": text,
            })
    for required in ("hook", "cta"):
        if not pools[required]:
            raise ValueError(f"copy pool is missing required category: {required}")
    if len([category for category in SELLING if pools[category]]) < 4:
        raise ValueError("copy pool needs at least four populated selling-point categories")
    canonical_rows = sorted((category, item["normalizedText"]) for category, items in pools.items() for item in items)
    return dict(pools), _sha(_canonical(canonical_rows))


def load_visual_pools(path):
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    clips = value.get("selection", {}).get("clipLibrary")
    if not isinstance(clips, list) or not clips:
        raise ValueError("materials selection.clipLibrary must be a non-empty list")
    by_category = defaultdict(list)
    seen_assets, seen_clips = set(), set()
    for value in clips:
        clip = dict(value)
        asset_id = clip.get("assetId")
        clip_id = clip.get("clipId") or asset_id
        fingerprint = clip.get("quickFingerprint")
        if not asset_id or asset_id in seen_assets or not fingerprint:
            raise ValueError("material clips need unique assetId values and quickFingerprint")
        if not isinstance(clip_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", clip_id):
            raise ValueError(f"material clipId must be filename-safe: {clip_id}")
        if clip_id in seen_clips:
            raise ValueError("material clips need unique clipId values")
        start, end = clip.get("sourceInSeconds"), clip.get("sourceOutSeconds")
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or start < 0 or end <= start:
            raise ValueError(f"invalid source range for material {asset_id}")
        clip = {**clip, "clipId": clip_id}
        seen_assets.add(asset_id)
        seen_clips.add(clip_id)
        by_category[clip.get("category")].append(clip)

    def matching(categories, words):
        return [clip for category in categories for clip in by_category[category]
                if any(word in f"{clip.get('sourcePath', '')} {clip.get('label', '')}" for word in words)]

    def unique(items):
        return list({item["clipId"]: item for item in items}.values())

    power = by_category["power"]
    blade = matching(("power",), ("刀头", "刀网", "按压", "贴合")) or power
    motor = matching(("power",), ("转子", "马达", "电机")) or power
    dynamic_hooks = matching(("shave",), ("没剃", "剃一道", "剃半脸", "对比"))
    gifts = matching(("cta",), ("礼盒", "赠品", "送"))
    scenes = matching(("hook", "body", "shave", "cta"), ("车", "出差", "通勤", "礼盒", "送", "人脸", "真人"))
    pools = {
        "hook": unique(by_category["hook"] + dynamic_hooks),
        "shave": unique(by_category["shave"]),
        "blade": unique(blade),
        "power": unique(motor),
        "water": unique(by_category["water"]),
        "charge": unique(by_category["charge"]),
        "appearance": unique(by_category["body"] + gifts),
        "scene": unique(scenes or by_category["body"]),
        "cta": unique(by_category["cta"]),
    }
    missing = [category for category, items in pools.items() if not items]
    if missing:
        raise ValueError(f"materials cannot serve categories: {', '.join(missing)}")
    return pools


def _pick_balanced(items, usage, seed, *salt, excluded_ids=(), excluded_fingerprints=()):
    key = lambda item: item.get("sentenceId") or _clip_id(item)
    eligible = [item for item in items if key(item) not in excluded_ids
                and item.get("quickFingerprint") not in excluded_fingerprints]
    if not eligible:
        raise ValueError("no non-duplicate sentence or material remains for one video")
    least = min(usage[key(item)] for item in eligible)
    tied = [item for item in eligible if usage[key(item)] == least]
    return min(tied, key=lambda item: (_rank(seed, *salt, key(item)), key(item)))


def _smooth(items):
    output = []
    previous_named = False
    for index, item in enumerate(items):
        text = item["normalizedText"]
        named = "上谷S5Max" in text
        if index and previous_named and text.startswith("上谷S5Max，") and len(text) > len("上谷S5Max，"):
            text = text[len("上谷S5Max，"):]
        output.append(text)
        previous_named = named
    return output


def _tts_text(value):
    return value.replace("上谷S5Max", "上谷S五Max").replace("Type-C", "Type C").replace("39000", "三万九千")


def _estimated_voice_seconds(value):
    spoken = sum(not character.isspace() and character not in "，。！？、,.!?；;：:" for character in _tts_text(value))
    return max(1.5, spoken / 3.5 + 0.5)


def _required_voice_seconds(value, audio_durations):
    return (audio_durations[_tts_text(value)] if audio_durations is not None
            else _estimated_voice_seconds(value))


def _validate_audio_durations(items, audio_durations):
    if audio_durations is None:
        return
    required = {_tts_text(text) for item in items for text in item["subtitleTexts"]}
    missing = sorted(required - set(audio_durations))
    if missing:
        raise ValueError(f"audio durations are missing {len(missing)} sentence(s): {missing[0]}")


class CapacityError(ValueError):
    def __init__(self, exact, missing):
        self.exact = exact
        self.missing = missing
        super().__init__(f"capacity exhausted at {exact}: {missing[0]['message']}")


FAST_ATTEMPTS = 10_000


def _selling_counts(count, seed):
    if not isinstance(count, int) or isinstance(count, bool) or count < 1:
        raise ValueError("target count must be a positive integer")
    if count == 1:
        return [2 + _rank(seed, "single-selling-count") % 3]
    quarters = count // 4
    values = [2] * quarters + [3] * (count // 2) + [4] * (count - quarters - count // 2)
    random.Random(_rank(seed, "selling-counts")).shuffle(values)
    return values


def _seeded(items, seed, *salt, key=lambda value: value):
    return sorted(items, key=lambda value: (_rank(seed, *salt, key(value)), key(value)))


def _clip_id(clip):
    return clip.get("clipId", clip.get("assetId"))


def _visual_signature(selected):
    return _sha("\0".join(selected))


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


def _history_manifest_paths(workspace):
    root = Path(workspace)
    return sorted({
        *root.glob("work/production-batches/*/manifest.json"),
        *root.glob("work/s5max-daily/*/manifest.json"),
        *root.glob("work/production/*/manifest.json"),
    })


def history_signatures(workspace, excluding=None):
    root = Path(workspace)
    signatures = {"copy": set(), "text": set(), "visual": set()}
    excluded = Path(excluding).resolve() if excluding else None
    paths = _history_manifest_paths(root)
    batch_values = {}
    owned_video_ids = set()
    for manifest_path in paths:
        value = json.loads(manifest_path.read_text(encoding="utf-8"))
        if value.get("schemaVersion") == 2 and "batchStatus" in value:
            batch_values[manifest_path] = value
            owned_video_ids.update(item.get("id") for item in value.get("items", []) if item.get("id"))
    for manifest_path in paths:
        if excluded and manifest_path.resolve() == excluded:
            continue
        value = batch_values.get(manifest_path)
        if value is not None:
            if value.get("batchStatus") == "archived":
                continue
            if value.get("batchStatus") not in LIVE_BATCH_STATES | {"complete"}:
                continue
            for item in value.get("items", []):
                for key in signatures:
                    if item.get(f"{key}Signature"):
                        signatures[key].add(item[f"{key}Signature"])
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
        output = value.get("output") or {}
        output_path = output.get("path") or value.get("outputPath")
        if output_path and not Path(output_path).is_absolute():
            output_path = root / output_path
        if output_path and Path(output_path).is_file() and value.get("sentences"):
            signatures["text"].add(_text_signature([item["text"] for item in value["sentences"]]))
            signatures["visual"].add(_visual_signature([item["shot"]["sourceId"] for item in value["sentences"]]))
    return signatures


@contextmanager
def _history_lock(workspace):
    lock_path = Path(workspace) / "work/production-batches/.history.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    # ponytail: one workspace-wide lock; shard per batch only if contention matters.
    with lock_path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@contextmanager
def _batch_lock(batch_dir):
    lock_path = Path(batch_dir) / ".prepare.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    # ponytail: lock order is batch then workspace; no reverse acquisition path.
    with lock_path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


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


def _iter_exhaustive_copy_candidates(pools, active, seed):
    for categories, candidates in _exhaustive_copy_candidates(pools, active, seed):
        for candidate in candidates:
            yield categories, candidate


def _exhaustive_visual_candidates(item, visual_pools, seed, audio_durations):
    choices = []
    for slot, (category, text) in enumerate(zip(item["categories"], item["subtitleTexts"])):
        required = _required_voice_seconds(text, audio_durations)
        eligible = [clip for clip in visual_pools[category]
                    if clip["sourceOutSeconds"] - clip["sourceInSeconds"] >= required]
        choices.append(_seeded(eligible, seed, "all-visual", slot, key=_clip_id))
    for selected in itertools.product(*choices):
        clip_ids = [_clip_id(clip) for clip in selected]
        fingerprints = [clip["quickFingerprint"] for clip in selected]
        if len(set(clip_ids)) == len(clip_ids) and len(set(fingerprints)) == len(fingerprints):
            yield selected


def _copy_item(*, index, batch_id, selling_count, categories, selected_sentences):
    source_ids = [item["sentenceId"] for item in selected_sentences]
    texts = _smooth(selected_sentences)
    copy_signature = _sha("|".join(source_ids))
    text_signature = _sha("".join(texts))
    return {
        "id": f"{PRODUCT_SKU}-{batch_id}-{index + 1:03d}",
        "title": f"S5Max {batch_id} 每日组合 {index + 1:03d}",
        "sellingPointCount": selling_count,
        "categories": list(categories),
        "sourceSentenceIds": source_ids,
        "sourceSentences": [{key: sentence[key] for key in ("sentenceId", "sourceText", "normalizedText")}
                            for sentence in selected_sentences],
        "sourceTexts": [item["sourceText"] for item in selected_sentences],
        "subtitleTexts": texts,
        "copySignature": copy_signature,
        "textSignature": text_signature,
    }


def _material_missing(item, visual_pools, audio_durations):
    missing = []
    for slot, (category, text) in enumerate(zip(item["categories"], item["subtitleTexts"])):
        required = _required_voice_seconds(text, audio_durations)
        if not any(clip["sourceOutSeconds"] - clip["sourceInSeconds"] >= required
                   for clip in visual_pools[category]):
            source_id = item["sourceSentenceIds"][slot]
            missing.append({
                "kind": "material",
                "category": category,
                "sentenceId": source_id,
                "requiredSeconds": required,
                "message": f"no {category} clip covers estimated {required:.1f}s voice: {text}",
            })
    return missing


def _attach_visual(item, selected, visual_signature, catalog_path, voice_path, audio_durations=None):
    slots = [{
        "category": category, "assetId": clip["assetId"], "clipId": _clip_id(clip),
        "quickFingerprint": clip["quickFingerprint"],
        "sourceInSeconds": clip["sourceInSeconds"], "sourceOutSeconds": clip["sourceOutSeconds"],
    } for category, clip in zip(item["categories"], selected)]
    item["visualSlots"] = slots
    item["visualSignature"] = visual_signature
    if audio_durations is not None:
        durations = [_required_voice_seconds(text, audio_durations) for text in item["subtitleTexts"]]
        item["plannedDurationSeconds"] = sum(durations) + max(0, len(durations) - 1) * 5 / 30
    item["plan"] = {
        "schemaVersion": 1, "id": item["id"], "title": item["title"],
        "sourceText": "".join(item["subtitleTexts"]), "catalogPath": str(catalog_path),
        "voice": {"promptPath": str(voice_path), "durationFactor": 1},
        "sentences": [{
            "id": f"s{slot + 1:02d}", "text": text, "ttsText": _tts_text(text),
            "shot": {"sourceId": visual["assetId"], "sourceInSeconds": visual["sourceInSeconds"],
                     "sourceOutSeconds": visual["sourceOutSeconds"], "fit": "cover", "focusX": 0.5, "focusY": 0.5},
        } for slot, (text, visual) in enumerate(zip(item["subtitleTexts"], slots))],
    }


def _batch_result(batch_id, input_hash, seed, count, sentence_usage, asset_usage, items):
    return {
        "schemaVersion": 2, "batchId": batch_id, "productSku": PRODUCT_SKU, "inputHash": input_hash,
        "seed": seed, "targetCount": count,
        "sellingPointDistribution": {str(value): sum(item["sellingPointCount"] == value for item in items)
                                     for value in (2, 3, 4)},
        "sentenceUsage": dict(sorted(sentence_usage.items())), "assetUsage": dict(sorted(asset_usage.items())),
        "items": items,
    }


def _plan_joint_fallback(*, batch_id, seed, pools, visual_pools, input_hash, catalog_path, voice_path,
                         count, forbidden, audio_durations, active, selling_counts):
    missing = [{"kind": "copy", "message": "add more hook, CTA, or selling sentences"}]
    groups = Counter(selling_counts)
    ordered_groups = sorted(groups)
    narratives = {}
    narrative_edges = {}
    visual_sources = {}
    visual_seen = {}
    visual_exhausted = {}
    group_nodes = {selling_count: [] for selling_count in groups}
    copy_sources = {selling_count: _iter_exhaustive_copy_candidates(pools, active, seed)
                    for selling_count in ordered_groups}
    copy_exhausted = {selling_count: False for selling_count in ordered_groups}
    seen_narratives = set()
    next_node = 0

    source_node, sink_node = ("source",), ("sink",)
    graph = defaultdict(list)

    def add_edge(start, end, capacity):
        forward = [end, len(graph[end]), capacity]
        reverse = [start, len(graph[start]), 0]
        graph[start].append(forward)
        graph[end].append(reverse)
        return forward

    group_edges = {
        selling_count: add_edge(source_node, ("group", selling_count), groups[selling_count])
        for selling_count in ordered_groups
    }
    visual_sink_edges = {}

    def ensure_visual(visual_signature):
        if visual_signature not in visual_sink_edges:
            visual_node = ("visual", visual_signature)
            visual_sink_edges[visual_signature] = add_edge(visual_node, sink_node, 1)

    def add_visual_edge(node):
        source = visual_sources[node]
        seen = visual_seen[node]
        while True:
            try:
                visual_candidate = next(source)
            except StopIteration:
                visual_exhausted[node] = True
                return None
            visual_signature = _visual_signature([_clip_id(clip) for clip in visual_candidate])
            if visual_signature in seen or visual_signature in forbidden["visual"]:
                continue
            seen.add(visual_signature)
            ensure_visual(visual_signature)
            edge = add_edge(("narrative", node), ("visual", visual_signature), 1)
            narrative_edges[node].append((visual_signature, visual_candidate, edge))
            return edge

    def augment(node, visited):
        if node == sink_node:
            return True
        if node in visited:
            return False
        visited.add(node)
        for edge in graph[node]:
            if edge[2] <= 0 or edge[0] in visited:
                continue
            if augment(edge[0], visited):
                edge[2] -= 1
                graph[edge[0]][edge[1]][2] += 1
                return True
        if node[0] == "narrative" and not visual_exhausted[node[1]]:
            while True:
                edge = add_visual_edge(node[1])
                if edge is None:
                    break
                if edge[0] not in visited and augment(edge[0], visited):
                    edge[2] -= 1
                    graph[edge[0]][edge[1]][2] += 1
                    return True
        return False

    def add_narrative(selling_count):
        nonlocal next_node, missing
        source = copy_sources[selling_count]
        while not copy_exhausted[selling_count]:
            try:
                categories, candidate = next(source)
            except StopIteration:
                copy_exhausted[selling_count] = True
                return False
            if len(categories) != selling_count:
                continue
            item = _copy_item(index=0, batch_id=batch_id, selling_count=selling_count,
                              categories=("hook", *categories, "cta"), selected_sentences=candidate)
            _validate_audio_durations([item], audio_durations)
            narrative_key = (item["copySignature"], item["textSignature"])
            if (narrative_key in seen_narratives or item["copySignature"] in forbidden["copy"]
                    or item["textSignature"] in forbidden["text"]):
                continue
            seen_narratives.add(narrative_key)
            material_missing = _material_missing(item, visual_pools, audio_durations)
            if material_missing:
                missing = material_missing
                continue
            node = next_node
            next_node += 1
            narratives[node] = item
            add_edge(("group", selling_count), ("narrative", node), 1)
            narrative_edges[node] = []
            visual_sources[node] = _exhaustive_visual_candidates(item, visual_pools, seed, audio_durations)
            visual_seen[node] = set()
            visual_exhausted[node] = False
            group_nodes[selling_count].append(node)
            return True
        return False

    # ponytail: matching runs only after fast path; augmenting paths cache only visited visual edges.
    # The lazy source expansion pauses satisfied groups and resumes them only for later conflicts.
    for group_index, selling_count in enumerate(ordered_groups):
        target = groups[selling_count]
        while groups[selling_count] - group_edges[selling_count][2] < target:
            if add_narrative(selling_count):
                augment(source_node, set())
                continue
            expanded = False
            for prior_group in ordered_groups[:group_index]:
                if add_narrative(prior_group):
                    expanded = True
                    augment(source_node, set())
                    if groups[selling_count] - group_edges[selling_count][2] >= target:
                        break
            if groups[selling_count] - group_edges[selling_count][2] >= target:
                break
            if not expanded:
                exact = sum(groups[value] - group_edges[value][2] for value in ordered_groups)
                raise CapacityError(exact, missing)

    items = []
    sentence_usage, asset_usage = Counter(), Counter()
    queues = {
        selling_count: [node for node in nodes
                        if any(edge[2] == 0 for _, _, edge in narrative_edges[node])]
        for selling_count, nodes in group_nodes.items()
    }
    for index, selling_count in enumerate(selling_counts):
        node = queues[selling_count].pop(0)
        item = narratives[node]
        visual_signature, visual_candidate, _ = next(edge for edge in narrative_edges[node] if edge[2][2] == 0)
        item["id"] = f"{PRODUCT_SKU}-{batch_id}-{index + 1:03d}"
        item["title"] = f"S5Max {batch_id} 每日组合 {index + 1:03d}"
        _attach_visual(item, visual_candidate, visual_signature, catalog_path, voice_path, audio_durations)
        sentence_usage.update(item["sourceSentenceIds"])
        asset_usage.update(_clip_id(clip) for clip in visual_candidate)
        items.append(item)
    return _batch_result(batch_id, input_hash, seed, count, sentence_usage, asset_usage, items)


def plan_batch(*, batch_id, seed, copy_csv, materials_path, catalog_path, voice_path, count=300,
               forbidden=None, audio_durations=None):
    if forbidden is None:
        forbidden = {"copy": set(), "text": set(), "visual": set()}
    required_forbidden = {"copy", "text", "visual"}
    if set(forbidden) != required_forbidden or any(not isinstance(forbidden[key], set) for key in required_forbidden):
        raise ValueError("forbidden must contain copy, text, and visual sets")
    if not isinstance(batch_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", batch_id):
        raise ValueError("batch_id must be filename-safe")
    if not isinstance(seed, str) or not seed:
        raise ValueError("seed must be non-empty")
    pools, input_hash = load_copy_pool(copy_csv)
    visual_pools = load_visual_pools(materials_path)
    selling_counts = _selling_counts(count, seed)
    active = tuple(category for category in SELLING if pools.get(category))
    if FAST_ATTEMPTS == 0:
        return _plan_joint_fallback(batch_id=batch_id, seed=seed, pools=pools, visual_pools=visual_pools,
                                    input_hash=input_hash, catalog_path=catalog_path, voice_path=voice_path,
                                    count=count, forbidden=forbidden, audio_durations=audio_durations, active=active,
                                    selling_counts=selling_counts)
    sentence_usage, category_usage, template_usage = Counter(), Counter(), Counter()
    copy_signatures, text_signatures = set(), set()
    items = []
    copy_fallback = None

    for index, selling_count in enumerate(selling_counts):
        if selling_count > len(active):
            raise CapacityError(len(items), [{
                "kind": "copy",
                "message": f"copy pool cannot provide {selling_count} distinct selling categories",
            }])
        selected_sentences = None
        selected_categories = None
        selected_template = None
        accepted = False
        for attempt in range(FAST_ATTEMPTS) if copy_fallback is None else ():
            combinations = itertools.combinations(active, selling_count)
            template_min = min(template_usage[i] for i in range(len(TEMPLATES)))
            template_candidates = [i for i in range(len(TEMPLATES)) if template_usage[i] == template_min]
            template_index = min(template_candidates, key=lambda value: _rank(seed, "template", index, attempt, value))
            score = min((sum(category_usage[c] for c in combo), max(category_usage[c] for c in combo)) for combo in combinations)
            combinations = itertools.combinations(active, selling_count)
            category_candidates = [combo for combo in combinations
                                   if (sum(category_usage[c] for c in combo), max(category_usage[c] for c in combo)) == score]
            selected_categories = min(category_candidates, key=lambda combo: _rank(seed, "categories", index, attempt, *combo))
            priority = {category: position for position, category in enumerate(TEMPLATES[template_index])}
            ordered_categories = tuple(sorted(selected_categories, key=priority.get))
            categories = ("hook", *ordered_categories, "cta")
            selected_sentences = [_pick_balanced(pools[category], sentence_usage, seed, "copy", index, attempt, slot)
                                  for slot, category in enumerate(categories)]
            source_ids = [item["sentenceId"] for item in selected_sentences]
            texts = _smooth(selected_sentences)
            copy_signature = _sha("|".join(source_ids))
            text_signature = _sha("".join(texts))
            if (copy_signature not in copy_signatures
                    and copy_signature not in forbidden["copy"]
                    and text_signature not in text_signatures
                    and text_signature not in forbidden["text"]):
                selected_categories = ordered_categories
                selected_template = template_index
                accepted = True
                break
        if not accepted:
            selected_sentences = None
            selected_categories = None
            copy_fallback = copy_fallback or _iter_exhaustive_copy_candidates(pools, active, seed)
            for candidate_categories, candidate in copy_fallback:
                selected_categories = candidate_categories
                categories = ("hook", *candidate_categories, "cta")
                candidate_item = _copy_item(index=index, batch_id=batch_id, selling_count=len(candidate_categories),
                                            categories=categories, selected_sentences=candidate)
                if (candidate_item["copySignature"] not in copy_signatures
                        and candidate_item["copySignature"] not in forbidden["copy"]
                        and candidate_item["textSignature"] not in text_signatures
                        and candidate_item["textSignature"] not in forbidden["text"]):
                    selected_sentences = candidate
                    selected_template = None
                    break
        if selected_sentences is None or selected_categories is None:
            raise CapacityError(len(items), [{
                "kind": "copy",
                "message": "add more hook, CTA, or selling sentences",
            }])
        categories = ("hook", *selected_categories, "cta")
        candidate_item = _copy_item(index=index, batch_id=batch_id, selling_count=len(selected_categories),
                                    categories=categories, selected_sentences=selected_sentences)
        copy_signature = candidate_item["copySignature"]
        text_signature = candidate_item["textSignature"]
        copy_signatures.add(copy_signature)
        text_signatures.add(text_signature)
        if selected_template is not None:
            template_usage[selected_template] += 1
        category_usage.update(selected_categories)
        sentence_usage.update(item["sentenceId"] for item in selected_sentences)
        items.append(candidate_item)

    _validate_audio_durations(items, audio_durations)

    asset_usage, visual_signatures = Counter(), set()
    previous_hook = None
    for index, item in enumerate(items):
        selected = None
        visual_signature = None
        missing = _material_missing(item, visual_pools, audio_durations)
        if missing:
            return _plan_joint_fallback(batch_id=batch_id, seed=seed, pools=pools, visual_pools=visual_pools,
                                        input_hash=input_hash, catalog_path=catalog_path, voice_path=voice_path,
                                        count=count, forbidden=forbidden, audio_durations=audio_durations, active=active,
                                        selling_counts=selling_counts)
        for attempt in range(FAST_ATTEMPTS):
            selected, used_ids, used_fingerprints = [], set(), set()
            complete = True
            for slot, category in enumerate(item["categories"]):
                excluded_ids = set(used_ids)
                if slot == 0 and previous_hook and len(visual_pools[category]) > 1:
                    excluded_ids.add(previous_hook)
                required_seconds = _required_voice_seconds(item["subtitleTexts"][slot], audio_durations)
                long_enough = [clip for clip in visual_pools[category]
                               if clip["sourceOutSeconds"] - clip["sourceInSeconds"] >= required_seconds]
                if not long_enough:
                    return _plan_joint_fallback(batch_id=batch_id, seed=seed, pools=pools, visual_pools=visual_pools,
                                                input_hash=input_hash, catalog_path=catalog_path, voice_path=voice_path,
                                                count=count, forbidden=forbidden, audio_durations=audio_durations, active=active,
                                                selling_counts=selling_counts)
                try:
                    clip = _pick_balanced(long_enough, asset_usage, seed, "visual", index, attempt, slot,
                                          excluded_ids=excluded_ids, excluded_fingerprints=used_fingerprints)
                except ValueError:
                    complete = False
                    break
                selected.append(clip)
                used_ids.add(_clip_id(clip))
                used_fingerprints.add(clip["quickFingerprint"])
            if not complete:
                continue
            visual_signature = _visual_signature([_clip_id(clip) for clip in selected])
            if visual_signature not in visual_signatures and visual_signature not in forbidden["visual"]:
                break
        else:
            selected = None
        if selected is None or visual_signature is None or visual_signature in visual_signatures or visual_signature in forbidden["visual"]:
            for candidate in _exhaustive_visual_candidates(item, visual_pools, seed, audio_durations):
                if previous_hook and len(visual_pools[item["categories"][0]]) > 1 and _clip_id(candidate[0]) == previous_hook:
                    continue
                candidate_signature = _visual_signature([_clip_id(clip) for clip in candidate])
                if candidate_signature not in visual_signatures and candidate_signature not in forbidden["visual"]:
                    selected, visual_signature = candidate, candidate_signature
                    break
        if selected is None or visual_signature is None:
            return _plan_joint_fallback(batch_id=batch_id, seed=seed, pools=pools, visual_pools=visual_pools,
                                        input_hash=input_hash, catalog_path=catalog_path, voice_path=voice_path,
                                        count=count, forbidden=forbidden, audio_durations=audio_durations, active=active,
                                        selling_counts=selling_counts)
        visual_signatures.add(visual_signature)
        asset_usage.update(_clip_id(clip) for clip in selected)
        previous_hook = _clip_id(selected[0])
        _attach_visual(item, selected, visual_signature, catalog_path, voice_path, audio_durations)

    return {
        "schemaVersion": 2, "batchId": batch_id, "productSku": PRODUCT_SKU, "inputHash": input_hash,
        "seed": seed, "targetCount": count,
        "sellingPointDistribution": {str(value): selling_counts.count(value) for value in (2, 3, 4)},
        "sentenceUsage": dict(sorted(sentence_usage.items())), "assetUsage": dict(sorted(asset_usage.items())),
        "items": items,
    }


def _atomic_text(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(value, encoding="utf-8")
    os.replace(temporary, path)


def _atomic_json(path, value):
    _atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def _sha_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _wav_seconds(path):
    try:
        with wave.open(str(path), "rb") as audio:
            frames = audio.getnframes()
            rate = audio.getframerate()
            expected = frames * audio.getnchannels() * audio.getsampwidth()
            actual = len(audio.readframes(frames))
    except (EOFError, OSError, ValueError, wave.Error) as error:
        raise ValueError(f"invalid prewarmed WAV: {path}") from error
    if frames <= 0 or rate <= 0 or actual != expected:
        raise ValueError(f"invalid prewarmed WAV: {path}")
    return frames / rate


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
    items = manifest.get("items", [])
    if [item.get("text") for item in items] != texts:
        raise ValueError("prewarm sentence mapping mismatch")
    durations = {}
    for item in items:
        raw_output = Path(item["outputPath"])
        output = raw_output if raw_output.is_absolute() else Path(cache_dir) / raw_output
        output = _inside(cache_dir, output, "prewarm WAV")
        if not re.fullmatch(r"[a-f0-9]{64}", item.get("contentKey", "")):
            raise ValueError("prewarm WAV hash mismatch")
        if item.get("sha256") != _sha_file(output):
            raise ValueError("prewarm WAV hash mismatch")
        durations[item["text"]] = _wav_seconds(output)
    return durations


def _resource_estimate(workspace, target_count, jobs, batch=None, catalog_path=None):
    root = Path(workspace)
    manifests = [json.loads(path.read_text(encoding="utf-8"))
                 for path in root.glob("work/production-batches/*/manifest.json")]
    elapsed = []
    for manifest in manifests:
        for item in manifest.get("items", []):
            if item.get("renderStartedAt") and item.get("verifiedAt"):
                start = datetime.fromisoformat(item["renderStartedAt"])
                end = datetime.fromisoformat(item["verifiedAt"])
                elapsed.append((end - start).total_seconds())
    sizes = [path.stat().st_size for path in root.glob("out/**/*.mp4") if path.is_file()]
    seconds_per_video = statistics.median(elapsed) if elapsed else 180
    bytes_per_video = statistics.median(sizes) if sizes else 50 * 1024 * 1024
    render_minutes = target_count * seconds_per_video / max(1, jobs) / 60
    sentence_count = len({sentence["ttsText"] for item in (batch or {}).get("items", [])
                          for sentence in item["plan"]["sentences"]}) or target_count * 5
    selected_assets = {slot["assetId"] for item in (batch or {}).get("items", [])
                       for slot in item["visualSlots"]}
    catalog = Path(catalog_path) if catalog_path else None
    if catalog is not None and not catalog.is_absolute():
        catalog = root / catalog
    assets = ({asset.get("id"): asset for asset in json.loads(catalog.read_text(encoding="utf-8")).get("assets", [])}
              if catalog and catalog.is_file() else {})
    missing_proxies = 0
    for asset_id in selected_assets:
        asset = assets.get(asset_id)
        if not asset:
            continue
        proxy_path = asset.get("proxyPath")
        if proxy_path:
            proxy = Path(proxy_path)
            if not proxy.is_absolute():
                proxy = root / proxy
        if not proxy_path or not proxy.is_file():
            missing_proxies += 1
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
        return {**estimate, "targetCount": target_count, "canProduce": False,
                "capacityExact": error.exact, "missing": error.missing}
    except (OSError, ValueError) as error:
        estimate = _resource_estimate(workspace, target_count, jobs)
        return {**estimate, "targetCount": target_count, "canProduce": False,
                "capacityExact": 0, "missing": [{"kind": "input", "message": str(error)}]}
    estimate = _resource_estimate(workspace, target_count, jobs, batch, plan_options["catalog_path"])
    return {**estimate, "targetCount": target_count, "canProduce": True,
            "capacityAtLeast": target_count, "missing": []}


def reserve_batch(workspace, manifest_path):
    manifest_path = _inside(workspace, manifest_path, "manifest")
    with _history_lock(workspace):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        status = manifest.get("batchStatus")
        if status == "complete":
            raise ValueError("completed batches cannot be reserved")
        if status != "audio_ready":
            raise ValueError(f"cannot reserve batch in state {status!r}; expected audio_ready")
        history = history_signatures(workspace, excluding=manifest_path)
        seen = {key: set() for key in ("copy", "text", "visual")}
        for item in manifest["items"]:
            for key in ("copy", "text", "visual"):
                signature = item[f"{key}Signature"]
                if signature in seen[key]:
                    raise ValueError(f"manifest duplicate for {key}: {item['id']}")
                seen[key].add(signature)
                if signature in history[key]:
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
        status = manifest.get("batchStatus")
        if status == "complete":
            raise ValueError("completed batches cannot be archived")
        if status not in ARCHIVABLE_BATCH_STATES:
            raise ValueError(f"cannot archive batch in state {status!r}")
        manifest["batchStatus"] = "archived"
        manifest["archivedAt"] = datetime.now().astimezone().isoformat()
        manifest["archiveReason"] = reason.strip()
        _atomic_json(manifest_path, manifest)
    return manifest


def write_batch(batch, batch_dir, copy_csv, *, mode=None, source_copy_path=None,
                materials_path=None, output_dir=None):
    batch_dir = Path(batch_dir)
    plans_dir = batch_dir / "plans"
    plans_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = batch_dir / "manifest.json"
    previous = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else None
    if previous and previous.get("inputHash") != batch["inputHash"]:
        raise ValueError(f"batch directory already belongs to inputHash {previous.get('inputHash')}; use another date/directory")
    old_items = {item["id"]: item for item in (previous or {}).get("items", [])}
    scripts, matrix, manifest_items = [], [], []
    for item in batch["items"]:
        plan_name = f"plans/{item['id']}.json"
        _atomic_json(batch_dir / plan_name, item["plan"])
        scripts.append({key: item[key] for key in ("id", "title", "sellingPointCount", "categories", "sourceSentenceIds", "sourceSentences", "sourceTexts", "subtitleTexts", "copySignature", "textSignature")})
        matrix.append({"id": item["id"], "visualSignature": item["visualSignature"], "slots": item["visualSlots"]})
        old = old_items.get(item["id"], {})
        manifest_items.append({
            "id": item["id"], "planPath": plan_name, "copySignature": item["copySignature"],
            "textSignature": item["textSignature"], "visualSignature": item["visualSignature"],
            "sellingPointCount": item["sellingPointCount"],
            "visualSlots": item["visualSlots"],
            **({"plannedDurationSeconds": item["plannedDurationSeconds"]}
               if "plannedDurationSeconds" in item else {}),
            "status": old.get("status", "voiced" if mode else "planned"),
            **({"outputPath": old["outputPath"]} if old.get("outputPath") else {}),
            **({"error": old["error"]} if old.get("error") else {}),
        })
    header = {key: batch[key] for key in ("schemaVersion", "batchId", "productSku", "inputHash", "seed", "targetCount", "sellingPointDistribution")}
    copy_pool_path = batch_dir / "copy-pool.csv"
    _snapshot_once(copy_pool_path, Path(copy_csv).read_text(encoding="utf-8-sig"))
    _atomic_json(batch_dir / "scripts.json", {**header, "items": scripts})
    _atomic_json(batch_dir / "material-matrix.json", {**header, "items": matrix})
    manifest = {**header, "items": manifest_items}
    if mode is not None:
        first_plan = batch["items"][0].get("plan", {}) if batch.get("items") else {}
        manifest.update({
            "mode": mode,
            "batchStatus": "audio_ready",
            "sourceCopyPath": str(source_copy_path) if source_copy_path is not None else str(batch_dir / "source-copy.txt"),
            "copyPoolPath": str(copy_pool_path),
            "materialsPath": str(materials_path) if materials_path is not None else "",
            "catalogPath": first_plan.get("catalogPath", ""),
            "voice": first_plan.get("voice", {}),
            "outputDir": str(output_dir) if output_dir is not None else str(batch_dir),
        })
    _atomic_json(manifest_path, manifest)
    return manifest_path


def _inside(root, value, label):
    root, value = Path(root).resolve(), Path(value).resolve()
    try:
        value.relative_to(root)
    except ValueError as error:
        raise ValueError(f"{label} must stay inside workspace: {value}") from error
    return value


def _validate_catalog(batch, catalog_path):
    catalog = json.loads(Path(catalog_path).read_text(encoding="utf-8"))
    assets = {asset.get("id"): asset for asset in catalog.get("assets", [])}
    for item in batch["items"]:
        for slot in item["visualSlots"]:
            asset = assets.get(slot["assetId"])
            if not asset:
                raise ValueError(f"catalog is missing selected asset {slot['assetId']}")
            if slot["sourceOutSeconds"] > asset.get("durationInSeconds", 0):
                raise ValueError(f"selected range exceeds catalog asset {slot['assetId']}")


def _prepare_batch_locked(*, workspace, mode, source_copy, copy_csv, materials_path, catalog_path,
                          voice_path, model_dir, index_python, target_count, batch_id, seed, device="mps"):
    workspace = Path(workspace).resolve()
    if mode not in {"single", "batch"}:
        raise ValueError("mode must be single or batch")
    if (mode == "single") != (target_count == 1):
        raise ValueError("single mode requires target_count 1")
    if not isinstance(batch_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", batch_id):
        raise ValueError("batch_id must be filename-safe")
    batch_dir = workspace / "work/production-batches" / batch_id
    batch_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = batch_dir / "manifest.json"
    if manifest_path.exists():
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
            catalog_path=catalog_path, voice_path=voice_path, count=target_count, forbidden=forbidden,
        )
        _atomic_json(draft_path, {
            "batchId": batch_id, "seed": seed, "targetCount": target_count,
            "forbidden": {key: sorted(values) for key, values in forbidden.items()},
            "provisional": provisional,
        })
    _validate_catalog(provisional, catalog_path)

    unique_texts = list(dict.fromkeys(
        sentence["ttsText"] for item in provisional["items"] for sentence in item["plan"]["sentences"]
    ))
    prewarm_path = batch_dir / "tts-prewarm.jsonl"
    _snapshot_once(prewarm_path, "".join(
        json.dumps({"text": text, "duration_factor": 1}, ensure_ascii=False) + "\n" for text in unique_texts
    ))
    cache_dir = workspace / "work/indextts25/cache"
    tts_manifest_path = batch_dir / "tts-prewarm-manifest.json"
    subprocess.run([
        str(index_python), str(workspace / "scripts/indextts25-batch.py"),
        "--batch-file", str(prewarm_path), "--voice", str(voice_path),
        "--model-dir", str(model_dir), "--output-dir", str(cache_dir),
        "--expected-count", str(len(unique_texts)), "--output-prefix", "sentence",
        "--manifest", str(tts_manifest_path), "--device", device,
    ], cwd=workspace, check=True)
    durations = _prewarm_durations(tts_manifest_path, unique_texts, voice_path, model_dir, cache_dir)
    final = plan_batch(
        batch_id=batch_id, seed=seed, copy_csv=batch_dir / "copy-pool.csv", materials_path=materials_path,
        catalog_path=catalog_path, voice_path=voice_path, count=target_count, forbidden=forbidden,
        audio_durations=durations,
    )
    _validate_catalog(final, catalog_path)
    manifest_path = write_batch(
        final, batch_dir, batch_dir / "copy-pool.csv", mode=mode,
        source_copy_path=batch_dir / "source-copy.txt", materials_path=materials_path,
        output_dir=workspace / "out/production-batches" / batch_id,
    )
    reserve_batch(workspace, manifest_path)
    return manifest_path


def prepare_batch(*, workspace, mode, source_copy, copy_csv, materials_path, catalog_path,
                  voice_path, model_dir, index_python, target_count, batch_id, seed, device="mps"):
    workspace = Path(workspace).resolve()
    if mode not in {"single", "batch"}:
        raise ValueError("mode must be single or batch")
    if (mode == "single") != (target_count == 1):
        raise ValueError("single mode requires target_count 1")
    if not isinstance(batch_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", batch_id):
        raise ValueError("batch_id must be filename-safe")
    batch_dir = workspace / "work/production-batches" / batch_id
    batch_dir.mkdir(parents=True, exist_ok=True)
    with _batch_lock(batch_dir):
        manifest_path = batch_dir / "manifest.json"
        if manifest_path.exists():
            status = json.loads(manifest_path.read_text(encoding="utf-8")).get("batchStatus")
            if status:
                raise ValueError(f"batch {batch_id} is already in state {status}")
            raise ValueError(f"batch is already prepared: {batch_id}")
        return _prepare_batch_locked(
            workspace=workspace, mode=mode, source_copy=source_copy, copy_csv=copy_csv,
            materials_path=materials_path, catalog_path=catalog_path, voice_path=voice_path,
            model_dir=model_dir, index_python=index_python, target_count=target_count,
            batch_id=batch_id, seed=seed, device=device,
        )


def _run_producer(*, item, batch_dir, workspace, model_dir, index_python, out_dir):
    output = Path(out_dir) / f"{item['id']}.mp4"
    workspace = Path(workspace)
    batch_dir = Path(batch_dir)
    work_dir = workspace / "work/production" / item["id"]
    partial = Path(out_dir) / f"{item['id']}.partial.mp4"
    production_manifest = work_dir / "manifest.json"
    if (output.is_file() and not output.is_symlink()
            and production_manifest.is_file() and not production_manifest.is_symlink()):
        raise ValueError(f"unverified final output already exists: {output}")
    stale = [path for path in (work_dir, partial) if path.exists()]
    if output.exists() or output.is_symlink():
        stale.append(output)
    if stale:
        retry_dir = batch_dir / "retries" / f"{item['id']}-{datetime.now().strftime('%Y%m%dT%H%M%S%f')}"
        retry_dir.mkdir(parents=True)
        for path in stale:
            shutil.move(str(path), retry_dir / path.name)
    plan = _inside(batch_dir, batch_dir / item["planPath"], "plan")
    subprocess.run([
        "node", str(workspace / "scripts/produce.mjs"), "--plan", str(plan),
        "--model-dir", str(model_dir), "--python", str(index_python), "--out-dir", str(out_dir),
    ], cwd=workspace, check=True)
    production_manifest = workspace / "work/production" / item["id"] / "manifest.json"
    if (not output.is_file() or output.is_symlink()
            or not production_manifest.is_file() or production_manifest.is_symlink()):
        raise RuntimeError(f"producer did not atomically publish {item['id']}")
    return str(output)


def _representative_sample(items):
    if not items:
        raise ValueError("batch contains no items")
    median_duration = statistics.median(item["plannedDurationSeconds"] for item in items)
    return min(items, key=lambda item: (
        abs(item["sellingPointCount"] - 3),
        abs(item["plannedDurationSeconds"] - median_duration),
        item["id"],
    ))["id"]


def _render_items(*, manifest, manifest_path, workspace, model_dir, index_python, item_ids, jobs):
    workspace = Path(workspace).resolve()
    manifest_path = Path(manifest_path).resolve()
    batch_dir = manifest_path.parent
    out_dir = _inside(workspace, manifest["outputDir"], "out-dir")
    out_dir.mkdir(parents=True, exist_ok=True)
    by_id = {item["id"]: item for item in manifest["items"]}
    pending = []
    for item_id in item_ids:
        if item_id not in by_id:
            raise ValueError(f"unknown item: {item_id}")
        item = by_id[item_id]
        output = out_dir / f"{item_id}.mp4"
        production = workspace / "work/production" / item_id / "manifest.json"
        if (output.is_file() and not output.is_symlink()
                and production.is_file() and not production.is_symlink()):
            item.update(status="verified", outputPath=str(output))
            item.pop("error", None)
            continue
        item["status"] = "voiced"
        item["renderStartedAt"] = datetime.now().astimezone().isoformat()
        item.pop("failedStage", None)
        item.pop("error", None)
        pending.append(item)
    _atomic_json(manifest_path, manifest)

    failures = []
    with ThreadPoolExecutor(max_workers=max(1, jobs)) as executor:
        futures = {
            executor.submit(
                _run_producer, item=item, batch_dir=batch_dir, workspace=workspace,
                model_dir=model_dir, index_python=index_python, out_dir=out_dir,
            ): item
            for item in pending
        }
        for future in as_completed(futures):
            item = futures[future]
            try:
                future.result()
                output = out_dir / f"{item['id']}.mp4"
                production = workspace / "work/production" / item["id"] / "manifest.json"
                if (not output.is_file() or output.is_symlink()
                        or not production.is_file() or production.is_symlink()):
                    raise RuntimeError(f"producer did not atomically publish {item['id']}")
                item["outputPath"] = str(output)
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
    workspace = Path(workspace).resolve()
    manifest_path = _inside(workspace, manifest_path, "manifest")
    with _batch_lock(manifest_path.parent):
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


def approve_sample(*, manifest_path):
    manifest_path = Path(manifest_path).resolve()
    with _batch_lock(manifest_path.parent):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("batchStatus") in {"sample_approved", "rendering", "complete"}:
            return manifest
        sample = next((item for item in manifest.get("items", []) if item["id"] == manifest.get("sampleId")), None)
        if manifest.get("mode") != "batch" or manifest.get("batchStatus") != "sample_pending" \
                or not sample or sample.get("status") != "verified":
            raise ValueError("a verified sample is required before approval")
        output = Path(sample.get("outputPath", ""))
        if not output.is_absolute():
            output = Path(manifest.get("outputDir", "")) / output
        output = _inside(manifest["outputDir"], output, "sample output")
        workspace = manifest_path.parents[3] if len(manifest_path.parents) > 3 else manifest_path.parent
        production = workspace / "work/production" / sample["id"] / "manifest.json"
        if (not output.is_file() or output.is_symlink()
                or not production.is_file() or production.is_symlink()):
            raise ValueError("a verified sample is required before approval")
        manifest["batchStatus"] = "sample_approved"
        manifest["sampleApprovedAt"] = datetime.now().astimezone().isoformat()
        _atomic_json(manifest_path, manifest)
        return manifest


def reject_sample(*, manifest_path, workspace, reason):
    workspace = Path(workspace).resolve()
    manifest_path = _inside(workspace, manifest_path, "manifest")
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError("archive reason must be non-empty")
    with _batch_lock(manifest_path.parent):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("batchStatus") not in ARCHIVABLE_BATCH_STATES:
            raise ValueError("only a non-rendering unfinished batch can be rejected")
        sample = next((item for item in manifest.get("items", []) if item["id"] == manifest.get("sampleId")), None)
        rejected_dir = manifest_path.parent / "rejected-sample"
        rejected_dir.mkdir(parents=True, exist_ok=True)
        if sample and sample.get("outputPath"):
            output = Path(sample["outputPath"])
            if not output.is_absolute():
                output = Path(manifest["outputDir"]) / output
            output = _inside(manifest["outputDir"], output, "sample output")
            if output.exists():
                rejected = rejected_dir / output.name
                shutil.move(str(output), rejected)
                sample["archivedOutputPath"] = str(rejected)
                sample.pop("outputPath", None)
        if sample:
            production = workspace / "work/production" / sample["id"]
            if production.exists():
                shutil.move(str(production), rejected_dir / "work-production")
        _atomic_json(manifest_path, manifest)
    return archive_batch(workspace, manifest_path, reason)


def render_batch(*, manifest_path, workspace, model_dir, index_python, jobs=1, out_dir=None,
                 limit=None, item_id=None, device="mps"):
    workspace = Path(workspace).resolve()
    manifest_path = _inside(workspace, manifest_path, "manifest")
    batch_dir = manifest_path.parent
    with _batch_lock(batch_dir):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        status = manifest.get("batchStatus")
        target_count = manifest.get("targetCount", len(manifest.get("items", [])))
        mode = manifest.get("mode")
        if out_dir is not None:
            manifest["outputDir"] = str(_inside(workspace, out_dir, "out-dir"))
        elif manifest.get("outputDir"):
            manifest["outputDir"] = str(_inside(workspace, manifest["outputDir"], "out-dir"))
        elif status == "complete":
            return {"selected": target_count, "rendered": 0, "verified": target_count, "outDir": ""}
        else:
            raise ValueError("manifest outputDir is required")
        if status == "complete":
            output_dir = Path(manifest["outputDir"])
            complete = len(manifest.get("items", [])) == target_count and all(
                item.get("status") == "verified"
                and (output_dir / f"{item['id']}.mp4").is_file()
                and not (output_dir / f"{item['id']}.mp4").is_symlink()
                and (workspace / "work/production" / item["id"] / "manifest.json").is_file()
                and not (workspace / "work/production" / item["id"] / "manifest.json").is_symlink()
                for item in manifest.get("items", [])
            )
            if complete:
                return {"selected": target_count, "rendered": 0, "verified": target_count,
                        "outDir": manifest["outputDir"]}
            status = "rendering"
        if mode == "single":
            allowed = {"sealed", "rendering"}
        elif mode == "batch":
            allowed = {"sample_approved", "rendering"}
        else:
            allowed = {None, "rendering", "sealed"}
        if status not in allowed:
            raise ValueError("batch sample approval is required before render")
        selected_items = [item for item in manifest["items"] if not item_id or item["id"] == item_id]
        selected_items = selected_items[:limit] if limit else selected_items
        if not selected_items:
            raise ValueError("batch contains no selected plans")
        if mode:
            manifest["batchStatus"] = "rendering"
        if mode is None and status is None and out_dir is not None:
            pending_items = [
                item for item in selected_items
                if not ((Path(manifest["outputDir"]) / f"{item['id']}.mp4").is_file()
                        and (workspace / "work/production" / item["id"] / "manifest.json").is_file())
            ]
            if pending_items:
                plans = [json.loads(_inside(workspace, batch_dir / item["planPath"], "plan").read_text(encoding="utf-8"))
                         for item in pending_items]
                voice = plans[0]["voice"]
                if any(plan["voice"] != voice for plan in plans):
                    raise ValueError("one render batch must use one voice contract")
                unique_tasks = list({
                    (sentence["ttsText"], voice["durationFactor"]): {
                        "text": sentence["ttsText"], "duration_factor": voice["durationFactor"]
                    }
                    for plan in plans for sentence in plan["sentences"]
                }.values())
                prewarm = batch_dir / "tts-prewarm.jsonl"
                _atomic_text(prewarm, "".join(json.dumps(task, ensure_ascii=False) + "\n" for task in unique_tasks))
                cache_dir = workspace / "work/indextts25/cache"
                cache_dir.mkdir(parents=True, exist_ok=True)
                subprocess.run([
                    str(index_python), str(workspace / "scripts/indextts25-batch.py"), "--batch-file", str(prewarm),
                    "--voice", str(_inside(workspace, workspace / voice["promptPath"], "voice")),
                    "--model-dir", str(model_dir), "--output-dir", str(cache_dir),
                    "--expected-count", str(len(unique_tasks)), "--output-prefix", "sentence",
                    "--manifest", str(batch_dir / "tts-prewarm-manifest.json"), "--device", device,
                ], cwd=workspace, check=True)
        _atomic_json(manifest_path, manifest)
        result = _render_items(
            manifest=manifest, manifest_path=manifest_path, workspace=workspace,
            model_dir=model_dir, index_python=index_python,
            item_ids=[item["id"] for item in selected_items], jobs=jobs,
        )
        verified = sum(item.get("status") == "verified" for item in manifest["items"])
        if mode and verified == target_count:
            manifest["batchStatus"] = "complete"
            manifest["completedAt"] = datetime.now().astimezone().isoformat()
        _atomic_json(manifest_path, manifest)
        if result["failures"]:
            raise RuntimeError(f"{len(result['failures'])} render(s) failed: {', '.join(result['failures'][:10])}")
        return {"selected": len(selected_items), "rendered": result["rendered"], "verified": verified,
                "outDir": manifest["outputDir"]}


def _add_runtime(parser, *, jobs=False):
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--python", dest="index_python", type=Path, default=DEFAULT_PYTHON)
    if jobs:
        parser.add_argument("--jobs", type=int, default=1)


def parse_args(argv=None):
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments[:1] == ["plan"]:
        legacy = argparse.ArgumentParser(description="Legacy S5Max batch planner")
        legacy.add_argument("--date", required=True)
        legacy.add_argument("--copy-csv", required=True, type=Path)
        legacy.add_argument("--materials", type=Path, default=DEFAULT_MATERIALS)
        legacy.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
        legacy.add_argument("--voice", type=Path, default=DEFAULT_VOICE)
        legacy.add_argument("--work-dir", type=Path)
        legacy.add_argument("--count", type=int, default=300)
        parsed = legacy.parse_args(arguments[1:])
        parsed.command = "plan"
        return parsed

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
    # Keep old render callers working without making those controls part of the
    # six-command user-facing contract.
    render.add_argument("--out-dir", type=Path, help=argparse.SUPPRESS)
    render.add_argument("--limit", type=int, help=argparse.SUPPRESS)
    render.add_argument("--id", dest="item_id", help=argparse.SUPPRESS)
    render.add_argument("--device", choices=("mps", "cpu"), default="mps", help=argparse.SUPPRESS)

    return parser.parse_args(arguments)


def main(argv=None):
    args = parse_args(argv)
    if args.command == "capacity":
        workspace = args.workspace.resolve()
        result = capacity_report(
            workspace=workspace, target_count=args.count, jobs=args.jobs,
            batch_id="capacity", seed=_sha(args.copy_csv.read_text(encoding="utf-8-sig")),
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
    elif args.command == "plan":
        if args.count != 300:
            raise ValueError("daily production count must be exactly 300")
        batch = plan_batch(batch_id=args.date, seed=args.date, copy_csv=args.copy_csv, materials_path=args.materials,
                           catalog_path=args.catalog, voice_path=args.voice, count=args.count)
        _validate_catalog(batch, args.catalog)
        batch_dir = args.work_dir or Path("work/s5max-daily") / args.date
        manifest = write_batch(batch, batch_dir, args.copy_csv)
        result = {"targetCount": batch["targetCount"], "inputHash": batch["inputHash"], "manifest": str(manifest)}
    else:
        if args.out_dir is None and args.limit is None and args.item_id is None and args.device == "mps":
            result = render_batch(
                manifest_path=args.manifest, workspace=args.workspace, model_dir=args.model_dir,
                index_python=args.index_python, jobs=args.jobs,
            )
        else:
            result = render_batch(
                manifest_path=args.manifest, workspace=args.workspace, model_dir=args.model_dir,
                index_python=args.index_python, out_dir=args.out_dir, jobs=args.jobs, limit=args.limit,
                item_id=args.item_id, device=args.device,
            )
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
