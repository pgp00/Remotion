#!/usr/bin/env python3
"""Prepare IndexTTS2 sentence batches and render pause-aware S5Max videos."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import re
import shutil
import subprocess
from collections import defaultdict
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_PATH = ROOT / "work/s5max-30-unique/scripts.json"
WORK_ROOT = ROOT / "work/indextts2-s5max"
SOURCE_VIDEO_ROOT = ROOT / "out/s5max-30-smb-unique"
OUTPUT_ROOT = ROOT / "out/s5max-30-smb-unique-indextts2"
FPS = 30
PAUSE_FRAMES = 5
PAUSE_SECONDS = PAUSE_FRAMES / FPS
EXPECTED_VIDEOS = 30


def _seconds(value: str) -> float:
    hours, minutes, rest = value.replace(",", ".").split(":")
    return int(hours) * 3600 + int(minutes) * 60 + float(rest)


def parse_srt(text: str) -> list[dict[str, Any]]:
    cues: list[dict[str, Any]] = []
    for block in re.split(r"\r?\n\s*\r?\n", text.strip()):
        lines = block.splitlines()
        if len(lines) < 3 or " --> " not in lines[1]:
            raise ValueError("invalid SRT cue")
        start_value, end_value = lines[1].split(" --> ", 1)
        cue = {"start": _seconds(start_value), "end": _seconds(end_value), "text": "\n".join(lines[2:]).strip()}
        if not cue["text"] or cue["end"] <= cue["start"]:
            raise ValueError("empty or invalid SRT cue")
        if cues and abs(cue["start"] - cues[-1]["end"]) > 0.002:
            raise ValueError("SRT cues must be contiguous")
        cues.append(cue)
    if not cues or abs(cues[0]["start"]) > 0.002:
        raise ValueError("SRT must start at zero")
    return cues


def build_batch(scripts: list[dict[str, Any]]) -> tuple[list[dict[str, str]], list[dict[str, Any]]]:
    tasks: list[dict[str, str]] = []
    mappings: list[dict[str, Any]] = []
    for script in scripts:
        sentence_texts = [str(sentence.get("ttsText", sentence.get("text", ""))).strip() for sentence in script.get("sentences", [])]
        if not sentence_texts or any(not text for text in sentence_texts) or "".join(sentence_texts) != script.get("ttsText"):
            raise ValueError(f"{script.get('id')} sentence text does not match full ttsText")
        for sentence_index, sentence_text in enumerate(sentence_texts, 1):
            task_index = len(tasks) + 1
            tasks.append({"text": sentence_text})
            mappings.append({
                "taskIndex": task_index,
                "id": script["id"],
                "sentenceIndex": sentence_index,
                "text": sentence_text,
                "filename": f"segment-{task_index:04d}.wav",
            })
    return tasks, mappings


def locate_completed_batch(out_root: Path, item_id: str) -> Path:
    matches: list[Path] = []
    for manifest_path in sorted(out_root.glob(".s5smb-*/manifest.json")):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if any(item.get("id") == item_id and item.get("status") == "complete" for item in manifest.get("items", [])):
            matches.append(manifest_path.parent)
    if len(matches) != 1:
        raise ValueError(f"expected one completed source batch for {item_id}, found {len(matches)}")
    return matches[0]


def build_filters(
    cues: list[dict[str, Any]],
    trimmed_durations: list[float],
    source_duration: float,
    pause_seconds: float = PAUSE_SECONDS,
) -> tuple[str, float]:
    if len(cues) != len(trimmed_durations):
        raise ValueError("cue and audio counts differ")
    if cues[-1]["end"] >= source_duration:
        raise ValueError("source video needs tail room after the last subtitle")
    final_duration = source_duration + pause_seconds * (len(cues) - 1)
    filters: list[str] = []
    video_labels: list[str] = []
    audio_labels: list[str] = []
    for index, (cue, audio_duration) in enumerate(zip(cues, trimmed_durations)):
        cue_duration = cue["end"] - cue["start"]
        pause = pause_seconds if index < len(cues) - 1 else 0.0
        video_filter = f"[0:v]trim=start={cue['start']:.6f}:end={cue['end']:.6f},setpts=PTS-STARTPTS"
        if pause:
            video_filter += f",tpad=stop_mode=clone:stop_duration={pause:.6f}"
        video_label = f"v{index}"
        filters.append(f"{video_filter}[{video_label}]")
        video_labels.append(f"[{video_label}]")
        ratio = audio_duration / cue_duration
        audio_label = f"a{index}"
        filters.append(
            f"[{index + 1}:a]atempo={ratio:.9f},apad,atrim=duration={cue_duration + pause:.6f}[{audio_label}]"
        )
        audio_labels.append(f"[{audio_label}]")
    tail_label = "vtail"
    filters.append(
        f"[0:v]trim=start={cues[-1]['end']:.6f}:end={source_duration:.6f},setpts=PTS-STARTPTS[{tail_label}]"
    )
    video_labels.append(f"[{tail_label}]")
    filters.append(
        f"{''.join(video_labels)}concat=n={len(video_labels)}:v=1:a=0,fps={FPS},format=yuv420p,setsar=1[vout]"
    )
    filters.append(
        f"{''.join(audio_labels)}concat=n={len(audio_labels)}:v=0:a=1,"
        f"loudnorm=I=-16:TP=-1.5:LRA=7,apad,atrim=duration={final_duration:.6f},asplit=2[amp3][amp4]"
    )
    return ";".join(filters), final_duration


def _run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def _probe(path: Path) -> dict[str, Any]:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,sample_rate,channels,duration:format=duration,size", "-of", "json", str(path)],
        check=True,
        text=True,
        capture_output=True,
    )
    return json.loads(result.stdout)


def _stream_duration(media: dict[str, Any], stream_type: str) -> float:
    stream = next((value for value in media.get("streams", []) if value.get("codec_type") == stream_type), None)
    value = stream.get("duration") if stream else None
    return float(value or media.get("format", {}).get("duration", 0) or 0)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _validate_output(path: Path, expected_duration: float) -> dict[str, Any]:
    media = _probe(path)
    video = next((value for value in media.get("streams", []) if value.get("codec_type") == "video"), None)
    audio = next((value for value in media.get("streams", []) if value.get("codec_type") == "audio"), None)
    if not video or video.get("codec_name") != "h264" or video.get("pix_fmt") != "yuv420p":
        raise RuntimeError("output video must be H.264/yuv420p")
    if (video.get("width"), video.get("height"), video.get("avg_frame_rate")) != (1080, 1920, "30/1"):
        raise RuntimeError("output video must be 1080x1920 at 30fps")
    if not audio or audio.get("codec_name") != "aac" or int(audio.get("channels", 0)) != 1:
        raise RuntimeError("output audio must be mono AAC")
    duration = float(media.get("format", {}).get("duration", 0) or 0)
    if abs(duration - expected_duration) > 0.08 or duration > 30.05:
        raise RuntimeError(f"unexpected output duration: {duration:.6f} expected {expected_duration:.6f}")
    _run(["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", str(path), "-f", "null", "-"])
    return {"durationSeconds": duration, "sizeBytes": int(media["format"]["size"]), "videoCodec": "h264", "audioCodec": "aac"}


def _render_item(item_id: str, mappings: list[dict[str, Any]], segments_root: Path, force: bool) -> dict[str, Any]:
    source_batch = locate_completed_batch(ROOT / "out", item_id)
    srt_path = source_batch / "subtitles" / f"{item_id}.srt"
    source_video = SOURCE_VIDEO_ROOT / f"{item_id}.mp4"
    cues = parse_srt(srt_path.read_text(encoding="utf-8"))
    item_mappings = sorted((value for value in mappings if value["id"] == item_id), key=lambda value: value["sentenceIndex"])
    if len(cues) != len(item_mappings):
        raise ValueError(f"{item_id} cue count does not match sentence count")
    trim_root = WORK_ROOT / "all-segments-trimmed" / item_id
    trim_root.mkdir(parents=True, exist_ok=True)
    trimmed_paths: list[Path] = []
    trimmed_durations: list[float] = []
    trim_filter = "silenceremove=start_periods=1:start_duration=0.05:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_duration=0.05:start_threshold=-45dB,areverse"
    for mapping in item_mappings:
        source_segment = segments_root / mapping["filename"]
        if not source_segment.is_file():
            raise FileNotFoundError(source_segment)
        trimmed_path = trim_root / mapping["filename"]
        _run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source_segment), "-af", trim_filter, str(trimmed_path)])
        trimmed_paths.append(trimmed_path)
        trimmed_durations.append(_stream_duration(_probe(trimmed_path), "audio"))
    source_duration = _stream_duration(_probe(source_video), "video")
    filter_graph, final_duration = build_filters(cues, trimmed_durations, source_duration)
    if final_duration > 30.05:
        raise RuntimeError(f"{item_id} would exceed 30 seconds: {final_duration:.6f}")
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    audio_root = WORK_ROOT / "batch-audio"
    audio_root.mkdir(parents=True, exist_ok=True)
    output_path = OUTPUT_ROOT / f"{item_id}.mp4"
    audio_path = audio_root / f"{item_id}.mp3"
    partial_path = OUTPUT_ROOT / f".{item_id}.partial.mp4"
    partial_audio = audio_root / f".{item_id}.partial.mp3"
    if output_path.exists() and not force:
        raise FileExistsError(output_path)
    inputs = [value for path in trimmed_paths for value in ("-i", str(path))]
    _run([
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source_video), *inputs,
        "-filter_complex", filter_graph,
        "-map", "[amp3]", "-ar", "22050", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "96k", str(partial_audio),
        "-map", "[vout]", "-map", "[amp4]", "-r", str(FPS), "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-ar", "22050", "-ac", "1", "-t", f"{final_duration:.6f}",
        "-movflags", "+faststart", str(partial_path),
    ])
    media = _validate_output(partial_path, final_duration)
    partial_audio.replace(audio_path)
    partial_path.replace(output_path)
    return {
        "id": item_id,
        "status": "complete",
        "cueCount": len(cues),
        "pauseFrames": PAUSE_FRAMES,
        "sourceDurationSeconds": source_duration,
        "outputPath": str(output_path),
        "audioPath": str(audio_path),
        "sha256": _sha256(output_path),
        "media": media,
    }


def _prepare() -> None:
    scripts = json.loads(SCRIPTS_PATH.read_text(encoding="utf-8"))["scripts"]
    if len(scripts) != EXPECTED_VIDEOS:
        raise ValueError(f"expected {EXPECTED_VIDEOS} scripts")
    tasks, mappings = build_batch(scripts)
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    (WORK_ROOT / "all-segments.jsonl").write_text("".join(json.dumps(task, ensure_ascii=False) + "\n" for task in tasks), encoding="utf-8")
    (WORK_ROOT / "all-segments-manifest.json").write_text(json.dumps({"schemaVersion": 1, "videoCount": len(scripts), "taskCount": len(tasks), "tasks": mappings}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"prepared videos={len(scripts)} tasks={len(tasks)}")


def _render(segments_root: Path, jobs: int, only: set[str] | None, force: bool) -> None:
    manifest = json.loads((WORK_ROOT / "all-segments-manifest.json").read_text(encoding="utf-8"))
    mappings = manifest["tasks"]
    item_ids = sorted({value["id"] for value in mappings})
    if only is not None:
        item_ids = [item_id for item_id in item_ids if item_id in only]
    results: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as executor:
        futures = {executor.submit(_render_item, item_id, mappings, segments_root, force): item_id for item_id in item_ids}
        for future in concurrent.futures.as_completed(futures):
            item_id = futures[future]
            try:
                result = future.result()
                print(f"complete {item_id} duration={result['media']['durationSeconds']:.3f}", flush=True)
            except Exception as error:
                result = {"id": item_id, "status": "failed", "error": str(error)}
                print(f"failed {item_id}: {error}", flush=True)
            results.append(result)
    results.sort(key=lambda value: value["id"])
    batch_manifest = {"schemaVersion": 1, "pauseFrames": PAUSE_FRAMES, "items": results, "summary": {"completed": sum(value["status"] == "complete" for value in results), "failed": sum(value["status"] == "failed" for value in results)}}
    manifest_path = WORK_ROOT / "batch-manifest.json"
    temporary = manifest_path.with_name(f".{manifest_path.name}.partial")
    temporary.write_text(json.dumps(batch_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(manifest_path)
    if batch_manifest["summary"]["failed"]:
        raise RuntimeError(f"{batch_manifest['summary']['failed']} items failed; see {manifest_path}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("prepare")
    render_parser = subparsers.add_parser("render")
    render_parser.add_argument("--segments-dir", type=Path, default=WORK_ROOT / "all-segments")
    render_parser.add_argument("--jobs", type=int, default=1)
    render_parser.add_argument("--only", help="comma-separated item IDs")
    render_parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise RuntimeError("ffmpeg and ffprobe are required")
    if args.command == "prepare":
        _prepare()
    else:
        if args.jobs < 1 or args.jobs > 8:
            raise ValueError("jobs must be between 1 and 8")
        only = set(filter(None, args.only.split(","))) if args.only else None
        _render(args.segments_dir, args.jobs, only, args.force)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
