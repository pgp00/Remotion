# S5Max 30-Video IndexTTS2 Pause Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all 30 S5Max voice tracks with the approved IndexTTS2 female voice and add a synchronized five-frame pause between sentences.

**Architecture:** A small Python standard-library tool prepares one 176-task IndexTTS2 JSONL batch, maps each generated WAV back to its video and sentence, trims only boundary silence, and builds FFmpeg filters from the existing SRT cues. Each cue keeps its current speech window; a five-frame audio/video pause is inserted after every non-final cue, preserving the full tail footage while shifting later burned subtitles and narration together.

**Tech Stack:** Python 3 standard library, IndexTTS2 CLI on remote Apple M4, SSH/SCP, FFmpeg/FFprobe.

## Global Constraints

- Use the exact `ttsText` values from `work/s5max-30-unique/scripts.json`.
- Use `/Users/fang/index-tts-validation/index-tts-main/examples/voice_03.wav` on MPS with FP16 disabled.
- Use exactly `5/30` seconds of pause at every sentence boundary.
- Preserve all source visuals and tail footage; output may be longer only by the inserted pauses and must remain at or below 30 seconds.
- Output MP3 as mono 22.05 kHz/96 kbps and MP4 audio as mono AAC 96 kbps.
- Write final videos only to `out/s5max-30-smb-unique-indextts2/`; do not change `out/s5max-30-smb-unique/`.

---

### Task 1: Add the batch and render tool with TDD

**Files:**
- Create: `scripts/test_s5max-indextts2-replace.py`
- Create: `scripts/s5max-indextts2-replace.py`

**Interfaces:**
- `parse_srt(text: str) -> list[dict]` returns contiguous cue start/end/text values in seconds.
- `build_batch(scripts: list[dict]) -> tuple[list[dict], list[dict]]` returns JSONL tasks plus deterministic `segment-NNNN.wav` mappings.
- `build_filters(cues, trimmed_durations, source_duration, pause_seconds=5/30) -> tuple[str, float]` returns one FFmpeg filter graph and final duration.

- [ ] Write tests asserting seven cues produce six five-frame pauses, final duration grows by exactly one second, task text concatenation equals each script `ttsText`, and 30 scripts produce 176 tasks.
- [ ] Run `python3 -m unittest scripts/test_s5max-indextts2-replace.py` and observe failure because the implementation does not exist.
- [ ] Implement only the tested parsing, mapping, filter construction, remote-batch preparation, per-video rendering, atomic output replacement, and media validation.
- [ ] Run the new test and existing `python3 -m unittest scripts/test_s5max-30-render.py`; expect all tests to pass.

### Task 2: Generate the 176 sentence WAV files remotely

**Files:**
- Create: `work/indextts2-s5max/all-segments.jsonl`
- Create: `work/indextts2-s5max/all-segments-manifest.json`
- Create remotely: `/Users/fang/index-tts-validation/outputs/s5max-all-segments/segment-0001.wav` through `segment-0176.wav`

- [ ] Run `python3 scripts/s5max-indextts2-replace.py prepare` and verify 30 videos/176 tasks.
- [ ] Copy the JSONL to `/Users/fang/index-tts-validation/inputs/all-segments.jsonl`.
- [ ] Run IndexTTS2 `batch --dry-run`; expect `Batch file OK: 176 tasks`.
- [ ] Run the real batch once with `voice_03.wav`, `--device mps`, `--no-fp16`, `--output-prefix segment`, and `--force`.
- [ ] Copy the completed WAV directory to `work/indextts2-s5max/all-segments/` and verify exactly 176 decodable WAV files.

### Task 3: Render and verify all 30 videos

**Files:**
- Create: `work/indextts2-s5max/batch-audio/s5max-01.mp3` through `s5max-30.mp3`
- Create/replace: `out/s5max-30-smb-unique-indextts2/s5max-01.mp4` through `s5max-30.mp4`

- [ ] Render all 30 items with `python3 scripts/s5max-indextts2-replace.py render --jobs 4`.
- [ ] Verify each output is H.264/yuv420p/1080×1920/30fps with mono AAC, duration `source + pauses`, no item over 30 seconds, and full FFmpeg decode success.
- [ ] Verify exactly 30 MP4 and 30 MP3 files and write `work/indextts2-s5max/batch-manifest.json` with per-item cue count, duration, codecs, and SHA-256.
