#!/usr/bin/env python3
"""Tests for the minimal IndexTTS 2.5 batch worker."""

import importlib.util
import json
import tempfile
import unittest
import wave
from unittest import mock
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("indextts25-batch.py")


def load_module():
    if not SCRIPT_PATH.exists():
        raise AssertionError("implementation script is missing")
    spec = importlib.util.spec_from_file_location("indextts25_batch", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def write_wav(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, 22050, 2205, "NONE", "not compressed"))
        output.writeframes(b"\0\0" * 2205)


class FakeTts:
    instances = []

    def __init__(self, **kwargs):
        self.options = kwargs
        self.calls = []
        self.instances.append(self)

    def infer(self, **kwargs):
        self.calls.append(kwargs)
        write_wav(Path(kwargs["output_path"]))


class IndexTts25BatchTests(unittest.TestCase):
    def test_rejects_url_inputs_before_filesystem_access(self):
        module = load_module()
        with self.assertRaises(Exception) as caught:
            module.run_batch(
                batch_file="https://example.com/batch.jsonl",
                voice="voice.wav",
                model_dir="checkpoints",
                output_dir="out",
                expected_count=1,
            )
        self.assertIsInstance(caught.exception, ValueError)
        self.assertRegex(str(caught.exception), "local filesystem path")

    def test_missing_package_reports_local_install_requirement(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            batch = root / "batch.jsonl"
            batch.write_text('{"text":"local"}\n', encoding="utf-8")
            voice = root / "voice.wav"
            write_wav(voice)
            model_dir = root / "checkpoints"
            model_dir.mkdir()
            (model_dir / "config.yaml").touch()
            real_import = __import__

            def import_without_indextts(name, *args, **kwargs):
                if name.startswith("indextts"):
                    raise ModuleNotFoundError(name)
                return real_import(name, *args, **kwargs)

            with mock.patch("builtins.__import__", side_effect=import_without_indextts):
                with self.assertRaises(Exception) as caught:
                    module.run_batch(
                        batch_file=batch,
                        voice=voice,
                        model_dir=model_dir,
                        output_dir=root / "out",
                        expected_count=1,
                    )
            self.assertIsInstance(caught.exception, RuntimeError)
            self.assertRegex(str(caught.exception), "Local IndexTTS 2.5 is not installed")

    def test_batch_loads_model_once_and_uses_v25_arguments(self):
        module = load_module()
        FakeTts.instances.clear()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            batch = root / "batch.jsonl"
            batch.write_text('{"text":"第一句。"}\n{"text":"第二句。","duration_factor":1.1}\n', encoding="utf-8")
            voice = root / "voice.wav"
            write_wav(voice)
            model_dir = root / "checkpoints"
            model_dir.mkdir()
            (model_dir / "config.yaml").write_text("model: test\n", encoding="utf-8")

            manifest = module.run_batch(
                batch_file=batch,
                voice=voice,
                model_dir=model_dir,
                output_dir=root / "out",
                expected_count=2,
                tts_factory=FakeTts,
            )

            self.assertEqual(len(FakeTts.instances), 1)
            instance = FakeTts.instances[0]
            self.assertEqual(instance.options["device"], "mps")
            self.assertFalse(instance.options["use_bf16"])
            self.assertEqual([call["lang"] for call in instance.calls], ["ZH", "ZH"])
            self.assertEqual([call["duration_factor"] for call in instance.calls], [1.0, 1.1])
            self.assertTrue(all(Path(call["output_path"]).name.startswith(".segment-") for call in instance.calls))
            self.assertTrue(all(Path(call["output_path"]).name.endswith(".partial.wav") for call in instance.calls))
            self.assertEqual(manifest["summary"], {"completed": 2, "generated": 2, "cached": 0})

    def test_expected_count_rejects_an_incomplete_batch_before_model_load(self):
        module = load_module()
        FakeTts.instances.clear()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            batch = root / "batch.jsonl"
            batch.write_text('{"text":"only one"}\n', encoding="utf-8")
            voice = root / "voice.wav"
            write_wav(voice)
            model_dir = root / "checkpoints"
            model_dir.mkdir()
            (model_dir / "config.yaml").touch()
            with self.assertRaisesRegex(ValueError, "expected 2 tasks"):
                module.run_batch(batch_file=batch, voice=voice, model_dir=model_dir, output_dir=root / "out", expected_count=2, tts_factory=FakeTts)
            self.assertEqual(FakeTts.instances, [])

    def test_valid_outputs_resume_without_loading_the_model(self):
        module = load_module()
        FakeTts.instances.clear()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            batch = root / "batch.jsonl"
            batch.write_text('{"text":"cached"}\n', encoding="utf-8")
            voice = root / "voice.wav"
            write_wav(voice)
            model_dir = root / "checkpoints"
            model_dir.mkdir()
            (model_dir / "config.yaml").touch()
            module.run_batch(batch_file=batch, voice=voice, model_dir=model_dir, output_dir=root / "out", expected_count=1, tts_factory=FakeTts)
            FakeTts.instances.clear()
            manifest = module.run_batch(batch_file=batch, voice=voice, model_dir=model_dir, output_dir=root / "out", expected_count=1, tts_factory=FakeTts)
            self.assertEqual(FakeTts.instances, [])
            self.assertEqual(manifest["summary"], {"completed": 1, "generated": 0, "cached": 1})

    def test_content_key_covers_engine_language_model_voice_text_and_duration(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            batch = root / "batch.jsonl"
            batch.write_text('{"text":"first"}\n', encoding="utf-8")
            voice = root / "voice.wav"
            write_wav(voice)
            model_dir = root / "checkpoints"
            model_dir.mkdir()
            config = model_dir / "config.yaml"
            config.write_text("model: one\n", encoding="utf-8")

            def key(**overrides):
                manifest = module.run_batch(
                    batch_file=batch,
                    voice=voice,
                    model_dir=model_dir,
                    output_dir=root / overrides.pop("output", "out"),
                    expected_count=1,
                    tts_factory=FakeTts,
                    **overrides,
                )
                self.assertIn("contentKey", manifest["items"][0])
                return manifest["items"][0]["contentKey"]

            baseline = key()
            module.ENGINE_VERSION = "changed-engine"
            self.assertNotEqual(key(output="engine"), baseline)
            module.ENGINE_VERSION = "v2.5.0"
            self.assertNotEqual(key(output="language", lang="EN"), baseline)
            config.write_text("model: two\n", encoding="utf-8")
            self.assertNotEqual(key(output="model"), baseline)
            config.write_text("model: one\n", encoding="utf-8")
            write_wav(voice)
            with voice.open("ab") as handle:
                handle.write(b"voice-change")
            self.assertNotEqual(key(output="voice"), baseline)
            batch.write_text('{"text":"second"}\n', encoding="utf-8")
            self.assertNotEqual(key(output="text"), baseline)
            batch.write_text('{"text":"first","duration_factor":1.1}\n', encoding="utf-8")
            self.assertNotEqual(key(output="duration"), baseline)

    def test_changed_sentence_regenerates_only_that_sentence_and_manifest_is_complete(self):
        module = load_module()
        FakeTts.instances.clear()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            batch = root / "batch.jsonl"
            batch.write_text('{"text":"first"}\n{"text":"second","duration_factor":1.1}\n', encoding="utf-8")
            voice = root / "voice.wav"
            write_wav(voice)
            model_dir = root / "checkpoints"
            model_dir.mkdir()
            (model_dir / "config.yaml").touch()
            first = module.run_batch(batch_file=batch, voice=voice, model_dir=model_dir, output_dir=root / "out", expected_count=2, tts_factory=FakeTts)
            batch.write_text('{"text":"changed"}\n{"text":"second","duration_factor":1.1}\n', encoding="utf-8")
            FakeTts.instances.clear()

            manifest = module.run_batch(batch_file=batch, voice=voice, model_dir=model_dir, output_dir=root / "out", expected_count=2, tts_factory=FakeTts)

            self.assertEqual(len(FakeTts.instances), 1)
            self.assertEqual(FakeTts.instances[0].calls[0]["text"], "changed")
            self.assertEqual(manifest["summary"], {"completed": 2, "generated": 1, "cached": 1})
            self.assertNotEqual(manifest["items"][0]["outputPath"], first["items"][0]["outputPath"])
            self.assertEqual(manifest["items"][1]["outputPath"], first["items"][1]["outputPath"])
            self.assertEqual(
                set(manifest["items"][0]),
                {"line", "text", "durationFactor", "contentKey", "outputPath", "sha256", "status"},
            )

    def test_reordering_sentences_reuses_content_addressed_outputs(self):
        module = load_module()
        FakeTts.instances.clear()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            batch = root / "batch.jsonl"
            batch.write_text('{"text":"first"}\n{"text":"second"}\n', encoding="utf-8")
            voice = root / "voice.wav"
            write_wav(voice)
            model_dir = root / "checkpoints"
            model_dir.mkdir()
            (model_dir / "config.yaml").touch()
            first = module.run_batch(batch_file=batch, voice=voice, model_dir=model_dir, output_dir=root / "out", expected_count=2, tts_factory=FakeTts)
            batch.write_text('{"text":"second"}\n{"text":"first"}\n', encoding="utf-8")
            FakeTts.instances.clear()

            reordered = module.run_batch(batch_file=batch, voice=voice, model_dir=model_dir, output_dir=root / "out", expected_count=2, tts_factory=FakeTts)

            self.assertEqual(FakeTts.instances, [])
            self.assertEqual(reordered["summary"], {"completed": 2, "generated": 0, "cached": 2})
            self.assertEqual(
                {item["outputPath"] for item in reordered["items"]},
                {item["outputPath"] for item in first["items"]},
            )

    def test_corrupt_cached_wav_is_regenerated_with_one_model_construction(self):
        module = load_module()
        FakeTts.instances.clear()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            batch = root / "batch.jsonl"
            batch.write_text('{"text":"first"}\n{"text":"second"}\n', encoding="utf-8")
            voice = root / "voice.wav"
            write_wav(voice)
            model_dir = root / "checkpoints"
            model_dir.mkdir()
            (model_dir / "config.yaml").touch()
            first = module.run_batch(batch_file=batch, voice=voice, model_dir=model_dir, output_dir=root / "out", expected_count=2, tts_factory=FakeTts)
            Path(first["items"][0]["outputPath"]).write_bytes(b"broken")
            FakeTts.instances.clear()

            repaired = module.run_batch(batch_file=batch, voice=voice, model_dir=model_dir, output_dir=root / "out", expected_count=2, tts_factory=FakeTts)

            self.assertEqual(len(FakeTts.instances), 1)
            self.assertEqual(len(FakeTts.instances[0].calls), 1)
            self.assertEqual(repaired["summary"], {"completed": 2, "generated": 1, "cached": 1})
            self.assertTrue(module._valid_wav(Path(repaired["items"][0]["outputPath"])))

    def test_truncated_cached_wav_is_regenerated_with_one_model_construction(self):
        module = load_module()
        FakeTts.instances.clear()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            batch = root / "batch.jsonl"
            batch.write_text('{"text":"first"}\n{"text":"second"}\n', encoding="utf-8")
            voice = root / "voice.wav"
            write_wav(voice)
            model_dir = root / "checkpoints"
            model_dir.mkdir()
            (model_dir / "config.yaml").touch()
            first = module.run_batch(batch_file=batch, voice=voice, model_dir=model_dir, output_dir=root / "out", expected_count=2, tts_factory=FakeTts)
            damaged = Path(first["items"][0]["outputPath"])
            damaged.write_bytes(damaged.read_bytes()[:100])
            with wave.open(str(damaged), "rb") as audio:
                self.assertEqual(audio.getnframes(), 2205)
            FakeTts.instances.clear()

            repaired = module.run_batch(batch_file=batch, voice=voice, model_dir=model_dir, output_dir=root / "out", expected_count=2, tts_factory=FakeTts)

            self.assertEqual(len(FakeTts.instances), 1)
            self.assertEqual(len(FakeTts.instances[0].calls), 1)
            self.assertEqual(FakeTts.instances[0].calls[0]["text"], "first")
            self.assertEqual(repaired["summary"], {"completed": 2, "generated": 1, "cached": 1})


if __name__ == "__main__":
    unittest.main()
