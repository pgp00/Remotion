import csv
import contextlib
import importlib.util
import io
import json
import threading
import tempfile
import unittest
import wave
from collections import Counter
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("s5max-daily.py")


def load_module():
    spec = importlib.util.spec_from_file_location("s5max_daily", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fixture(root: Path):
    csv_path = root / "copy-pool.csv"
    rows = []
    for category, count in {"hook": 8, "cta": 8, "shave": 5, "blade": 5, "power": 5, "water": 5, "charge": 5, "appearance": 5, "scene": 5}.items():
        rows.extend((category, f"{category}文案{i}。") for i in range(count))
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["category", "text"])
        writer.writerows(rows)

    clips = []
    def add(category, stem, count, word=""):
        for index in range(count):
            clips.append({
                "assetId": f"{stem}-{index}", "clipId": f"{stem}-clip-{index}",
                "category": category, "label": category,
                "sourcePath": f"/source/{word}{stem}-{index}.mp4", "sourceInSeconds": 0,
                "sourceOutSeconds": 8, "quickFingerprint": f"fp-{stem}-{index}",
            })
    add("hook", "hook", 6)
    add("shave", "shave", 8, "剃一道车上")
    add("body", "body", 7, "机身出差")
    add("power", "blade", 6, "刀网按压")
    add("power", "motor", 6, "转子马达")
    add("water", "water", 5)
    add("charge", "charge", 5)
    add("cta", "cta", 6, "礼盒赠品")
    assets_path = root / "materials.json"
    assets_path.write_text(json.dumps({"selection": {"clipLibrary": clips}}, ensure_ascii=False), encoding="utf-8")
    return csv_path, assets_path


def write_wav(path: Path, seconds=1.0):
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = int(22050 * seconds)
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, 22050, frames, "NONE", "not compressed"))
        output.writeframes(b"\0\0" * frames)


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


class DailyPlanTest(unittest.TestCase):
    def test_complete_state_resumes_when_verified_files_are_missing(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = make_prepared_manifest(root, mode="single", count=1)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["batchStatus"] = "complete"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
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

            with patch.object(module, "_run_producer", side_effect=fake_producer):
                result = module.render_batch(
                    manifest_path=manifest_path, workspace=root, model_dir=root / "model",
                    index_python=root / "python", jobs=1,
                )

        self.assertEqual(calls, ["s5max-test-001"])
        self.assertEqual(result["rendered"], 1)

    def test_approval_requires_a_persisted_sample_output(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = make_prepared_manifest(root, mode="batch", count=1)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["batchStatus"] = "sample_pending"
            manifest["sampleId"] = manifest["items"][0]["id"]
            manifest["items"][0]["status"] = "verified"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "verified sample"):
                module.approve_sample(manifest_path=manifest_path)

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

    def test_builds_reproducible_balanced_unique_300(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            csv_path, assets_path = fixture(root)
            kwargs = dict(batch_id="batch-a", seed="seed-a", copy_csv=csv_path, materials_path=assets_path,
                          catalog_path="work/asset-library/catalog.json", voice_path="voice.wav", count=300)
            forbidden = {"copy": set(), "text": set(), "visual": set()}
            first = module.plan_batch(**kwargs, forbidden=forbidden)
            second = module.plan_batch(**kwargs, forbidden=forbidden)
            changed = module.plan_batch(**{**kwargs, "batch_id": "batch-b", "seed": "seed-b"}, forbidden=forbidden)

        self.assertEqual(first, second)
        self.assertNotEqual([x["copySignature"] for x in first["items"]],
                            [x["copySignature"] for x in changed["items"]])
        self.assertEqual(Counter(x["sellingPointCount"] for x in first["items"]), {2: 75, 3: 150, 4: 75})
        for key in ("copySignature", "textSignature", "visualSignature"):
            self.assertEqual(len({x[key] for x in first["items"]}), 300)
        previous_hook = None
        for item in first["items"]:
            categories = item["categories"]
            asset_ids = [slot["assetId"] for slot in item["visualSlots"]]
            fingerprints = [slot["quickFingerprint"] for slot in item["visualSlots"]]
            self.assertEqual(categories[0], "hook")
            self.assertEqual(categories[-1], "cta")
            self.assertEqual(len(categories[1:-1]), len(set(categories[1:-1])))
            self.assertEqual(len(asset_ids), len(set(asset_ids)))
            self.assertEqual(len(fingerprints), len(set(fingerprints)))
            self.assertNotEqual(asset_ids[0], previous_hook)
            previous_hook = asset_ids[0]

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
                workspace=root, batch_id="capacity-a", seed="seed-a", copy_csv=csv_path,
                materials_path=assets_path, catalog_path=str(catalog), voice_path=str(voice),
                target_count=300, forbidden={"copy": set(), "text": set(), "visual": set()},
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

    def test_prepare_checks_catalog_before_starting_tts(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            csv_path, assets_path = fixture(root)
            catalog = root / "catalog.json"
            catalog.write_text(json.dumps({"assets": []}), encoding="utf-8")
            source = root / "source-copy.txt"
            source.write_text("测试原始文案。", encoding="utf-8")
            voice = root / "voice.wav"
            write_wav(voice)
            model = root / "model"
            model.mkdir()
            (model / "config.yaml").write_text("model: test\n", encoding="utf-8")
            calls = []

            with patch.object(module.subprocess, "run", side_effect=lambda *args, **kwargs: calls.append(args)):
                with self.assertRaisesRegex(ValueError, "catalog is missing"):
                    module.prepare_batch(
                        workspace=root, mode="single", source_copy=source, copy_csv=csv_path,
                        materials_path=assets_path, catalog_path=catalog, voice_path=voice,
                        model_dir=model, index_python=root / "python", target_count=1,
                        batch_id="catalog-before-tts", seed="catalog-seed", device="cpu",
                    )

        self.assertEqual(calls, [])

    def test_prepare_serializes_same_batch_and_preserves_sealed_manifest(self):
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
            write_wav(voice)
            model = root / "model"
            model.mkdir()
            (model / "config.yaml").write_text("model: test\n", encoding="utf-8")
            first_entered = threading.Event()
            second_entered = threading.Event()
            release_first = threading.Event()
            calls = []
            errors = []

            def fake_run(command, **_kwargs):
                calls.append(command)
                if len(calls) == 1:
                    first_entered.set()
                    release_first.wait(2)
                else:
                    second_entered.set()
                manifest_path = Path(command[command.index("--manifest") + 1])
                batch_file = Path(command[command.index("--batch-file") + 1])
                items = []
                for line, task in enumerate(map(json.loads, batch_file.read_text(encoding="utf-8").splitlines()), 1):
                    wav_path = root / "work/indextts25/cache" / f"sentence-{line}.wav"
                    write_wav(wav_path, seconds=1.0)
                    items.append({"line": line, "text": task["text"], "outputPath": str(wav_path),
                                  "durationFactor": 1, "contentKey": f"{line:064x}",
                                  "sha256": module._sha_file(wav_path)})
                manifest_path.write_text(json.dumps({
                    "engine": "IndexTTS-2.5", "engineVersion": "v2.5.0",
                    "voiceSha256": module._sha_file(voice),
                    "modelConfigSha256": module._sha_file(model / "config.yaml"),
                    "items": items,
                }), encoding="utf-8")

            def prepare():
                try:
                    module.prepare_batch(
                        workspace=root, mode="single", source_copy=source, copy_csv=csv_path,
                        materials_path=assets_path, catalog_path=catalog, voice_path=voice,
                        model_dir=model, index_python=root / "python", target_count=1,
                        batch_id="same-batch", seed="same-seed", device="cpu",
                    )
                except Exception as error:
                    errors.append(error)

            with patch.object(module.subprocess, "run", side_effect=fake_run):
                first = threading.Thread(target=prepare)
                first.start()
                self.assertTrue(first_entered.wait(2))
                second = threading.Thread(target=prepare)
                second.start()
                try:
                    self.assertFalse(second_entered.wait(0.2))
                finally:
                    release_first.set()
                first.join(3)
                second.join(3)

            self.assertFalse(first.is_alive() or second.is_alive())
            self.assertEqual(len(calls), 1)
            self.assertTrue(any("sealed" in str(error) for error in errors))

    def test_rejects_bad_copy_pool_before_planning(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, assets_path = fixture(root)
            bad = root / "bad.csv"
            bad.write_text("category,text\nhook,同一句\nblade,同一句\ncta,收尾\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicate"):
                module.plan_batch(batch_id="batch-a", seed="seed-a", copy_csv=bad, materials_path=assets_path,
                                  catalog_path="catalog.json", voice_path="voice.wav", count=1,
                                  forbidden={"copy": set(), "text": set(), "visual": set()})

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

    def test_rejects_explicit_empty_forbidden_structure(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            csv_path, assets_path = fixture(root)
            with self.assertRaisesRegex(ValueError, "forbidden"):
                module.plan_batch(batch_id="bad-forbidden", seed="seed", copy_csv=csv_path,
                                  materials_path=assets_path, catalog_path="catalog.json", voice_path="voice.wav",
                                  count=1, forbidden={})

    def test_text_signature_forbidden_is_respected(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            csv_path, assets_path = fixture(root)
            common = dict(batch_id="text-a", seed="text-seed", copy_csv=csv_path, materials_path=assets_path,
                          catalog_path="catalog.json", voice_path="voice.wav", count=1)
            empty = {"copy": set(), "text": set(), "visual": set()}
            first = module.plan_batch(**common, forbidden=empty)
            blocked = {"copy": set(), "text": {first["items"][0]["textSignature"]}, "visual": set()}
            next_batch = module.plan_batch(**{**common, "batch_id": "text-b"}, forbidden=blocked)

        self.assertNotEqual(first["items"][0]["textSignature"], next_batch["items"][0]["textSignature"])

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

    def test_reserve_rejects_duplicate_signatures_within_candidate_manifest(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "work/production-batches/duplicate/manifest.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({
                "schemaVersion": 2, "batchStatus": "audio_ready",
                "items": [
                    {"id": "duplicate-001", "copySignature": "same-copy", "textSignature": "same-text", "visualSignature": "same-visual"},
                    {"id": "duplicate-002", "copySignature": "same-copy", "textSignature": "same-text", "visualSignature": "same-visual"},
                ],
            }), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "manifest duplicate"):
                module.reserve_batch(root, path)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["batchStatus"], "audio_ready")

    def test_reserve_and_archive_enforce_batch_state_transitions(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "work/production-batches/states/manifest.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({
                "schemaVersion": 2, "batchStatus": "audio_ready",
                "items": [{"id": "states-001", "copySignature": "copy", "textSignature": "text", "visualSignature": "visual"}],
            }), encoding="utf-8")

            sealed = module.reserve_batch(root, path)
            sealed_at = sealed["sealedAt"]
            with self.assertRaisesRegex(ValueError, "sealed"):
                module.reserve_batch(root, path)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["sealedAt"], sealed_at)

            module.archive_batch(root, path, "rejected")
            with self.assertRaisesRegex(ValueError, "archived"):
                module.reserve_batch(root, path)

            complete = root / "work/production-batches/complete-state/manifest.json"
            complete.parent.mkdir(parents=True)
            complete.write_text(json.dumps({
                "schemaVersion": 2, "batchStatus": "complete", "sealedAt": "fixed", "items": [],
            }), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "completed"):
                module.reserve_batch(root, complete)
            with self.assertRaisesRegex(ValueError, "completed"):
                module.archive_batch(root, complete, "too late")

            invalid = root / "work/production-batches/invalid/manifest.json"
            invalid.parent.mkdir(parents=True)
            invalid.write_text(json.dumps({"schemaVersion": 2, "batchStatus": "draft", "items": []}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "draft"):
                module.archive_batch(root, invalid, "not ready")

    def test_archive_rejects_rendering_verified_output_and_preserves_history(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "out/production-batches/rendering/rendering-001.mp4"
            output.parent.mkdir(parents=True)
            output.write_bytes(b"verified")
            core = root / "work/production/rendering-001/manifest.json"
            core.parent.mkdir(parents=True)
            core.write_text(json.dumps({"output": {"path": str(output)}}), encoding="utf-8")
            path = root / "work/production-batches/rendering/manifest.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({
                "schemaVersion": 2, "batchStatus": "rendering",
                "items": [{"id": "rendering-001", "status": "verified", "outputPath": str(output),
                           "copySignature": "copy-rendering", "textSignature": "text-rendering",
                           "visualSignature": "visual-rendering"}],
            }), encoding="utf-8")
            before = module.history_signatures(root)

            with self.assertRaisesRegex(ValueError, "rendering"):
                module.archive_batch(root, path, "cancel")

            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["batchStatus"], "rendering")
            self.assertEqual(module.history_signatures(root), before)

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

    def test_archive_batch_releases_reservation_and_rejects_completed_batch(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archived = root / "work/production-batches/archived/manifest.json"
            archived.parent.mkdir(parents=True)
            archived.write_text(json.dumps({
                "schemaVersion": 2, "batchStatus": "sealed",
                "items": [{"id": "archived-001", "copySignature": "copy", "textSignature": "text",
                           "visualSignature": "visual"}],
            }), encoding="utf-8")
            result = module.archive_batch(root, archived, "sample rejected")

            self.assertEqual(result["batchStatus"], "archived")
            self.assertEqual(result["archiveReason"], "sample rejected")
            self.assertNotIn("copy", module.history_signatures(root)["copy"])
            with self.assertRaisesRegex(ValueError, "non-empty"):
                module.archive_batch(root, archived, "  ")

            complete = root / "work/production-batches/complete/manifest.json"
            complete.parent.mkdir(parents=True)
            complete.write_text(json.dumps({"schemaVersion": 2, "batchStatus": "complete", "items": []}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "completed"):
                module.archive_batch(root, complete, "too late")

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

    def test_capacity_error_exact_matches_exhaustive_copy_signatures(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            csv_path, assets_path = fixture(root)
            seed = "capacity-seed"
            categories = tuple(module.SELLING[:3])

            def sentence(label, category):
                return {"sentenceId": f"{label}-{category}", "sourceText": f"{label}-{category}",
                        "normalizedText": f"{label}-{category}。"}

            candidates = [
                (categories, tuple([sentence("A", "hook"), *(sentence("A", category) for category in categories),
                                    sentence("A", "cta")])),
            ]
            clips = {
                asset_id: {"assetId": asset_id, "quickFingerprint": f"fp-{asset_id}",
                           "sourceInSeconds": 0, "sourceOutSeconds": 8}
                for asset_id in ("x",)
            }

            def copy_candidates(_pools, _active, _seed):
                yield from candidates

            def visual_candidates(item, _visual_pools, _seed, _audio_durations):
                yield tuple(clips["x"] for _ in item["categories"])

            forbidden = {"copy": set(), "text": set(), "visual": set()}
            with patch.object(module, "FAST_ATTEMPTS", 0), self.assertRaises(module.CapacityError) as raised:
                with patch.object(module, "_iter_exhaustive_copy_candidates", side_effect=copy_candidates), \
                        patch.object(module, "_exhaustive_visual_candidates", side_effect=visual_candidates), \
                        patch.object(module, "_material_missing", return_value=[]):
                    module.plan_batch(batch_id="capacity", seed=seed, copy_csv=csv_path,
                                  materials_path=assets_path, catalog_path="catalog.json", voice_path="voice.wav",
                                  count=2, forbidden=forbidden)

        self.assertEqual(raised.exception.exact, 1)
        self.assertEqual(raised.exception.missing[0]["kind"], "copy")

    def test_exhaustive_copy_fallback_skips_visually_impossible_copy(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            csv_path, assets_path = fixture(root)
            pools, _ = module.load_copy_pool(csv_path)
            active = tuple(category for category in module.SELLING if pools.get(category))
            _, first_candidate = next(module._iter_exhaustive_copy_candidates(pools, active, "joint-seed"))
            impossible = first_candidate[1]
            audio_durations = {
                module._tts_text(sentence["normalizedText"]): 1
                for sentences in pools.values() for sentence in sentences
            }
            audio_durations[module._tts_text(impossible["normalizedText"])] = 99
            with patch.object(module, "FAST_ATTEMPTS", 0):
                batch = module.plan_batch(
                    batch_id="joint", seed="joint-seed", copy_csv=csv_path, materials_path=assets_path,
                    catalog_path="catalog.json", voice_path="voice.wav", count=1,
                    forbidden={"copy": set(), "text": set(), "visual": set()},
                    audio_durations=audio_durations,
                )

        self.assertEqual(len(batch["items"]), 1)
        self.assertNotIn(impossible["sentenceId"], batch["items"][0]["sourceSentenceIds"])

    def test_exhaustive_fallback_preserves_selling_counts_by_position(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            csv_path, assets_path = fixture(root)
            count, seed = 3, "distribution-seed"
            expected = module._selling_counts(count, seed)
            with patch.object(module, "FAST_ATTEMPTS", 0):
                batch = module.plan_batch(
                    batch_id="distribution", seed=seed, copy_csv=csv_path, materials_path=assets_path,
                    catalog_path="catalog.json", voice_path="voice.wav", count=count,
                    forbidden={"copy": set(), "text": set(), "visual": set()},
                )

        self.assertEqual([item["sellingPointCount"] for item in batch["items"]], expected)

    def test_joint_fallback_backtracks_hall_visual_assignments(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            csv_path, assets_path = fixture(root)
            seed = "hall-1"
            self.assertEqual(module._selling_counts(3, seed), [4, 4, 3])

            def sentence(label, category):
                return {"sentenceId": f"{label}-{category}", "sourceText": f"{label}-{category}",
                        "normalizedText": f"{label}-{category}。"}

            categories_a = tuple(module.SELLING[:4])
            categories_b = tuple(module.SELLING[:4])
            categories_c = tuple(module.SELLING[:3])
            candidates = [
                (categories_a, tuple([sentence("A", "hook"), *(sentence("A", category) for category in categories_a),
                                      sentence("A", "cta")])),
                (categories_b, tuple([sentence("B", "hook"), *(sentence("B", category) for category in categories_b),
                                      sentence("B", "cta")])),
                (categories_c, tuple([sentence("C", "hook"), *(sentence("C", category) for category in categories_c),
                                      sentence("C", "cta")])),
            ]
            clips = {
                asset_id: {"assetId": asset_id, "quickFingerprint": f"fp-{asset_id}",
                           "sourceInSeconds": 0, "sourceOutSeconds": 8}
                for asset_id in ("x", "y", "z")
            }

            def copy_candidates(_pools, _active, _seed):
                yield from candidates

            def visual_candidates(item, _visual_pools, _seed, _audio_durations):
                label = item["sourceSentenceIds"][0].split("-", 1)[0]
                choices = {"A": ("x", "y"), "B": ("x",), "C": ("z",)}[label]
                for asset_id in choices:
                    yield tuple(clips[asset_id] for _ in item["categories"])

            with patch.object(module, "FAST_ATTEMPTS", 0), \
                    patch.object(module, "_iter_exhaustive_copy_candidates", side_effect=copy_candidates), \
                    patch.object(module, "_exhaustive_visual_candidates", side_effect=visual_candidates), \
                    patch.object(module, "_material_missing", return_value=[]):
                batch = module.plan_batch(
                    batch_id="hall", seed=seed, copy_csv=csv_path, materials_path=assets_path,
                    catalog_path="catalog.json", voice_path="voice.wav", count=3,
                    forbidden={"copy": set(), "text": set(), "visual": set()},
                )

        self.assertEqual(len(batch["items"]), 3)
        self.assertEqual([item["visualSlots"][0]["assetId"] for item in batch["items"]], ["y", "x", "z"])

    def test_joint_fallback_expands_prior_group_after_later_conflict(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            csv_path, assets_path = fixture(root)
            seed = "cross-group"

            def sentence(label, category):
                return {"sentenceId": f"{label}-{category}", "sourceText": f"{label}-{category}",
                        "normalizedText": f"{label}-{category}。"}

            candidates = [
                (tuple(module.SELLING[:2]), tuple([sentence("A1", "hook"),
                                                   *(sentence("A1", category) for category in module.SELLING[:2]),
                                                   sentence("A1", "cta")])),
                (tuple(module.SELLING[:2]), tuple([sentence("A2", "hook"),
                                                   *(sentence("A2", category) for category in module.SELLING[:2]),
                                                   sentence("A2", "cta")])),
                (tuple(module.SELLING[:3]), tuple([sentence("B", "hook"),
                                                   *(sentence("B", category) for category in module.SELLING[:3]),
                                                   sentence("B", "cta")])),
            ]
            clips = {
                asset_id: {"assetId": asset_id, "quickFingerprint": f"fp-{asset_id}",
                           "sourceInSeconds": 0, "sourceOutSeconds": 8}
                for asset_id in ("x", "y")
            }

            def copy_candidates(_pools, _active, _seed):
                yield from candidates

            def visual_candidates(item, _visual_pools, _seed, _audio_durations):
                label = item["sourceSentenceIds"][0].split("-", 1)[0]
                asset_id = {"A1": "x", "A2": "y", "B": "x"}[label]
                yield tuple(clips[asset_id] for _ in item["categories"])

            def visual_signature(candidate):
                return candidate[0] if isinstance(candidate[0], str) else candidate[0]["assetId"]

            with patch.object(module, "FAST_ATTEMPTS", 0), \
                    patch.object(module, "_selling_counts", return_value=[2, 3]), \
                    patch.object(module, "_iter_exhaustive_copy_candidates", side_effect=copy_candidates), \
                    patch.object(module, "_exhaustive_visual_candidates", side_effect=visual_candidates), \
                    patch.object(module, "_material_missing", return_value=[]), \
                    patch.object(module, "_visual_signature", side_effect=visual_signature, create=True):
                batch = module.plan_batch(
                    batch_id="cross", seed=seed, copy_csv=csv_path, materials_path=assets_path,
                    catalog_path="catalog.json", voice_path="voice.wav", count=2,
                    forbidden={"copy": set(), "text": set(), "visual": set()},
                )

        self.assertEqual([item["sellingPointCount"] for item in batch["items"]], [2, 3])
        self.assertEqual([item["visualSlots"][0]["assetId"] for item in batch["items"]], ["y", "x"])

    def test_scripts_json_persists_source_sentences(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            csv_path, assets_path = fixture(root)
            batch = module.plan_batch(batch_id="persist", seed="persist-seed", copy_csv=csv_path,
                                      materials_path=assets_path, catalog_path="catalog.json", voice_path="voice.wav",
                                      count=1, forbidden={"copy": set(), "text": set(), "visual": set()})
            module.write_batch(batch, root / "batch", csv_path)
            scripts = json.loads((root / "batch/scripts.json").read_text(encoding="utf-8"))

        self.assertEqual(scripts["items"][0]["sourceSentences"], batch["items"][0]["sourceSentences"])

    def test_legacy_plan_cli_uses_new_batch_arguments(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            csv_path, assets_path = fixture(root)
            output = io.StringIO()
            with patch.object(module, "_validate_catalog"), patch.object(module, "write_batch",
                                                                         return_value=root / "manifest.json"):
                with contextlib.redirect_stdout(output):
                    module.main([
                        "plan", "--date", "2026-08-18", "--copy-csv", str(csv_path),
                        "--materials", str(assets_path), "--catalog", str(root / "catalog.json"),
                        "--voice", "voice.wav", "--count", "300",
                    ])

        payload = json.loads(output.getvalue())
        self.assertEqual(payload["targetCount"], 300)

    def test_render_resumes_completed_items_without_relaunching(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            csv_path, assets_path = fixture(root)
            (root / "voice.wav").write_bytes(b"voice")
            batch = module.plan_batch(batch_id="batch-a", seed="seed-a", copy_csv=csv_path, materials_path=assets_path,
                                      catalog_path="catalog.json", voice_path="voice.wav", count=4,
                                      forbidden={"copy": set(), "text": set(), "visual": set()})
            manifest = module.write_batch(batch, root / "work/s5max-daily/batch-a", csv_path)
            calls = []

            def fake_run(command, **_kwargs):
                calls.append(command)
                if command[0] == "node":
                    plan = json.loads(Path(command[command.index("--plan") + 1]).read_text(encoding="utf-8"))
                    out = Path(command[command.index("--out-dir") + 1])
                    out.mkdir(parents=True, exist_ok=True)
                    (out / f"{plan['id']}.mp4").write_bytes(b"video")
                    production = root / "work/production" / plan["id"]
                    production.mkdir(parents=True, exist_ok=True)
                    (production / "manifest.json").write_text("{}", encoding="utf-8")

            with patch.object(module.subprocess, "run", side_effect=fake_run):
                result = module.render_batch(manifest_path=manifest, workspace=root, model_dir=root / "model",
                                             index_python=root / "python", out_dir=root / "out", jobs=2, limit=2,
                                             device="cpu")
                self.assertEqual(result["rendered"], 2)
                self.assertEqual(len(calls), 3)
                self.assertEqual(calls[0][-2:], ["--device", "cpu"])
                calls.clear()
                result = module.render_batch(manifest_path=manifest, workspace=root, model_dir=root / "model",
                                             index_python=root / "python", out_dir=root / "out", jobs=2, limit=2)
                self.assertEqual(result["rendered"], 0)
                self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
