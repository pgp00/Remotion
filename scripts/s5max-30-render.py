#!/usr/bin/env python3
"""Small, contract-first S5Max batch renderer.

The script deliberately owns no editing model: the material and copy agents
provide the two JSON contracts, while FFmpeg does the mechanical assembly.
Dry-run is safe and useful before either contract is available.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable


EXPECTED_COUNT = 30
VIDEO_WIDTH = 1080
VIDEO_HEIGHT = 1920
FPS = 30
DEFAULT_VOICE = "Tingting"


def _sha256(value: Any) -> str:
    if isinstance(value, bytes):
        return hashlib.sha256(value).hexdigest()
    payload = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _entries(payload: Any, keys: tuple[str, ...], label: str) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        values = payload
    elif isinstance(payload, dict):
        values = next((payload[key] for key in keys if isinstance(payload.get(key), list)), None)
        if values is None:
            raise ValueError(f"{label} contract must contain one of: {', '.join(keys)}")
    else:
        raise ValueError(f"{label} contract must be a JSON object or array")
    if not all(isinstance(value, dict) for value in values):
        raise ValueError(f"{label} entries must be JSON objects")
    return list(values)


def _entry_id(entry: dict[str, Any], index: int) -> str:
    value = entry.get("id", entry.get("videoId", entry.get("scriptId")))
    return str(value or f"s5max-{index + 1:02d}")


def _path_value(clip: dict[str, Any]) -> str:
    # Prefer the verified local proxy when a scout supplies both it and the SMB
    # original; the original remains a valid fallback for future contracts.
    for key in ("path", "proxyPath", "sourcePath", "file", "source"):
        value = clip.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    raise ValueError("each material clip needs a path/sourcePath/proxyPath")


def _number(clip: dict[str, Any], keys: tuple[str, ...], default: float | None = None) -> float | None:
    for key in keys:
        if key in clip and clip[key] is not None:
            try:
                return float(clip[key])
            except (TypeError, ValueError) as error:
                raise ValueError(f"clip field {key} must be numeric") from error
    return default


def _clip_list(video: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("clips", "shots", "segments", "timeline", "shotOrder"):
        values = video.get(key)
        if isinstance(values, list):
            result = []
            for value in values:
                if isinstance(value, str):
                    result.append({"path": value})
                elif isinstance(value, dict):
                    result.append(value)
                else:
                    raise ValueError("material clips must be strings or objects")
            return result
    raise ValueError("each material video needs clips/shots/segments/shotOrder")


def _normalise_clip(clip: dict[str, Any], base_dir: Path | None = None) -> dict[str, Any]:
    path_value = _path_value(clip)
    source_path = Path(path_value).expanduser()
    if not source_path.is_absolute() and base_dir is not None:
        source_path = base_dir / source_path
    start = _number(clip, ("sourceInSeconds", "inSeconds", "startSeconds", "in", "start"), 0.0)
    end = _number(clip, ("sourceOutSeconds", "outSeconds", "endSeconds", "out", "end"))
    duration = _number(clip, ("durationSeconds", "duration"))
    if end is None and duration is not None:
        end = float(start or 0.0) + duration
    if end is None:
        end = float(start or 0.0) + 1.0
    if start is None:
        start = 0.0
    return {
        "path": str(source_path),
        "sourceInSeconds": float(start),
        "sourceOutSeconds": float(end),
        "label": str(clip.get("label", clip.get("id", ""))),
    }


def _normalise_script(entry: dict[str, Any], index: int) -> dict[str, Any]:
    sentences_value = entry.get("sentences", entry.get("sentenceUnits", entry.get("units")))
    if not isinstance(sentences_value, list):
        sentences_value = [entry.get("subtitleText", entry.get("ttsText", entry.get("text", "")))]
    sentences: list[dict[str, Any]] = []
    for value in sentences_value:
        if isinstance(value, str):
            text = value.strip()
            item = {"text": text}
        elif isinstance(value, dict):
            item = dict(value)
            text = str(item.get("text", item.get("subtitleText", item.get("ttsText", "")))).strip()
            item["text"] = text
        else:
            raise ValueError("script sentence units must be strings or objects")
        if text:
            sentences.append(item)
    tts_text = str(entry.get("ttsText", entry.get("voiceText", entry.get("text", "")))).strip()
    if not tts_text:
        tts_text = "".join(sentence["text"] for sentence in sentences)
    subtitle_text = str(entry.get("subtitleText", ""))
    if not subtitle_text:
        subtitle_text = "".join(sentence["text"] for sentence in sentences)
    return {
        "id": _entry_id(entry, index),
        "title": str(entry.get("title", entry.get("name", ""))),
        "sentences": sentences,
        "ttsText": tts_text,
        "subtitleText": subtitle_text,
        "cta": str(entry.get("cta", "")),
        "estimatedDurationSeconds": entry.get("estimatedDurationSeconds", entry.get("durationSeconds")),
    }


def _safe_path(value: str | Path, allowed_roots: Iterable[Path], label: str, require_existing: bool = False) -> Path:
    raw = str(value)
    if not raw or "\x00" in raw:
        raise ValueError(f"{label} is empty or contains NUL")
    candidate = Path(raw).expanduser().resolve(strict=False)
    roots = [Path(root).expanduser().resolve(strict=False) for root in allowed_roots]
    if not any(candidate == root or root in candidate.parents for root in roots):
        raise ValueError(f"{label} escapes approved roots: {raw}")
    if require_existing:
        if not candidate.is_file() or candidate.is_symlink():
            raise ValueError(f"{label} is not a regular file: {raw}")
    return candidate


def _range_key(clip: dict[str, Any]) -> tuple[str, float, float]:
    return clip["path"], clip["sourceInSeconds"], clip["sourceOutSeconds"]


def _normalise_material(entry: dict[str, Any], index: int, base_dir: Path | None) -> dict[str, Any]:
    clips = [_normalise_clip(clip, base_dir) for clip in _clip_list(entry)]
    return {"id": _entry_id(entry, index), "title": str(entry.get("title", entry.get("name", ""))), "clips": clips}


def validate_contracts(
    material: Any,
    scripts: Any,
    *,
    allowed_roots: Iterable[str | Path] | None = None,
    require_existing_paths: bool = False,
    material_base_dir: Path | None = None,
) -> dict[str, Any]:
    """Validate and normalize both contracts; no files are written."""
    roots = [Path(root) for root in (allowed_roots or [Path.cwd(), Path("/Volumes/192.168.50.79")])]
    material_entries = _entries(material, ("videos", "items", "entries", "shots"), "material")
    script_entries = _entries(scripts, ("scripts", "items", "entries", "videos"), "script")
    if len(material_entries) != EXPECTED_COUNT or len(script_entries) != EXPECTED_COUNT:
        raise ValueError(f"both contracts must contain exactly {EXPECTED_COUNT} entries")

    videos = [_normalise_material(entry, index, material_base_dir) for index, entry in enumerate(material_entries)]
    copy = [_normalise_script(entry, index) for index, entry in enumerate(script_entries)]
    video_ids = [item["id"] for item in videos]
    script_ids = [item["id"] for item in copy]
    if len(set(video_ids)) != EXPECTED_COUNT or len(set(script_ids)) != EXPECTED_COUNT:
        raise ValueError("material and script IDs must be unique")
    if set(video_ids) != set(script_ids):
        raise ValueError("material and script IDs must match")

    script_hashes: list[str] = []
    shot_hashes: list[str] = []
    for video in videos:
        if len(video["clips"]) < 4:
            raise ValueError(f"{video['id']} needs at least four material clips")
        ranges_by_path: dict[str, list[tuple[float, float]]] = {}
        for clip in video["clips"]:
            start, end = clip["sourceInSeconds"], clip["sourceOutSeconds"]
            if start < 0 or end <= start:
                raise ValueError(f"{video['id']} contains an invalid source range")
            clip_path = _safe_path(clip["path"], roots, f"{video['id']} clip path", require_existing_paths)
            clip["path"] = str(clip_path)
            ranges = ranges_by_path.setdefault(str(clip_path), [])
            if any(start < old_end and end > old_start for old_start, old_end in ranges):
                raise ValueError(f"{video['id']} contains overlapping ranges for {clip_path}")
            ranges.append((start, end))
        shot_hashes.append(_sha256([_range_key(clip) for clip in video["clips"]]))
    for script in copy:
        if not script["ttsText"]:
            raise ValueError(f"{script['id']} has empty voice text")
        if not 4 <= len(script["sentences"]) <= 10:
            raise ValueError(f"{script['id']} must contain 4-10 non-empty sentence units")
        estimated = script["estimatedDurationSeconds"]
        if estimated is not None:
            try:
                estimated = float(estimated)
            except (TypeError, ValueError) as error:
                raise ValueError(f"{script['id']} estimatedDurationSeconds must be numeric") from error
            if not 20 <= estimated <= 30:
                raise ValueError(f"{script['id']} estimated duration must be 20-30 seconds")
        script_hashes.append(_sha256(script["ttsText"]))
    if len(set(script_hashes)) != EXPECTED_COUNT:
        raise ValueError("script full-text hashes must be unique")
    if len(set(shot_hashes)) != EXPECTED_COUNT:
        raise ValueError("shot-order hashes must be unique")
    return {
        "count": EXPECTED_COUNT,
        "videos": videos,
        "scripts": copy,
        "scriptHashes": script_hashes,
        "shotOrderHashes": shot_hashes,
    }


def _seconds(value: float) -> str:
    return f"{value:.3f}"


def _escape_filter_path(path: Path) -> str:
    return str(path).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def tts_text(text: str) -> str:
    """Use readable Mandarin pronunciations while leaving subtitle copy intact."""
    text = re.sub(r"S5Max", "S五Max", text, flags=re.IGNORECASE)
    text = text.replace("39000", "三万九千").replace("Type-C", "Type C")
    return text


def _subtitle_filter(srt_path: Path) -> str:
    return f"subtitles='{_escape_filter_path(srt_path)}':force_style='FontName=PingFang SC,FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Shadow=1,Alignment=2,MarginV=120'"


def build_render_plan(
    material_video: dict[str, Any],
    script_entry: dict[str, Any],
    output_dir: str | Path,
    *,
    voice_name: str = DEFAULT_VOICE,
    subtitle_path: str | Path | None = None,
    voice_engine: str = "edge",
    only_ids: set[str] | None = None,
    burn_subtitles: bool = True,
) -> dict[str, Any]:
    video = _normalise_material(material_video, 0, None)
    script = _normalise_script(script_entry, 0)
    output_root = Path(output_dir).resolve(strict=False)
    item_id = video["id"]
    audio_path = output_root / "audio" / f"{item_id}.mp3"
    srt_path = Path(subtitle_path) if subtitle_path else output_root / "subtitles" / f"{item_id}.srt"
    output_path = output_root / f"{item_id}.mp4"
    partial_path = output_root / f".{item_id}.partial.mp4"
    say_command = (["uvx", "--from", "edge-tts", "edge-tts", "--voice", "zh-CN-XiaoxiaoNeural", "--rate", "+50%", "--text", tts_text(script["ttsText"]), "--write-media", str(audio_path)]
        if voice_engine == "edge" else ["say", "-v", voice_name, "-o", str(audio_path), tts_text(script["ttsText"])])
    inputs: list[str] = []
    filters: list[str] = []
    for index, clip in enumerate(video["clips"]):
        duration = clip["sourceOutSeconds"] - clip["sourceInSeconds"]
        inputs.extend(["-ss", _seconds(clip["sourceInSeconds"]), "-t", _seconds(duration), "-i", clip["path"]])
        filters.append(
            f"[{index}:v]scale={VIDEO_WIDTH}:{VIDEO_HEIGHT}:force_original_aspect_ratio=decrease," +
            f"pad={VIDEO_WIDTH}:{VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2,fps={FPS},format=yuv420p,setsar=1,setpts=PTS-STARTPTS[v{index}]"
        )
    video_labels = "".join(f"[v{index}]" for index in range(len(video["clips"])))
    filters.append(f"{video_labels}concat=n={len(video['clips'])}:v=1:a=0,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=60[vc]")
    filters.append(f"[vc]{_subtitle_filter(srt_path)}[vout]" if burn_subtitles else "[vc]format=yuv420p[vout]")
    audio_index = len(video["clips"])
    ffmpeg_command = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        *inputs,
        "-i", str(audio_path),
        "-filter_complex", ";".join(filters),
        "-map", "[vout]", "-map", f"{audio_index}:a:0",
        "-af", "apad=whole_dur=20,atrim=duration=30",
        "-r", str(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
        "-shortest", str(partial_path),
    ]
    return {
        "id": item_id,
        "title": script.get("title") or video.get("title", ""),
        "voiceText": script["ttsText"],
        "subtitleText": script["subtitleText"],
        "clips": video["clips"],
        "audioPath": str(audio_path),
        "subtitlePath": str(srt_path),
        "outputPath": str(output_path),
        "partialPath": str(partial_path),
        "sayCommand": say_command,
        "ffmpegCommand": ffmpeg_command,
    }


def _format_srt_time(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, rest = divmod(milliseconds, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    whole_seconds, millis = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d},{millis:03d}"


def build_srt(script: dict[str, Any], duration_seconds: float) -> str:
    sentences = script.get("sentences") or [{"text": script.get("subtitleText", "")}]
    weights = [max(1, len(str(item.get("text", "")))) for item in sentences]
    total = sum(weights) or 1
    lines: list[str] = []
    cursor = 0.0
    for index, (sentence, weight) in enumerate(zip(sentences, weights), 1):
        end = duration_seconds if index == len(sentences) else duration_seconds * sum(weights[:index]) / total
        text = str(sentence.get("text", "")).strip()
        if text and end > cursor:
            lines.extend([str(index), f"{_format_srt_time(cursor)} --> {_format_srt_time(end)}", text, ""])
        cursor = end
    return "\n".join(lines)


def _run_command(command: list[str], *, capture: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=True, text=True, capture_output=capture)


def check_tools(ffmpeg: str = "ffmpeg", say: str = "say") -> dict[str, str]:
    ffmpeg_path = shutil.which(ffmpeg)
    say_path = shutil.which(say)
    if not ffmpeg_path:
        raise RuntimeError(f"required tool not found: {ffmpeg}")
    if not say_path and not shutil.which("uvx"):
        raise RuntimeError("required voice tool not found: uvx or say")
    return {"ffmpeg": ffmpeg_path, "say": say_path or shutil.which("uvx",)}


def _probe_audio_duration(audio_path: Path) -> float:
    result = _run_command(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(audio_path)])
    try:
        duration = float(result.stdout.strip())
    except ValueError as error:
        raise RuntimeError(f"unable to probe generated voice: {audio_path}") from error
    if not duration or duration <= 0:
        raise RuntimeError(f"generated voice is empty: {audio_path}")
    return duration


def _probe_media(output_path: Path) -> dict[str, Any]:
    result = _run_command([
        "ffprobe", "-v", "error", "-show_entries",
        "stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate:format=duration,size",
        "-of", "json", str(output_path),
    ])
    value = json.loads(result.stdout)
    streams = value.get("streams", [])
    video = next((item for item in streams if item.get("codec_type") == "video"), None)
    audio = next((item for item in streams if item.get("codec_type") == "audio"), None)
    if not video or video.get("codec_name") != "h264":
        raise RuntimeError("output is missing H.264 video")
    if video.get("pix_fmt") != "yuv420p" or int(video.get("width", 0)) != VIDEO_WIDTH or int(video.get("height", 0)) != VIDEO_HEIGHT:
        raise RuntimeError("output does not meet 1080x1920/yuv420p contract")
    rate = str(video.get("avg_frame_rate", "0/1")).split("/")
    fps = float(rate[0]) / float(rate[1]) if len(rate) == 2 and float(rate[1]) else 0.0
    if abs(fps - FPS) > 0.01:
        raise RuntimeError(f"output is not 30fps: {fps}")
    if not audio or audio.get("codec_name") != "aac":
        raise RuntimeError("output is missing AAC audio")
    duration = float(value.get("format", {}).get("duration", 0) or 0)
    if not 20 <= duration <= 30.5:
        raise RuntimeError(f"output duration is outside 20-30 seconds: {duration:.3f}")
    size = int(value.get("format", {}).get("size", 0) or 0)
    if size <= 0:
        raise RuntimeError("output is empty")
    return {"width": VIDEO_WIDTH, "height": VIDEO_HEIGHT, "fps": fps, "durationSeconds": duration, "sizeBytes": size}


def _decode_check(output_path: Path) -> None:
    _run_command(["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", str(output_path), "-f", "null", "-"])


def _write_manifest(manifest_path: Path, manifest: dict[str, Any]) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = manifest_path.with_name(f".{manifest_path.name}.partial")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(manifest_path)


def run(
    *,
    material_path: str | Path,
    scripts_path: str | Path,
    output_dir: str | Path,
    manifest_path: str | Path | None = None,
    mode: str = "dry-run",
    allowed_roots: Iterable[str | Path] | None = None,
    voice_name: str = DEFAULT_VOICE,
    voice_engine: str = "edge",
    only_ids: set[str] | None = None,
    require_existing_paths: bool | None = None,
) -> dict[str, Any]:
    if mode not in {"dry-run", "execute"}:
        raise ValueError("mode must be dry-run or execute")
    material_file = Path(material_path).resolve()
    scripts_file = Path(scripts_path).resolve()
    material = json.loads(material_file.read_text(encoding="utf-8"))
    scripts = json.loads(scripts_file.read_text(encoding="utf-8"))
    roots = [Path(root) for root in (allowed_roots or [Path.cwd(), Path("/Volumes/192.168.50.79")])]
    output_root = _safe_path(output_dir, roots, "output directory")
    if require_existing_paths is None:
        require_existing_paths = mode == "execute"
    burn_subtitles = False
    validated = validate_contracts(
        material,
        scripts,
        allowed_roots=roots,
        require_existing_paths=require_existing_paths,
        material_base_dir=material_file.parent,
    )
    scripts_by_id = {entry["id"]: entry for entry in validated["scripts"]}
    manifest_file = Path(manifest_path).resolve() if manifest_path else output_root / "manifest.json"
    _safe_path(manifest_file.parent, roots, "manifest directory")
    if mode == "execute":
        check_tools()
        burn_subtitles = "subtitles" in subprocess.run(["ffmpeg", "-hide_banner", "-filters"], text=True, capture_output=True, check=True).stdout
        output_root.mkdir(parents=True, exist_ok=True)
    items: list[dict[str, Any]] = []
    for video in validated["videos"]:
        if only_ids is not None and video["id"] not in only_ids:
            continue
        script = scripts_by_id[video["id"]]
        plan = build_render_plan(video, script, output_root, voice_name=voice_name, voice_engine=voice_engine, burn_subtitles=burn_subtitles)
        item = {"id": video["id"], "status": "planned", "plan": plan}
        if mode == "execute":
            try:
                audio_path = Path(plan["audioPath"])
                srt_path = Path(plan["subtitlePath"])
                partial_path = Path(plan["partialPath"])
                output_path = Path(plan["outputPath"])
                for path in (audio_path, srt_path, partial_path, output_path):
                    _safe_path(path, roots, f"{video['id']} output")
                if output_path.exists() or output_path.is_symlink():
                    raise RuntimeError("final output already exists")
                audio_path.parent.mkdir(parents=True, exist_ok=True)
                srt_path.parent.mkdir(parents=True, exist_ok=True)
                for attempt in range(3):
                    try:
                        _run_command(plan["sayCommand"])
                        if Path(plan["audioPath"]).stat().st_size > 0:
                            break
                    except Exception:
                        if attempt == 2:
                            raise
                else:
                    raise RuntimeError("voice generation produced no audio")
                audio_duration = _probe_audio_duration(audio_path)
                srt_path.write_text(build_srt(script, audio_duration), encoding="utf-8")
                _run_command(plan["ffmpegCommand"])
                media = _probe_media(partial_path)
                _decode_check(partial_path)
                if partial_path.is_symlink() or not partial_path.is_file() or partial_path.stat().st_size <= 0:
                    raise RuntimeError("unsafe or empty partial output")
                partial_path.replace(output_path)
                item.update({"status": "complete", "outputPath": str(output_path), "sha256": _sha256(output_path.read_bytes()), "media": media})
            except Exception as error:  # per-item failure is recorded, then the batch continues
                item.update({"status": "failed", "error": str(error)})
        items.append(item)
        _write_manifest(manifest_file, {"schemaVersion": 1, "mode": mode, "count": EXPECTED_COUNT, "items": items, "summary": {"planned": sum(item["status"] == "planned" for item in items), "completed": sum(item["status"] == "complete" for item in items), "failed": sum(item["status"] == "failed" for item in items)}})
    summary = {
        "planned": sum(item["status"] == "planned" for item in items),
        "completed": sum(item["status"] == "complete" for item in items),
        "failed": sum(item["status"] == "failed" for item in items),
    }
    manifest = {
        "schemaVersion": 1,
        "mode": mode,
        "count": EXPECTED_COUNT,
        "scriptHashes": validated["scriptHashes"],
        "shotOrderHashes": validated["shotOrderHashes"],
        "items": items,
        "summary": summary,
    }
    _write_manifest(manifest_file, manifest)
    if mode == "execute" and summary["failed"]:
        raise RuntimeError(f"{summary['failed']} of {EXPECTED_COUNT} items failed; see {manifest_file}")
    return manifest


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--material-contract", required=True, type=Path)
    parser.add_argument("--script-contract", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--mode", choices=("dry-run", "execute"), default="dry-run")
    parser.add_argument("--voice", default=DEFAULT_VOICE)
    parser.add_argument("--voice-engine", choices=("edge", "say"), default="edge")
    parser.add_argument("--only", help="comma-separated video IDs to execute")
    parser.add_argument("--allowed-root", action="append", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    roots = args.allowed_root or [Path.cwd(), Path("/Volumes/192.168.50.79")]
    try:
        manifest = run(
            material_path=args.material_contract,
            scripts_path=args.script_contract,
            output_dir=args.output_dir,
            manifest_path=args.manifest,
            mode=args.mode,
            allowed_roots=roots,
            voice_name=args.voice,
            voice_engine=args.voice_engine,
            only_ids=set(filter(None, args.only.split(","))) if args.only else None,
        )
    except Exception as error:
        print(f"s5max render failed: {error}", file=sys.stderr)
        return 1
    summary = manifest["summary"]
    print(f"s5max render {args.mode}: planned={summary['planned']} completed={summary['completed']} failed={summary['failed']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
