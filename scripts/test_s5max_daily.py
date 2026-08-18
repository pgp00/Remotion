import csv
import importlib.util
import json
import tempfile
import unittest
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
                "assetId": f"{stem}-{index}", "category": category, "label": category,
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


class DailyPlanTest(unittest.TestCase):
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
            csv_path = root / "small-copy.csv"
            with csv_path.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(["category", "text"])
                writer.writerows((category, category) for category in ("hook", "cta", "shave", "blade", "power", "water"))
            clips = []
            for asset_id, category in (
                ("hook", "hook"), ("shave", "shave"), ("blade", "power"), ("power", "power"),
                ("water", "water"), ("charge", "charge"), ("appearance", "body"), ("scene", "body"),
                ("cta", "cta"),
            ):
                clips.append({
                    "assetId": asset_id, "category": category, "label": category,
                    "sourceInSeconds": 0, "sourceOutSeconds": 20,
                    "quickFingerprint": f"fp-{asset_id}",
                })
            assets_path = root / "materials.json"
            assets_path.write_text(json.dumps({"selection": {"clipLibrary": clips}}), encoding="utf-8")
            pools, _ = module.load_copy_pool(csv_path)
            active = tuple(category for category in module.SELLING if pools.get(category))
            signatures = set()
            for categories, candidates in module._exhaustive_copy_candidates(pools, active, "capacity-seed"):
                for selected in candidates:
                    signatures.add(module._sha("|".join(item["sentenceId"] for item in selected)))
            forbidden = {"copy": set(), "text": set(), "visual": set()}
            with patch.object(module, "FAST_ATTEMPTS", 0), self.assertRaises(module.CapacityError) as raised:
                module.plan_batch(batch_id="capacity", seed="capacity-seed", copy_csv=csv_path,
                                  materials_path=assets_path, catalog_path="catalog.json", voice_path="voice.wav",
                                  count=len(signatures) + 1, forbidden=forbidden)

        self.assertEqual(raised.exception.exact, len(signatures))
        self.assertEqual(raised.exception.missing[0]["kind"], "copy")

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
