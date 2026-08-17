## Objective

Deliver 30 premium S5Max promotional MP4s with distinct scripts, distinct shot orders, Mandarin voiceover, and evidence that every file is playable and meets 1080x1920/30fps/H.264/AAC requirements.

## Baseline

- Repository/workspace: `/Users/gilgamesharcher/Repo/Remotion`
- Baseline commit or snapshot: no Git metadata; current filesystem snapshot
- Governing instructions: approved spec `docs/superpowers/specs/2026-08-08-s5max-30-unique-videos-design.md`
- User-owned changes to preserve: all existing `out/`, `work/`, and source files
- Available concurrency: use 3 Luna Max agents plus lead

## Work graph

```text
[Lead: shared output contract]
├── [A: material scout and shot matrix]
├── [B: 30-script copy and voice plan]
└── [C: rendering pipeline prototype]
        ↓
[Lead integrates contracts and runs batch render]
        ↓
[Lead system QC and release verdict]
```

## Role matrix

| Role | Tier | Objective | Required skills | Write ownership | Deliverable | Depends on |
| --- | --- | --- | --- | --- | --- | --- |
| PROJECT_LEAD | L | integrate 30-video production and final QC | multi-agent-project-lead, verification-before-completion | shared status, integration outputs | release verdict | — |
| MATERIAL_SCOUT | S | identify premium usable source clips and 30 shot-order variants | ponytail | `work/s5max-30-unique/material-matrix.json` | material matrix + ffprobe evidence | baseline |
| COPY_EDITOR | S | select and normalize 30 distinct CSV scripts with CTA and sentence units | ponytail | `work/s5max-30-unique/scripts.json` | 30 scripts + voice text + uniqueness checks | baseline |
| PIPELINE_ENGINEER | E | implement/test bounded batch rendering pipeline | ponytail, test-driven-development | `scripts/s5max-30-render.py`, `scripts/test_s5max-30-render.py` | runnable generator + tests | baseline |

## Shared constraints

- Preserve unrelated user changes.
- Do not use destructive Git operations.
- Do not download copyrighted third-party footage without a source/license record.
- Prefer user-provided SMB/local S5Max footage; external material scout may only propose licensed/public-domain sources.
- Only the lead modifies shared status and integration files.
- Every agent reports evidence, not only completion status.
- Final output must be 30 genuinely different MP4s, not copies or hardlinks.

## Role briefs

### MATERIAL_SCOUT

- Role and tier: Specialist, Tier S
- Objective: Produce a shot matrix mapping 30 videos to varied local S5Max proxy clips and source ranges.
- Context: Existing proxies live in `work/s5max-quick/public/proxies`; SMB is read-only and may contain additional product footage.
- Required skills: `ponytail` for minimal, bounded asset selection.
- May read: existing proxies, CSV, local asset catalogs, SMB paths if mounted.
- May write: only `work/s5max-30-unique/material-matrix.json` and `work/s5max-30-unique/material-scout-result.md`.
- Must do: inspect duration/codec/visual content; select at least 4 clips per video; ensure all 30 shot-order arrays differ; record exact paths and source in/out seconds.
- Must not do: edit renderer, download unlicensed assets, modify existing outputs, or claim visual quality without evidence.
- Deliverables: JSON matrix, ffprobe command output, notes on any external source and license.
- Acceptance: JSON parses; exactly 30 entries; every entry has >=4 clips; all shot-order hashes are unique; every path exists.
- Stop conditions: missing SMB access, unclear license, or overlap with renderer files.

### COPY_EDITOR

- Role and tier: Specialist, Tier S
- Objective: Produce 30 distinct premium Chinese S5Max scripts suitable for 20–30 second voiceover.
- Context: `短视频S5max.csv` contains approved product claims and many complete script groups.
- Required skills: `ponytail` for minimal copy changes.
- May read: CSV, approved specs, existing voice text.
- May write: only `work/s5max-30-unique/scripts.json` and `work/s5max-30-unique/copy-editor-result.md`.
- Must do: choose 30 complete groups; preserve factual claims; split each into sentence units; add a non-identical CTA when source has one; create TTS text and readable subtitle text.
- Must not do: invent prices, guarantees, certifications, or unsupported product specs.
- Deliverables: JSON with id/title/sentences/ttsText/subtitleText/cta and uniqueness evidence.
- Acceptance: exactly 30 entries; all full-text hashes unique; each has 4–10 sentence units and estimated 20–30 seconds.
- Stop conditions: fewer than 30 complete factual groups or unsupported claims.

### PIPELINE_ENGINEER

- Role and tier: Executor, Tier E
- Objective: Build a tested Python stdlib/FFmpeg batch renderer consuming the two JSON contracts.
- Context: output must be 1080x1920, 30fps, H.264/yuv420p/AAC; macOS `say` is the local voice fallback.
- Required skills: `ponytail`, `test-driven-development`.
- May read: approved spec, existing FFmpeg/voice commands, material and script JSON when available.
- May write: only `scripts/s5max-30-render.py`, `scripts/test_s5max-30-render.py`, and `work/s5max-30-unique/pipeline-result.md`.
- Must do: implement deterministic dry-run/execute modes; generate voice audio, concatenate/trims, burn subtitles, mux AAC, and emit manifest; add tests for uniqueness, path safety, 30fps/1080x1920 contract, and non-overlap.
- Must not do: modify Remotion components, change shared props contracts, or hide failed renders.
- Deliverables: runnable script, tests, command examples, and failure logs if environment blocks execution.
- Acceptance: unit tests pass; dry-run creates 30 command plans; execute mode fails loudly per item and never labels failed files complete.
- Stop conditions: missing ffmpeg/say, no material/script contract, or requirement to add dependencies.

## Integration order

1. Lead validates task-book and baseline.
2. Material and copy contracts are reviewed for exact counts and uniqueness.
3. Pipeline code is reviewed against both contracts and tests run.
4. Lead runs the 30-item batch, repairs only integration defects.
5. Lead runs full ffprobe/decode/audio/difference QC and publishes verdict.

## Acceptance matrix

| Requirement | Owner | Verification | Evidence | Status |
| --- | --- | --- | --- | --- |
| 30 scripts are distinct and factual | COPY_EDITOR | JSON count/hash/claim review | scripts.json + result | PENDING |
| 30 shot orders are distinct | MATERIAL_SCOUT | order hash/count/path check | material-matrix.json + result | PENDING |
| Pipeline is deterministic and tested | PIPELINE_ENGINEER | Python test command | test output | PENDING |
| 30 MP4 files exist and are not copies | PROJECT_LEAD | count + SHA-256 uniqueness | output manifest | PENDING |
| Every MP4 has video and non-silent AAC | PROJECT_LEAD | ffprobe + volumedetect | QC report | PENDING |
| Every MP4 decodes fully | PROJECT_LEAD | ffmpeg null decode | QC report | PENDING |

