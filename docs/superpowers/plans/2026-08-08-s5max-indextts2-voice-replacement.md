# S5Max IndexTTS2 Voice Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate and verify one natural female IndexTTS2 replacement-voice sample for `s5max-01` without re-encoding or overwriting the source video.

**Architecture:** Reuse the approved `scripts.json` text and the original Edge MP3 duration. Synthesize on the remote M4, copy the WAV locally, fit it to the existing speech duration with FFmpeg, normalize loudness, and mux it with a copied H.264 stream into a new output directory.

**Tech Stack:** IndexTTS2 CLI on remote Apple M4, SSH/SCP, Python standard library, FFmpeg/FFprobe.

## Global Constraints

- Use `work/s5max-30-unique/scripts.json` as the voice-text source; do not edit the CSV or copy.
- Use a clear, friendly Mandarin female voice without a sweet customer-service style.
- Preserve the source video stream and write MP4 audio as mono AAC at 96 kbps.
- Write only to `out/s5max-30-smb-unique-indextts2/`; do not overwrite the existing videos.
- The workspace is not a Git repository, so there are no commit steps.

---

### Task 1: Prepare and synthesize the `s5max-01` voice

**Files:**
- Create: `work/indextts2-s5max/s5max-01.txt`
- Create: `work/indextts2-s5max/s5max-01.raw.wav`

**Interfaces:**
- Consumes: `scripts[0].ttsText` from `work/s5max-30-unique/scripts.json`
- Produces: one non-empty WAV containing the complete narration

- [x] **Step 1: Extract the exact TTS text**

Run:

```bash
python3 -c 'import json; from pathlib import Path; item=json.loads(Path("work/s5max-30-unique/scripts.json").read_text())["scripts"][0]; assert item["id"]=="s5max-01"; Path("work/indextts2-s5max").mkdir(parents=True,exist_ok=True); Path("work/indextts2-s5max/s5max-01.txt").write_text(item["ttsText"],encoding="utf-8")'
```

Expected: exit code 0 and the output text exactly equals `scripts[0].ttsText`.

- [x] **Step 2: Copy the text to the remote M4**

Run: `scp work/indextts2-s5max/s5max-01.txt fang@192.168.77.2:/Users/fang/index-tts-validation/inputs/s5max-01.txt`

Expected: exit code 0.

- [x] **Step 3: Synthesize with IndexTTS2**

Run remotely:

```bash
/Users/fang/.local/bin/indextts2 synth \
  --text-file /Users/fang/index-tts-validation/inputs/s5max-01.txt \
  --voice /Users/fang/index-tts-validation/index-tts-main/examples/voice_03.wav \
  --model-dir /Users/fang/index-tts-validation/checkpoints \
  --device mps \
  --no-fp16 \
  --output /Users/fang/index-tts-validation/outputs/s5max-01.raw.wav \
  --force
```

Expected: exit code 0 and a non-empty WAV.

- [x] **Step 4: Copy and probe the WAV**

Run: `scp fang@192.168.77.2:/Users/fang/index-tts-validation/outputs/s5max-01.raw.wav work/indextts2-s5max/s5max-01.raw.wav`

Then run FFprobe and confirm duration is positive and the file fully decodes with FFmpeg.

### Task 2: Align, mux, and verify the sample

**Files:**
- Consume: `out/.s5smb-g1/audio/s5max-01.mp3`
- Consume: `out/s5max-30-smb-unique/s5max-01.mp4`
- Create: `work/indextts2-s5max/s5max-01-segments.jsonl`
- Create: `work/indextts2-s5max/s5max-01-segments/segment-0001.wav` through `segment-0007.wav`
- Create: `work/indextts2-s5max/s5max-01.mp3`
- Create: `out/s5max-30-smb-unique-indextts2/s5max-01.mp4`

**Interfaces:**
- Consumes: raw IndexTTS2 WAV, seven script sentences, original SRT cue durations, and original Edge MP3 duration
- Produces: one verified MP4 with copied video and replacement AAC audio

- [x] **Step 1: Calculate the whole-track tempo ratio**

Run:

```bash
raw_duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 work/indextts2-s5max/s5max-01.raw.wav)
speech_duration=$(ffprobe -v error -show_entries stream=duration -of csv=p=0 out/.s5smb-g1/audio/s5max-01.mp3)
tempo_ratio=$(python3 -c "r=float('$raw_duration')/float('$speech_duration'); assert 0.8 <= r <= 1.2, f'ratio {r:.4f} requires sentence alignment'; print(f'{r:.9f}')")
```

Observed: raw duration `27.706667`, speech duration `20.808000`, ratio `1.331530`; the assertion correctly selected sentence-level alignment.

- [x] **Step 2: Generate the seven sentence files**

Create `work/indextts2-s5max/s5max-01-segments.jsonl` from the seven `ttsText` sentence values, assert their concatenation equals the full `ttsText`, copy it to the remote M4, and run one IndexTTS2 batch with `voice_03.wav`, `--device mps`, and `--output-prefix segment`.

Observed: `Batch complete: 7 tasks generated`; all seven WAV files fully decode.

- [x] **Step 3: Remove boundary silence and fit the SRT cues**

Remove only leading and trailing silence with:

```text
silenceremove=start_periods=1:start_duration=0.05:start_threshold=-45dB,
areverse,
silenceremove=start_periods=1:start_duration=0.05:start_threshold=-45dB,
areverse
```

Apply the measured `atempo` ratios `1.067773549`, `1.199381776`, `1.086540325`, `1.004915717`, `1.407524747`, `1.051337948`, and `1.078195934` to the seven SRT windows. Concatenate them, normalize with `loudnorm=I=-16:TP=-1.5:LRA=7`, pad to `22.7` seconds, and encode mono MP3 at 22.05 kHz/96 kbps.

- [x] **Step 4: Replace only the MP4 audio**

Run:

```bash
mkdir -p out/s5max-30-smb-unique-indextts2
ffmpeg -nostdin -hide_banner -loglevel error \
  -i out/s5max-30-smb-unique/s5max-01.mp4 \
  -i work/indextts2-s5max/s5max-01.mp3 \
  -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 96k -ac 1 \
  -t 22.7 -movflags +faststart \
  out/s5max-30-smb-unique-indextts2/s5max-01.mp4
```

Expected: exit code 0 and an MP4 with the original video packets plus the replacement audio.

- [x] **Step 5: Verify the completed sample**

Run:

```bash
ffprobe -v error -show_entries format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels -of json out/s5max-30-smb-unique-indextts2/s5max-01.mp4
ffmpeg -nostdin -v error -xerror -i out/s5max-30-smb-unique-indextts2/s5max-01.mp4 -f null -
```

Confirm H.264 video, mono AAC audio, unchanged dimensions/frame rate, duration within 50 ms of the source, and both commands exit 0.
