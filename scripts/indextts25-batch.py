#!/usr/bin/env python3
"""Generate an IndexTTS 2.5 JSONL batch with one model load."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import wave
from pathlib import Path
from typing import Any, Callable


ENGINE_VERSION = "v2.5.0"


def _local_path(value: str | Path, name: str) -> Path:
    if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", str(value)):
        raise ValueError(f"{name} must be a local filesystem path")
    return Path(value)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _valid_wav(path: Path) -> bool:
    try:
        with wave.open(str(path), "rb") as audio:
            channels = audio.getnchannels()
            sample_width = audio.getsampwidth()
            frames = audio.getnframes()
            return (
                channels > 0
                and sample_width > 0
                and audio.getframerate() > 0
                and frames > 0
                and len(audio.readframes(frames)) == frames * channels * sample_width
            )
    except (FileNotFoundError, OSError, EOFError, wave.Error):
        return False


def load_tasks(batch_file: Path) -> list[dict[str, Any]]:
    tasks = []
    for line_number, raw_line in enumerate(batch_file.read_text(encoding="utf-8").splitlines(), 1):
        if not raw_line.strip():
            continue
        try:
            task = json.loads(raw_line)
        except json.JSONDecodeError as error:
            raise ValueError(f"batch line {line_number} is invalid JSON") from error
        if not isinstance(task, dict) or set(task) - {"text", "duration_factor"}:
            raise ValueError(f"batch line {line_number} must contain only text and optional duration_factor")
        text = task.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"batch line {line_number} has empty text")
        duration_factor = task.get("duration_factor", 1.0)
        if isinstance(duration_factor, bool) or not isinstance(duration_factor, (int, float)) or not 0.5 <= float(duration_factor) <= 2.0:
            raise ValueError(f"batch line {line_number} duration_factor must be between 0.5 and 2.0")
        tasks.append({"line": line_number, "text": text.strip(), "durationFactor": float(duration_factor)})
    if not tasks:
        raise ValueError("batch contains no tasks")
    return tasks


def _write_manifest(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.partial")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def run_batch(
    *,
    batch_file: Path,
    voice: Path,
    model_dir: Path,
    output_dir: Path,
    expected_count: int,
    device: str = "mps",
    lang: str = "ZH",
    output_prefix: str = "segment",
    force: bool = False,
    manifest_path: Path | None = None,
    tts_factory: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    batch_file = _local_path(batch_file, "batch_file")
    voice = _local_path(voice, "voice")
    model_dir = _local_path(model_dir, "model_dir")
    output_dir = _local_path(output_dir, "output_dir")
    if manifest_path is not None:
        manifest_path = _local_path(manifest_path, "manifest_path")
    tasks = load_tasks(batch_file)
    if len(tasks) != expected_count:
        raise ValueError(f"expected {expected_count} tasks, found {len(tasks)}")
    if not _valid_wav(voice):
        raise ValueError(f"voice must be a valid WAV: {voice}")
    if not (model_dir / "config.yaml").is_file():
        raise ValueError(f"model config is missing: {model_dir / 'config.yaml'}")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", output_prefix):
        raise ValueError("output prefix must be filename-safe")

    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = Path(manifest_path) if manifest_path else output_dir / "manifest.json"
    audit = {
        "engineVersion": ENGINE_VERSION,
        "device": device,
        "language": lang,
        "modelDir": str(model_dir),
        "modelConfigSha256": _sha256(model_dir / "config.yaml"),
        "voiceSha256": _sha256(voice),
        "batchSha256": _sha256(batch_file),
        "expectedCount": expected_count,
        "outputPrefix": output_prefix,
    }
    key_context = {
        "engineVersion": audit["engineVersion"],
        "language": audit["language"],
        "modelConfigSha256": audit["modelConfigSha256"],
        "voiceSha256": audit["voiceSha256"],
    }
    for task in tasks:
        task["contentKey"] = hashlib.sha256(json.dumps({
            **key_context,
            "text": task["text"],
            "durationFactor": task["durationFactor"],
        }, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    outputs = [output_dir / f"{output_prefix}-{task['contentKey']}.wav" for task in tasks]
    needs_model = force or any(not _valid_wav(path) for path in outputs)
    tts = None
    if needs_model:
        if tts_factory is None:
            try:
                from indextts.infer_v2_5 import IndexTTS2
            except ModuleNotFoundError as error:
                raise RuntimeError("Local IndexTTS 2.5 is not installed; install v2.5 in this Python environment.") from error
            tts_factory = IndexTTS2
        tts = tts_factory(
            cfg_path=str(model_dir / "config.yaml"),
            model_dir=str(model_dir),
            use_bf16=False,
            device=device,
        )

    items = []
    generated = 0
    cached = 0
    for task, output_path in zip(tasks, outputs):
        if not force and _valid_wav(output_path):
            status = "cached"
            cached += 1
        else:
            partial_path = output_path.with_name(f".{output_path.stem}.partial.wav")
            try:
                assert tts is not None
                tts.infer(
                    spk_audio_prompt=str(voice),
                    text=task["text"],
                    lang=lang,
                    output_path=str(partial_path),
                    duration_factor=task["durationFactor"],
                    verbose=False,
                )
                if not _valid_wav(partial_path):
                    raise RuntimeError(f"IndexTTS 2.5 produced an invalid WAV for batch line {task['line']}")
                partial_path.replace(output_path)
            finally:
                partial_path.unlink(missing_ok=True)
            status = "generated"
            generated += 1
        items.append({
            "line": task["line"],
            "text": task["text"],
            "status": status,
            "outputPath": str(output_path),
            "durationFactor": task["durationFactor"],
            "contentKey": task["contentKey"],
            "sha256": _sha256(output_path),
        })

    manifest = {
        "schemaVersion": 1,
        "engine": "IndexTTS-2.5",
        **audit,
        "voicePath": str(voice),
        "items": items,
        "summary": {"completed": len(items), "generated": generated, "cached": cached},
    }
    _write_manifest(manifest_path, manifest)
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-file", required=True, type=Path)
    parser.add_argument("--voice", required=True, type=Path)
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--expected-count", required=True, type=int)
    parser.add_argument("--device", default="mps")
    parser.add_argument("--lang", default="ZH")
    parser.add_argument("--output-prefix", default="segment")
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    manifest = run_batch(
        batch_file=args.batch_file,
        voice=args.voice,
        model_dir=args.model_dir,
        output_dir=args.output_dir,
        expected_count=args.expected_count,
        device=args.device,
        lang=args.lang,
        output_prefix=args.output_prefix,
        force=args.force,
        manifest_path=args.manifest,
    )
    summary = manifest["summary"]
    print(f"IndexTTS 2.5 batch complete: completed={summary['completed']} generated={summary['generated']} cached={summary['cached']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
