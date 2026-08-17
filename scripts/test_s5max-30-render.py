#!/usr/bin/env python3
"""Contract and command-plan tests for s5max-30-render.py."""

import importlib.util
import itertools
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("s5max-30-render.py")
SPEC = importlib.util.spec_from_file_location("s5max_render", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def contract_pair(root: Path):
    clips = []
    for index in range(6):
        path = root / f"clip-{index}.mp4"
        path.touch()
        clips.append({"path": str(path), "sourceInSeconds": 0, "sourceOutSeconds": 1})
    orders = list(itertools.islice(itertools.permutations(range(6)), 30))
    material = {
        "schemaVersion": 1,
        "videos": [
            {"id": f"s5max-{index + 1:02d}", "clips": [clips[position] for position in orders[index]]}
            for index in range(30)
        ],
    }
    scripts = {
        "schemaVersion": 1,
        "scripts": [
            {
                "id": f"s5max-{index + 1:02d}",
                "sentences": [
                    f"第{index + 1}条，S5Max动力出色。",
                    "全机防水，清洁方便。",
                    "现在就了解S5Max。",
                    f"编号{index + 1}专属推荐。",
                ],
                "ttsText": f"第{index + 1}条，S5Max动力出色。全机防水，清洁方便。现在就了解S5Max。编号{index + 1}专属推荐。",
                "subtitleText": f"第{index + 1}条，S5Max动力出色。全机防水，清洁方便。现在就了解S5Max。编号{index + 1}专属推荐。",
            }
            for index in range(30)
        ],
    }
    return material, scripts


class S5MaxRenderTests(unittest.TestCase):
    def test_contracts_have_thirty_unique_scripts_and_shot_orders(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            material, scripts = contract_pair(root)
            validated = MODULE.validate_contracts(
                material,
                scripts,
                allowed_roots=[root],
                require_existing_paths=True,
            )
            self.assertEqual(validated["count"], 30)
            self.assertEqual(len(validated["scriptHashes"]), 30)
            self.assertEqual(len(validated["shotOrderHashes"]), 30)

    def test_rejects_unsafe_material_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            material, scripts = contract_pair(root)
            material["videos"][0]["clips"][0]["path"] = "/tmp/not-approved.mp4"
            with self.assertRaises(ValueError, msg="path outside approved roots must fail"):
                MODULE.validate_contracts(material, scripts, allowed_roots=[root])

    def test_rejects_overlapping_source_ranges(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            material, scripts = contract_pair(root)
            material["videos"][0]["clips"][1]["path"] = material["videos"][0]["clips"][0]["path"]
            material["videos"][0]["clips"][1]["sourceInSeconds"] = 0.5
            with self.assertRaises(ValueError, msg="overlapping ranges must fail"):
                MODULE.validate_contracts(material, scripts, allowed_roots=[root])

    def test_render_plan_contains_release_video_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            material, scripts = contract_pair(root)
            MODULE.validate_contracts(material, scripts, allowed_roots=[root])
            plan = MODULE.build_render_plan(
                material["videos"][0],
                scripts["scripts"][0],
                root / "out",
                voice_name="Tingting",
            )
            command = " ".join(plan["ffmpegCommand"])
            self.assertIn("1080:1920", command)
            self.assertIn("fps=30", command)
            self.assertIn("setsar=1", command)
            self.assertIn("libx264", command)
            self.assertIn("yuv420p", command)
            self.assertIn("-r 30", command)
            self.assertIn("-c:a aac", command)
            self.assertTrue(str(plan["outputPath"]).endswith("s5max-01.mp4"))

    def test_dry_run_manifest_never_marks_item_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            material, scripts = contract_pair(root)
            material_path = root / "material.json"
            scripts_path = root / "scripts.json"
            material_path.write_text(json.dumps(material), encoding="utf-8")
            scripts_path.write_text(json.dumps(scripts), encoding="utf-8")
            manifest_path = root / "manifest.json"
            result = MODULE.run(
                material_path=material_path,
                scripts_path=scripts_path,
                output_dir=root / "out",
                manifest_path=manifest_path,
                mode="dry-run",
                allowed_roots=[root],
            )
            self.assertEqual(result["summary"]["planned"], 30)
            self.assertEqual(result["summary"]["completed"], 0)
            self.assertTrue(all(item["status"] == "planned" for item in result["items"]))


if __name__ == "__main__":
    unittest.main()
