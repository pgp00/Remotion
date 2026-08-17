#!/usr/bin/env python3
"""Tests for the S5Max IndexTTS2 pause-aware replacement pass."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = Path(__file__).with_name("s5max-indextts2-replace.py")


def load_module():
    if not SCRIPT_PATH.exists():
        raise AssertionError("implementation script is missing")
    spec = importlib.util.spec_from_file_location("s5max_indextts2_replace", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class S5MaxIndexTTS2ReplaceTests(unittest.TestCase):
    def test_parse_srt_returns_contiguous_cues(self):
        module = load_module()
        text = """1
00:00:00,000 --> 00:00:01,000
第一句。

2
00:00:01,000 --> 00:00:02,500
第二句。
"""
        self.assertEqual(
            module.parse_srt(text),
            [
                {"start": 0.0, "end": 1.0, "text": "第一句。"},
                {"start": 1.0, "end": 2.5, "text": "第二句。"},
            ],
        )

    def test_build_batch_maps_all_real_sentences(self):
        module = load_module()
        scripts = json.loads((ROOT / "work/s5max-30-unique/scripts.json").read_text(encoding="utf-8"))["scripts"]
        tasks, mappings = module.build_batch(scripts)
        self.assertEqual(len(tasks), 176)
        self.assertEqual(len(mappings), 176)
        self.assertEqual(mappings[0]["filename"], "segment-0001.wav")
        self.assertEqual(mappings[-1]["filename"], "segment-0176.wav")
        for script in scripts:
            texts = [mapping["text"] for mapping in mappings if mapping["id"] == script["id"]]
            self.assertEqual("".join(texts), script["ttsText"])

    def test_locate_completed_batch_uses_manifest_status(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            failed = root / ".s5smb-failed"
            complete = root / ".s5smb-complete"
            failed.mkdir()
            complete.mkdir()
            (failed / "manifest.json").write_text(json.dumps({"items": [{"id": "s5max-01", "status": "failed"}]}))
            (complete / "manifest.json").write_text(json.dumps({"items": [{"id": "s5max-01", "status": "complete"}]}))
            self.assertEqual(module.locate_completed_batch(root, "s5max-01"), complete)

    def test_build_filters_adds_six_five_frame_pauses(self):
        module = load_module()
        cues = [{"start": float(index), "end": float(index + 1), "text": str(index)} for index in range(7)]
        graph, final_duration = module.build_filters(cues, [1.0] * 7, source_duration=8.0)
        self.assertAlmostEqual(final_duration, 9.0)
        self.assertEqual(graph.count("tpad=stop_mode=clone:stop_duration=0.166667"), 6)
        self.assertIn("concat=n=8:v=1:a=0", graph)
        self.assertIn("concat=n=7:v=0:a=1", graph)
        self.assertIn("asplit=2[amp3][amp4]", graph)


if __name__ == "__main__":
    unittest.main()
