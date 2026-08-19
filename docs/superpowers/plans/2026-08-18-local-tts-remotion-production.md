# Local TTS Remotion Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make raw user copy the only required user input, then let Codex autonomously select SMB footage and produce one sentence-aligned IndexTTS 2.5 + Remotion MP4.

**Architecture:** Codex performs the semantic work and writes one auditable internal plan. A shared plain-JavaScript contract validates that plan and derives the voice-clock timeline. A thin Node CLI reuses the existing catalog, proxy, local Python TTS worker, Remotion CLI, and QC helpers. Remotion alone renders the final MP4; FFmpeg only prepares selected proxies and verifies the result.

**Tech Stack:** Node.js ESM and built-in `node:test`, Python stdlib and local IndexTTS 2.5, React 19, Remotion 4.0.496, FFmpeg/ffprobe, existing SMB asset catalog.

**Global Constraints:** Preserve every existing `out/` and `work/` artifact. Keep SMB read-only. Do not add dependencies, remote TTS, fallback voice engines, databases, queues, or a web UI. Do not commit, stash, reset, clean, push, or create a PR. Each implementation task runs in a fresh agent session and is independently reviewed before the next task. The real parity render must pass before legacy source or docs are deleted.

---

## Internal production contract

The user never writes this JSON. Codex creates it after reading the copy, searching the catalog, and visually inspecting contact sheets:

```json
{
  "schemaVersion": 1,
  "id": "s5max-01-remotion",
  "title": "七夕天天用的五刀头",
  "sourceText": "完整用户原文",
  "catalogPath": "work/asset-library/catalog.json",
  "voice": {
    "promptPath": "work/indextts2-s5max/voice_03.wav",
    "durationFactor": 1
  },
  "sentences": [
    {
      "id": "sentence-01",
      "text": "用户原句。",
      "ttsText": "只为发音调整的等义文本。",
      "shot": {
        "sourceId": "catalog-asset-id",
        "sourceInSeconds": 0,
        "sourceOutSeconds": 6,
        "fit": "cover",
        "focusX": 0.5,
        "focusY": 0.5
      }
    }
  ]
}
```

The derived Remotion Props contain fixed `width: 1080`, `height: 1920`, `fps: 30`, the exact `durationInFrames`, and for each sentence: original `text`, `ttsText`, public-dir-relative `wavPath`, public-dir-relative `proxyPath`, measured `wavDurationSeconds`, `startFrame`, `voiceFrames`, `pauseFrames`, and the selected source range/focus. The source plan never contains a user-authored timeline or public proxy mapping.

## Task 1: One cross-runtime contract and timing clock

**Owner:** `CONTRACT_EXECUTOR` using a fresh `gpt-5.6-sol` / low session.  
**Files:**

- Create: `packages/remotion-video/src/production-contract.js`
- Create: `scripts/production-contract.test.mjs`
- Modify: `packages/remotion-video/tsconfig.json`
- Report: `work/agent-results/task-contract-report.md`

**Step 1 — RED:** Add `node:test` cases that import the real contract module and prove all of these fail before implementation:

- raw copy reconstructed from `sentences[].text` after whitespace normalization must equal `sourceText` exactly;
- one sentence has no trailing pause; two sentences give only the first sentence five pause frames;
- `voiceFrames = max(1, ceil(durationSeconds * 30))` for valid positive finite durations;
- zero, negative, `NaN`, and infinite durations fail;
- sentence IDs and source IDs are non-empty, sentence IDs are unique, and `ttsText` is non-empty;
- plan paths reject URLs; `catalogPath` and `voice.promptPath` are non-empty local paths;
- derived `wavPath` and `proxyPath` are strict public-dir relative POSIX paths and reject absolute paths, backslashes, `.`/`..`, `public/`, and URLs;
- each source trim satisfies `round(out * 30) - round(in * 30) >= voiceFrames`;
- derived sentence frame ranges are contiguous and total exactly `durationInFrames`;
- `subtitleOpacityAt()` is finite for 1–16 frame subtitles and equals 1 for a one-frame subtitle.

Run:

```bash
node --test scripts/production-contract.test.mjs
```

Expected RED: module-not-found or missing-export failures for the new contract.

**Step 2 — GREEN:** Implement the minimum shared ESM module using JSDoc types and no dependency. Export only:

```js
export const validateProductionPlan = (value) => value;
export const buildProductionProps = ({plan, audio, proxies}) => props;
export const validateProductionProps = (value) => value;
export const subtitleOpacityAt = (frame, startFrame, endFrame) => opacity;
```

`audio` is a map keyed by sentence ID with `{wavPath, durationInSeconds, sha256}`. `proxies` is a map keyed by source ID with `{proxyPath}`. Validation must reject extra top-level or sentence fields so there is only one schema. It must not validate file existence; filesystem checks belong to the CLI boundary.

Enable `allowJs` and `checkJs` in `packages/remotion-video/tsconfig.json`, and include `src/**/*.js`, so the same executable contract is imported by Node and the Remotion TypeScript package. Do not create a parallel TypeScript schema.

Run:

```bash
node --test scripts/production-contract.test.mjs
npm run typecheck --workspace @auto-video/remotion-video
```

**Step 3 — Self-review:** Verify the module contains no catalog I/O, child processes, React, compatibility adapters, or fixed batch count. Record RED and GREEN raw output in the task report.

## Task 1 review

Spawn a fresh `gpt-5.6-luna` / max `TASK_REVIEWER`. It may only write `work/agent-results/review-contract.md`. It must issue separate spec-compliance and code-quality verdicts. Any Critical or Important finding returns Task 1 to a new executor session.

## Task 2: Production Remotion Composition

**Owner:** `REMOTION_EXECUTOR` using a fresh `gpt-5.6-luna` / max session.  
**Files:**

- Create: `packages/remotion-video/src/production-video.tsx`
- Modify: `packages/remotion-video/src/root.tsx`
- Modify: `packages/remotion-video/src/components/subtitle-layer.tsx`
- Modify: `scripts/production-contract.test.mjs`
- Report: `work/agent-results/task-remotion-report.md`

**Step 1 — RED:** Extend the contract test with a static source inspection only where React rendering is not needed, and add a real Remotion metadata smoke fixture under a temporary public directory. The checks must prove:

- Composition ID `ProductMarketingProduction` is registered;
- metadata duration comes from validated production Props;
- every sentence video is muted;
- every sentence has local `Audio` limited to `voiceFrames`;
- video advances during speech and freezes at `voiceFrames - 1` only for pause frames;
- subtitle cues end at `startFrame + voiceFrames`, so the five pause frames have no subtitle;
- a one-frame sentence does not trigger the old non-monotonic interpolation error;
- invalid Props fail during metadata calculation.

Run:

```bash
node --test scripts/production-contract.test.mjs
```

Expected RED: production Composition is absent.

**Step 2 — GREEN:** Implement `ProductionVideo` with this installed Remotion 4.0.496 pattern:

```tsx
<Sequence from={sentence.startFrame} durationInFrames={sentence.voiceFrames + sentence.pauseFrames}>
  <Freeze frame={sentence.voiceFrames - 1} active={(frame) => frame >= sentence.voiceFrames}>
    <OffthreadVideo
      src={staticFile(sentence.shot.proxyPath)}
      {...mediaTrimFrames({...sentence.shot, fps: props.fps})}
      muted
    />
  </Freeze>
  <Audio src={staticFile(sentence.wavPath)} trimAfter={sentence.voiceFrames} />
</Sequence>
```

Keep `Freeze` around video only. Do not use `premountFor`, `playbackRate`, loops, `atempo`, source audio, or a second render pass. Reuse `mediaTrimFrames`. Use the existing subtitle panel styling, but replace its unsafe fixed four-point interpolation with `subtitleOpacityAt()` so durations of 1–16 frames are valid. Use one local constant brand theme; do not add a theming abstraction.

Register `ProductMarketingProduction` alongside legacy compositions until parity passes. Its `calculateMetadata` must call `validateProductionProps()` and return exactly the validated dimensions, fps, and duration.

Run:

```bash
node --test scripts/production-contract.test.mjs
npm run typecheck --workspace @auto-video/remotion-video
node_modules/.bin/remotion compositions packages/remotion-video/src/index.ts
```

**Step 3 — Self-review:** Confirm every `OffthreadVideo` is muted, `Audio` uses `staticFile()` with a relative path, and subtitles are absent in pause frames. Record raw evidence.

## Task 2 review

Spawn a fresh `gpt-5.6-sol` / low reviewer. It may only write `work/agent-results/review-remotion.md`. Critical or Important findings must be fixed by a new executor session and re-reviewed.

## Task 3: Per-sentence IndexTTS 2.5 cache

**Owner:** `PIPELINE_EXECUTOR` using a fresh `gpt-5.6-sol` / low session for this isolated Python change.  
**Files:**

- Modify: `scripts/indextts25-batch.py`
- Modify: `scripts/test_indextts25_batch.py`
- Report: `work/agent-results/task-tts-cache-report.md`

**Step 1 — RED:** Replace the whole-batch cache expectation with tests proving:

- output filenames are content-addressed;
- the key includes engine version, language, model config hash, voice hash, text, and duration factor;
- changing one sentence regenerates only that sentence and reuses unchanged WAVs;
- reordering sentences reuses both WAVs;
- a corrupt cached WAV is regenerated;
- any missing sentence still causes only one model construction for that invocation;
- manifest items retain line, text, duration factor, content key, output path, SHA-256, and status.

Run:

```bash
python3 -m unittest scripts/test_indextts25_batch.py
```

Expected RED: current batch SHA invalidates every indexed output.

**Step 2 — GREEN:** Remove `can_resume` and fixed numbered output names. Compute one SHA-256 key per task and write `<output-prefix>-<content-key>.wav`. Load the model once only when at least one target WAV is missing, invalid, or forced. Keep partial-WAV generation and validation. Keep `batchSha256` in the manifest only as audit metadata; never use it as the cache gate. No new Python package.

Run:

```bash
python3 -m unittest scripts/test_indextts25_batch.py scripts/test_s5max-30-render.py scripts/test_s5max-indextts2-replace.py
```

**Step 3 — Self-review:** Confirm unchanged content cannot be overwritten during ordinary production and URL rejection still runs before filesystem access.

## Task 3 review

Spawn a fresh `gpt-5.6-luna` / max reviewer. It may only write `work/agent-results/review-tts-cache.md`.

## Task 4: Thin local production entry

**Owner:** `PIPELINE_EXECUTOR` using a new fresh `gpt-5.6-luna` / max session.  
**Files:**

- Create: `scripts/produce.mjs`
- Create: `scripts/produce.test.mjs`
- Modify: `scripts/lib/render-qc.mjs`
- Modify: `scripts/lib/render-qc.test.mjs`
- Modify: `package.json`
- Report: `work/agent-results/task-pipeline-report.md`

**Step 1 — RED:** Add Node tests with temporary directories and one `execFileImpl` seam. Cover:

- CLI accepts only `--plan`, plus optional local `--model-dir`, `--python`, and `--out-dir`; defaults point to the installed local IndexTTS 2.5 paths and `out/production`;
- plan and catalog are UTF-8 JSON; catalog `sourceId` and exact selected range must exist and be valid;
- model, prompt WAV, catalog, and every selected SMB source reject URLs, symlinks, missing paths, and non-files;
- only selected catalog sources are proxied with the existing `proxyArgs()` helper;
- TTS JSONL uses every `ttsText` in order and calls `indextts25-batch.py` once with the exact count;
- WAVs are probed and staged into `work/production/<id>/public/audio/` without a remote or silent fallback;
- proxies are written only into `work/production/<id>/public/proxies/` and SMB is never written;
- Props come from the shared contract, are atomically written, and are validated through Remotion `compositions`;
- render uses `ProductMarketingProduction`, H.264, yuv420p, bt709, AAC, `--enforce-audio-track`, and `--overwrite=false` to a `.partial.mp4`;
- QC requires 1080×1920, exactly 30fps, exact frame count, AAC mono, non-silent audio, full FFmpeg decode, and a valid final contact sheet;
- final MP4 appears only after QC; existing final or partial files fail;
- final manifest records plan/source text, every sentence text/ttsText/source/WAV/frame range/hash, Remotion command, IndexTTS engine/version, voice hash, output hash, and QC data;
- arbitrary sentence counts work and no 20–40 second limit remains.

Run:

```bash
node --test scripts/produce.test.mjs scripts/lib/render-qc.test.mjs
```

Expected RED: `scripts/produce.mjs` is missing and old QC rejects durations outside 20–40 seconds.

**Step 2 — GREEN:** Implement one sequential `runProduction(options, {execFileImpl})` and a small CLI wrapper. Reuse rather than copy:

- `readJson`, `writeJsonAtomic`, `assertDescendant`, and safe directory ideas from `scripts/lib/job.mjs`;
- `proxyArgs` and `assertProxyProbeJson` from `scripts/lib/prepare-media.mjs`;
- `renderJob`, Remotion command construction, props hashing, partial protection, and contact-sheet generation from `scripts/lib/render-qc.mjs`;
- `buildProductionProps` from the shared production contract.

The production order is fixed:

```text
validate plan/catalog/paths
  -> create work/public directories
  -> prepare only selected proxies
  -> write one JSONL and invoke local IndexTTS 2.5 once
  -> probe/stage sentence WAVs
  -> build/write/Remotion-validate Props
  -> Remotion render partial
  -> ffprobe + mono/non-silence + full decode + contact sheet
  -> rename partial to final
  -> write manifest atomically
```

Use existing stdlib and dependencies. A hard link may be attempted for cached WAVs, with `copyFile` only for the cross-device fallback. Never symlink. Do not expose `--force` from the production CLI. Deduplicate proxy preparation by `sourceId`.

Generalize `assertQcMetadata()` to accept production `durationInFrames`, remove the old duration band, and require `channels === 1`. Add one FFmpeg `volumedetect` check and reject `max_volume: -inf dB` or a maximum at/below -60 dB. Keep the separate full null decode.

Add:

```json
"produce": "node scripts/produce.mjs"
```

Run:

```bash
node --test scripts/produce.test.mjs scripts/production-contract.test.mjs scripts/lib/render-qc.test.mjs
python3 -m unittest scripts/test_indextts25_batch.py
npm run typecheck
```

**Step 3 — Self-review:** Search the new path for `http`, `edge-tts`, `say`, `atempo`, fixed `30`-item assumptions, and FFmpeg final encoding. Only local path rejection messages and the required 30fps constant may match.

## Task 4 review

Spawn a fresh `gpt-5.6-sol` / low reviewer. It may only write `work/agent-results/review-pipeline.md`.

## Task 5: Raw-copy autonomous Codex workflow

**Owner:** `WORKFLOW_EXECUTOR` using a fresh `gpt-5.6-sol` / low session.  
**Files:**

- Modify: `skills/auto-edit-product-video/SKILL.md`
- Replace: `skills/auto-edit-product-video/references/timeline-contract.md` with `skills/auto-edit-product-video/references/production-plan-contract.md`
- Create: `scripts/skill-contract.test.mjs`
- Modify: `package.json`
- Report: `work/agent-results/task-workflow-report.md`

**Step 1 — RED:** Add one stdlib test that reads the actual skill and requires this exact behavior:

- the user's only required input is raw copy;
- Codex preserves full original text, makes semantic sentences, and creates pronunciation-only `ttsText`;
- Codex runs local asset search, reads matching catalog records, and visually opens contact/CTA sheets before choosing;
- each sentence gets a verified product/source range and the internal plan is written by Codex;
- the skill calls `npm run produce -- --plan <internal-plan>`;
- it stops with a concrete material gap if product identity or matching visual evidence is absent;
- it never asks the user for JSON, a timeline, or shot mapping;
- obsolete silent-review, approval-gate, fixed-duration, demo, Edge TTS, and macOS `say` guidance is absent.

Run:

```bash
node --test scripts/skill-contract.test.mjs
```

Expected RED: the current skill describes a silent two-pass review draft.

**Step 2 — GREEN:** Rewrite the project skill as the production playbook, not an AI service. Keep these seven steps only:

1. preserve the complete user copy and identify product/claims from conversation;
2. split semantically and create pronunciation-only `ttsText` without changing subtitle text;
3. search `work/asset-library/catalog.json` with the existing asset CLI;
4. inspect candidate `contactSheetPath` and `ctaSheetPath` images, then choose per-sentence source ranges;
5. write the internal plan against the one reference contract;
6. run the production command and inspect manifest/contact sheet/output;
7. report the final MP4 or the exact missing-material blocker.

The skill must say that the internal plan is Codex's audit artifact, never user input. Do not add a user approval stage unless the user explicitly asks to review a draft.

Add the skill test to `test:auto-edit` temporarily so the full pre-cleanup suite exercises it.

Run:

```bash
node --test scripts/skill-contract.test.mjs
npm run test:auto-edit
```

The known Node 26 Chromium `Target.closeTarget` failure may be reported only if it reproduces unchanged in the legacy Remotion integration test; all new tests must pass.

## Task 5 review

Spawn a fresh `gpt-5.6-luna` / max reviewer. It may only write `work/agent-results/review-workflow.md`.

## Task 6: Real `s5max-01` parity production

**Owner:** `PROJECT_LEAD`; no cleanup agent may start before APPROVE.  
**Artifacts only; never overwrite existing files:**

- Create: `work/production-plans/s5max-01-remotion.json`
- Create under: `work/production/s5max-01-remotion/`
- Create: `out/production/s5max-01-remotion.mp4`
- Create: `work/agent-results/s5max-01-parity-report.md`

**Step 1 — Autonomous plan:** Treat `work/s5max-30-unique/scripts.json` only as the captured raw copy source. Reconstruct `sourceText`, re-evaluate semantic sentence boundaries, search the current SMB catalog for the product and each selling point, and open the selected contact/CTA sheets with the local image viewer. Existing material matrices are hints, not accepted without visual confirmation. Write the internal plan yourself; do not ask the user for a mapping.

**Step 2 — Real local production:** Use the installed paths:

```bash
npm run produce -- \
  --plan work/production-plans/s5max-01-remotion.json \
  --python work/indextts25/index-tts/.venv/bin/python \
  --model-dir work/indextts25/index-tts/checkpoints \
  --out-dir out/production
```

Do not reuse old IndexTTS 2.0 sentence WAVs as production output. The selected `voice_03.wav` may remain the reference voice input.

**Step 3 — Evidence:** Independently run ffprobe, full FFmpeg null decode, and SHA-256. Compare the new final-cut contact sheet and representative start/middle/end frames with `out/s5max-30-smb-unique-indextts2/s5max-01.mp4`. Check every manifest sentence has one WAV, one SMB source, contiguous voice/pause frames, literal subtitle text, and exact five-frame non-final pauses. Record APPROVE/BLOCK and exact commands/results.

## Task 7: Remove superseded source and docs after parity

**Owner:** `CLEANUP_EXECUTOR` using a fresh `gpt-5.6-luna` / max session.  
**Precondition:** `work/agent-results/s5max-01-parity-report.md` says APPROVE and the new MP4 exists.  
**Source/docs only; all generated artifacts stay:**

- Delete source/config under `apps/web/` but preserve `apps/web/dist/`.
- Delete: `packages/shared/`
- Delete: `packages/core/`
- Delete legacy Remotion source: `packages/remotion-video/src/product-marketing-real.tsx`, `packages/remotion-video/src/product-marketing-video.tsx`, `packages/remotion-video/src/components/placeholder-scene.tsx`
- Delete: `scripts/auto-edit.mjs`, `scripts/auto-edit.test.mjs`
- Delete: `scripts/s5max-30-render.py`, `scripts/test_s5max-30-render.py`
- Delete: `scripts/s5max-indextts2-replace.py`, `scripts/test_s5max-indextts2-replace.py`
- Delete or reduce old-only code/tests in `scripts/lib/job.mjs`, `scripts/lib/job.test.mjs`, `scripts/lib/render-qc.mjs`, and `scripts/lib/render-qc.test.mjs`; retain only helpers actually imported by asset-library or `produce.mjs`.
- Delete obsolete design specs dated 2026-08-06 through 2026-08-17 after confirming the current design/implementation plan covers their still-live requirements.
- Delete: `docs/DEFERRED_CAPABILITIES.md`
- Rewrite: `docs/PROJECT_PLAN.md` as a short current production README.
- Modify: root `package.json`, `package-lock.json`, `packages/remotion-video/package.json`, `packages/remotion-video/src/root.tsx`, and imports so only the production Composition plus contact-sheet Stills remain.
- Pin installed runtime versions exactly: React/ReactDOM `19.2.8`, Remotion CLI/runtime `4.0.496`; add no dependency.
- Report: `work/agent-results/task-cleanup-report.md`

**Step 1 — Reference proof:** Before deletion, run `rg` for every target export/script/workspace and list all live callers. If a live production or asset-library caller remains, move only that leaf helper first and retest.

**Step 2 — Delete:** Use patch-based file deletions. Never touch `out/`, `work/`, `apps/web/dist/`, SMB, current design/plan/task book, production skill, production CLI, TTS worker, asset library, production Remotion files, or new tests.

**Step 3 — Package cleanup:** Reduce the root workspaces to `packages/remotion-video`; remove `dev`, `build`, `render:demo`, and `auto:edit`; keep `studio`, `produce`, `asset-library`, `typecheck`, and one test command that includes every retained Node test. Update the lockfile without downloading or upgrading packages.

**Step 4 — Regression:** Run:

```bash
python3 -m unittest scripts/test_indextts25_batch.py
node --test scripts/*.test.mjs scripts/lib/*.test.mjs
npm run typecheck
node_modules/.bin/remotion compositions packages/remotion-video/src/index.ts
git diff --check
```

Confirm only `ProductMarketingProduction`, `MediaContactSheet`, and `MediaImageContactSheet` remain. Confirm searches for `edge-tts`, macOS `say`, `atempo`, `ProductMarketingDemo`, `ProductMarketingReal`, `@auto-video/core`, and `@auto-video/shared` return no live source hits.

**Step 5 — Metrics:** Report source/doc files and lines before/after, dependencies removed, artifact inventory unchanged, and every raw test result.

## Task 7 review

Spawn a fresh `gpt-5.6-sol` / low reviewer. It may only write `work/agent-results/review-cleanup.md`. Critical or Important findings require a new cleanup executor session and repeat review.

## Task 8: Integration verification and mandatory Sol xhigh acceptance

**Owner:** `PROJECT_LEAD` then independent `FINAL_REVIEWER`.  
**Report:** `work/agent-results/integration-verification.md` and `work/agent-results/final-review-sol-xhigh.md`.

The lead reruns every retained test, typecheck, Remotion composition listing, real output ffprobe/full decode/audio-volume check, output/accepted-final inventories, and duplicate-renderer/remote-TTS searches from a clean command invocation. The lead maps each design acceptance item to an exact file, artifact, or command result.

Then spawn a brand-new `gpt-5.6-sol` session with `reasoning_effort=xhigh` and `fork_turns=none`. It is source-read-only and must read the design, this plan, task book, all task reports, actual source, manifests, parity output metadata, and current diff. It must independently verify:

- raw copy is the only user-required input;
- Codex, not the user or a fake deterministic heuristic, performs semantic selection;
- every sentence is voiced locally with IndexTTS 2.5 and aligned to subtitle/shot frames;
- Remotion is the only final renderer;
- five-frame pauses and final zero pause are exact;
- SMB is read-only and selected shots are visually evidenced;
- old paths are gone while every artifact is preserved;
- all retained tests pass, with no uninvestigated waiver.

The reviewer writes findings first, labels them Critical/Important/Minor, and ends with exactly `VERDICT: APPROVE` or `VERDICT: BLOCK`. Only APPROVE completes the work.
