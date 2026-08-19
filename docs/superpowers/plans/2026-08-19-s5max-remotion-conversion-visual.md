# S5Max Remotion Conversion Visual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a backward-compatible, evidence-first Remotion visual and sound layer, then render one S5Max visual A/B candidate with the existing 694-frame timeline, copy, TTS, and footage.

**Architecture:** Keep `ProductionVideo`, TTS-derived frame timing, local proxies, and one-pass Remotion rendering. Add optional per-sentence visual intent, deterministic phrase captions, two small visual components, and one sound component. Stage a fixed, licensed audio pack into each enhanced job and extend existing QC instead of creating a second production path.

**Tech Stack:** Node.js 20+ ESM, built-in `node:test`, React 19, Remotion 4.0.496, TypeScript 5.9, FFmpeg/ffprobe, existing production CLI and contact-sheet Composition.

## Global Constraints

- Output remains exactly 1080×1920, 30 fps, H.264/yuv420p video, mono AAC audio.
- Use only existing S5Max video footage; no new shooting, AI images, fake before/after, 3D, WebGL, particles, or additional runtime dependencies.
- Preserve the existing one-pass Remotion encode, TTS clock, five-frame inter-sentence pauses, read-only SMB behavior, partial-output protection, and final QC publication order.
- Existing v1 plans and Props without `visual` must validate and render with the current visual and audio behavior, including the current Arial subtitle font and TTS gain 1.
- Enhanced visuals use `PingFang SC`, white `#FFFFFF`, problem yellow `#FFD84D`, result green `#57E389`, and critical-text safe zone `{left: 72, right: 200, top: 160, bottom: 530}` in 1080×1920 coordinates.
- Hook motion lasts 5–8 frames; keyword emphasis peaks at 106%; shot scale changes stay between 3% and 8%; no enhanced shot gets more than one primary overlay.
- Enhanced TTS gain is `0.82`; BGM base gain is `0.08` and ducks by 5 dB during speech; final enhanced output must be audible and have `max_volume <= -1.0 dB`.
- Audio files must match the SHA-256 values in the licensed source manifest before staging. Production never downloads media from the internet.
- `PingFang SC` must be reported as enabled and valid by macOS font inventory before any enhanced TTS or render begins; do not silently fall back.
- First experiment keeps the exact current copy, TTS, footage set, and 694-frame video timeline (23.133 seconds at 30 fps; the current AAC-padded MP4 container is 23.189 seconds). Do not create the 18-second copy variant in this implementation.
- The optional motor SFX is CC-BY 3.0. Preserve its exact attribution in the source manifest; if a later job stages it, include `Electric Razor SFX by Vinrax, CC-BY 3.0` with that published post or campaign asset record. The first A/B job does not use this sound.
- Do not overwrite any existing `work/` or `out/` artifact. Use the new job ID `s5max-01-remotion-visual`.
- Preserve all unrelated dirty-worktree changes. Every commit stages only the files named by its task.

---

## File Map

**Create:**

- `packages/remotion-video/src/visual-timing.js` — deterministic phrase timing and shared Douyin safe-zone constants.
- `packages/remotion-video/src/audio-design.js` — pure gain, ducking, and SFX timing functions.
- `packages/remotion-video/src/components/visual-theme.ts` — one fixed visual theme.
- `packages/remotion-video/src/components/shot-layer.tsx` — crop, push-in, and local contrast treatment.
- `packages/remotion-video/src/components/overlay-layer.tsx` — Hook, proof, feature, and CTA variants.
- `packages/remotion-video/src/components/sound-bed.tsx` — fixed BGM and per-sentence SFX playback.
- `scripts/visual-timing.test.mjs` — phrase and safe-zone tests.
- `scripts/audio-design.test.mjs` — gain and SFX timing tests.
- `assets/audio/s5max/sources.json` — source, author, license, filename, and SHA-256 records.
- `assets/audio/s5max/SHA256SUMS` — integrity list for the six binary audio assets.
- Six licensed files under `assets/audio/s5max/` as named in Task 4.
- Local, ignored execution input: `work/production-plans/s5max-01-remotion-visual.json`.

**Modify:**

- `packages/remotion-video/src/production-contract.js` — validate and propagate optional visual intent.
- `packages/remotion-video/src/production-video.tsx` — wire phrase cues, visual layers, and sound bed.
- `packages/remotion-video/src/components/subtitle-layer.tsx` — preserve legacy subtitles and add enhanced phrase styling.
- `packages/remotion-video/src/contact-sheet.tsx` — optional safe-zone guide on QA contact sheets.
- `packages/remotion-video/src/root.tsx` — add the optional contact-sheet prop to default Props.
- `scripts/production-contract.test.mjs` — visual contract and Composition wiring tests.
- `scripts/produce.mjs` — verify/stage licensed audio, record it in the manifest, and request enhanced QA frames.
- `scripts/produce.test.mjs` — audio staging, tamper rejection, manifest, and safe-zone tests.
- `scripts/lib/render-qc.mjs` — parse mean/max volume and enforce enhanced headroom.
- `scripts/lib/render-qc.test.mjs` — volume-analysis and headroom tests.

---

### Task 1: Backward-Compatible Visual Intent Contract

**Files:**

- Modify: `packages/remotion-video/src/production-contract.js:2-7,20-32,105-200`
- Modify: `scripts/production-contract.test.mjs:9-153`

**Interfaces:**

- Consumes: existing `validateProductionPlan(value)`, `buildProductionProps({plan,audio,proxies})`, and `validateProductionProps(value)`.
- Produces: optional `sentence.visual` with exact type `{role, emphasis?, label?, sfx?}` preserved from plan to derived Props.

- [ ] **Step 1: Write failing visual-contract tests**

Add these cases to `scripts/production-contract.test.mjs`:

```js
test("visual intent is optional and survives derived Props", () => {
  const legacy = plan();
  assert.doesNotThrow(() => validateProductionPlan(legacy));
  assert.equal(buildProductionProps(inputs(legacy)).sentences[0].visual, undefined);

  const enhancedSentence = {
    ...sentence(),
    visual: {role: "proof", emphasis: "文案", label: "贴面刀路", sfx: "motor"},
  };
  const enhanced = plan([enhancedSentence]);
  const props = buildProductionProps(inputs(enhanced));
  assert.deepEqual(props.sentences[0].visual, enhancedSentence.visual);
  assert.doesNotThrow(() => validateProductionProps(props));
});

test("visual intent rejects unknown fields, values, and untraceable emphasis", () => {
  const invalid = [
    {role: "unknown"},
    {role: "hook", extra: true},
    {role: "hook", label: ""},
    {role: "hook", label: "超过十八个Unicode字符的标签一定会被拒绝掉"},
    {role: "hook", emphasis: "不存在"},
    {role: "hook", sfx: "explosion"},
  ];
  for (const visual of invalid) {
    assert.throws(() => validateProductionPlan(plan([{...sentence(), visual}])));
  }
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
node --test scripts/production-contract.test.mjs
```

Expected: FAIL because `visual` is currently an unknown sentence field.

- [ ] **Step 3: Implement the minimum validator and propagation**

In `production-contract.js`, extend the field lists and add one validator:

```js
const SENTENCE_FIELDS = ["id", "text", "ttsText", "visual", "shot"];
const DERIVED_SENTENCE_FIELDS = [
  "id", "text", "ttsText", "wavPath", "wavDurationSeconds", "wavSha256",
  "startFrame", "voiceFrames", "pauseFrames", "visual", "shot",
];
const VISUAL_FIELDS = ["role", "emphasis", "label", "sfx"];
const VISUAL_ROLES = new Set(["hook", "proof", "feature", "cta"]);
const VISUAL_SFX = new Set(["impact", "motor", "water", "usb", "cta"]);

/**
 * @typedef {object} VisualIntent
 * @property {"hook"|"proof"|"feature"|"cta"} role
 * @property {string} [emphasis]
 * @property {string} [label]
 * @property {"impact"|"motor"|"water"|"usb"|"cta"} [sfx]
 */

const validateVisual = (visual, sentenceText, name) => {
  if (visual === undefined) return;
  strict(visual, VISUAL_FIELDS, name);
  if (!VISUAL_ROLES.has(visual.role)) fail(`${name}.role is invalid`);
  if (visual.label !== undefined) {
    text(visual.label, `${name}.label`);
    if (Array.from(visual.label).length > 18) fail(`${name}.label must be at most 18 Unicode characters`);
  }
  if (visual.emphasis !== undefined) {
    text(visual.emphasis, `${name}.emphasis`);
    if (!sentenceText.includes(visual.emphasis) && !visual.label?.includes(visual.emphasis)) {
      fail(`${name}.emphasis must occur in text or label`);
    }
  }
  if (visual.sfx !== undefined && !VISUAL_SFX.has(visual.sfx)) fail(`${name}.sfx is invalid`);
};
```

Call `validateVisual(sentence.visual, sentence.text, `${name}.visual`)` in both plan and derived-Props loops. Preserve the value without inventing defaults:

```js
const derived = {
  id: sentence.id,
  text: sentence.text,
  ttsText: sentence.ttsText,
  wavPath: item.wavPath,
  wavDurationSeconds: item.durationInSeconds,
  wavSha256: item.sha256,
  startFrame,
  voiceFrames,
  pauseFrames,
  ...(sentence.visual === undefined ? {} : {visual: {...sentence.visual}}),
  shot: {...sentence.shot, proxyPath: proxy.proxyPath},
};
```

Add `@property {VisualIntent} [visual]` to the sentence JSDoc type.

- [ ] **Step 4: Run contract and type checks**

Run:

```bash
node --test scripts/production-contract.test.mjs
npm run typecheck --workspace @auto-video/remotion-video
```

Expected: exit 0; all contract subtests and TypeScript checks pass.

- [ ] **Step 5: Commit only the contract task**

```bash
git add packages/remotion-video/src/production-contract.js scripts/production-contract.test.mjs
git commit -m "feat: validate production visual intent"
```

---

### Task 2: Deterministic Phrase Captions

**Files:**

- Create: `packages/remotion-video/src/visual-timing.js`
- Create: `scripts/visual-timing.test.mjs`
- Modify: `packages/remotion-video/src/components/subtitle-layer.tsx:1-64`
- Modify: `packages/remotion-video/src/production-video.tsx:1-21,47`
- Modify: `scripts/production-contract.test.mjs:155-170`

**Interfaces:**

- Consumes: `ProductionProps["sentences"][number]` from Task 1.
- Produces: `captionCuesForSentence(sentence)` returning `{id,text,startFrame,endFrame,legacy,role,emphasis}` cues; `DOUYIN_SAFE_ZONE` for later tasks.

- [ ] **Step 1: Write failing timing tests**

Create `scripts/visual-timing.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {captionCuesForSentence, DOUYIN_SAFE_ZONE, splitCaptionText} from "../packages/remotion-video/src/visual-timing.js";

test("legacy sentences keep one full-sentence cue", () => {
  const cues = captionCuesForSentence({id: "s1", text: "完整旧字幕。", startFrame: 10, voiceFrames: 20});
  assert.deepEqual(cues, [{id: "s1-caption-1", text: "完整旧字幕。", startFrame: 10, endFrame: 30, legacy: true, role: null, emphasis: null}]);
});

test("enhanced captions preserve text and exactly cover voice frames", () => {
  const sentence = {
    id: "s1",
    text: "关键是Type-C充电，出差不用额外带线，省心。",
    startFrame: 20,
    voiceFrames: 67,
    visual: {role: "feature", emphasis: "Type-C"},
  };
  const cues = captionCuesForSentence(sentence);
  assert.equal(cues.map(({text}) => text).join(""), sentence.text);
  assert.equal(cues[0].startFrame, 20);
  assert.equal(cues.at(-1).endFrame, 87);
  assert.ok(cues.every((cue, index) => cue.endFrame > cue.startFrame && (index === 0 || cues[index - 1].endFrame === cue.startFrame)));
  assert.equal(cues.filter(({emphasis}) => emphasis === "Type-C").length, 1);
});

test("one-frame enhanced speech remains one valid cue", () => {
  const cues = captionCuesForSentence({id: "s1", text: "好", startFrame: 5, voiceFrames: 1, visual: {role: "hook"}});
  assert.equal(cues.length, 1);
  assert.deepEqual([cues[0].startFrame, cues[0].endFrame], [5, 6]);
});

test("label-only emphasis is left to the overlay", () => {
  const cues = captionCuesForSentence({id: "s1", text: "普通字幕", startFrame: 0, voiceFrames: 10, visual: {role: "feature", label: "刀头结构", emphasis: "刀头"}});
  assert.equal(cues[0].emphasis, null);
});

test("caption chunks and Douyin safe zone stay bounded", () => {
  assert.ok(splitCaptionText("这是超过十二个汉字并且带有标点的一整句字幕。").every((chunk) => Array.from(chunk).length <= 12));
  assert.deepEqual(DOUYIN_SAFE_ZONE, {left: 72, right: 200, top: 160, bottom: 530});
});
```

- [ ] **Step 2: Run timing tests and confirm RED**

Run:

```bash
node --test scripts/visual-timing.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `visual-timing.js`.

- [ ] **Step 3: Implement phrase splitting and frame allocation**

Create `packages/remotion-video/src/visual-timing.js`:

```js
export const DOUYIN_SAFE_ZONE = Object.freeze({left: 72, right: 200, top: 160, bottom: 530});

const MIN_CHARS = 7;
const MAX_CHARS = 12;
const PUNCTUATION = /[，。！？；：,.!?;:、]/u;
const chars = (value) => Array.from(value);
const weight = (value) => Math.max(1, chars(value).filter((character) => !/\s/u.test(character)).length);
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export const splitCaptionText = (text) => {
  if (typeof text !== "string" || text.length === 0) throw new TypeError("caption text must be non-empty");
  if (chars(text).length <= MAX_CHARS) return [text];
  const chunks = [];
  let current = "";
  for (const character of chars(text)) {
    current += character;
    const length = chars(current).length;
    if (length >= MAX_CHARS || (length >= MIN_CHARS && PUNCTUATION.test(character))) {
      chunks.push(current);
      current = "";
    }
  }
  if (current.length > 0) {
    const previous = chunks.at(-1);
    if (previous && chars(previous + current).length <= MAX_CHARS) chunks[chunks.length - 1] += current;
    else chunks.push(current);
  }
  return chunks;
};

export const captionCuesForSentence = (sentence) => {
  const finalFrame = sentence.startFrame + sentence.voiceFrames;
  if (sentence.visual === undefined) {
    return [{id: `${sentence.id}-caption-1`, text: sentence.text, startFrame: sentence.startFrame, endFrame: finalFrame, legacy: true, role: null, emphasis: null}];
  }
  const captionEmphasis = sentence.visual.emphasis && sentence.text.includes(sentence.visual.emphasis) ? sentence.visual.emphasis : null;
  const chunks = splitCaptionText(sentence.text);
  while (chunks.length > sentence.voiceFrames) chunks.splice(-2, 2, chunks.at(-2) + chunks.at(-1));
  const weights = chunks.map(weight);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let cumulativeWeight = 0;
  let cursor = sentence.startFrame;
  const cues = chunks.map((text, index) => {
    cumulativeWeight += weights[index];
    const remainingChunks = chunks.length - index - 1;
    const proposed = sentence.startFrame + Math.round(sentence.voiceFrames * cumulativeWeight / totalWeight);
    const endFrame = index === chunks.length - 1 ? finalFrame : clamp(proposed, cursor + 1, finalFrame - remainingChunks);
    const cue = {
      id: `${sentence.id}-caption-${index + 1}`,
      text,
      startFrame: cursor,
      endFrame,
      legacy: false,
      role: sentence.visual.role,
      emphasis: captionEmphasis && text.includes(captionEmphasis) ? captionEmphasis : null,
    };
    cursor = endFrame;
    return cue;
  });
  if (captionEmphasis && !cues.some(({emphasis}) => emphasis === captionEmphasis)) {
    throw new TypeError(`emphasis crosses caption chunks: ${captionEmphasis}`);
  }
  return cues;
};
```

- [ ] **Step 4: Preserve legacy subtitle styling and add enhanced styling**

Update `SubtitleCue` in `subtitle-layer.tsx` with `legacy`, `role`, and `emphasis`. Keep the current JSX in a `LegacySubtitle` branch. Render enhanced cues with this exact layout:

```tsx
const emphasisIndex = cue.emphasis ? cue.text.indexOf(cue.emphasis) : -1;
const accent = cue.role === "hook" ? "#FFD84D" : "#57E389";
const content = emphasisIndex === -1 ? cue.text : <>
  {cue.text.slice(0, emphasisIndex)}
  <span style={{color: accent, display: "inline-block", transform: `scale(${1 + 0.06 * opacity})`}}>{cue.emphasis}</span>
  {cue.text.slice(emphasisIndex + cue.emphasis!.length)}
</>;

return (
  <div style={{position: "absolute", left: 72, right: 200, bottom: 530, display: "flex", justifyContent: "center", opacity, fontFamily: brand.fontFamily}}>
    <div style={{maxWidth: 808, padding: "14px 22px 16px", borderRadius: 18, background: "linear-gradient(90deg, rgba(0,0,0,0.72), rgba(0,0,0,0.28))", color: brand.text, fontSize: 60, fontWeight: 800, lineHeight: 1.18, textAlign: "center", textShadow: "0 3px 14px rgba(0,0,0,0.65)"}}>
      {content}
    </div>
  </div>
);
```

In `production-video.tsx`, replace `props.sentences.map(...)` cue construction with:

```ts
const cues: SubtitleCue[] = props.sentences.flatMap(captionCuesForSentence);
```

In `scripts/production-contract.test.mjs`, replace the old static full-sentence cue assertion:

```js
assert.match(source, /flatMap\(captionCuesForSentence\)/);
```

Do not change the existing `brand` object: its Arial font is the legacy fallback required by the compatibility contract. In the enhanced JSX above, set `fontFamily` directly to `"PingFang SC", "Microsoft YaHei", sans-serif`; Task 3 replaces that literal with the shared fixed theme.

- [ ] **Step 5: Run focused and package checks**

Run:

```bash
node --test scripts/visual-timing.test.mjs scripts/production-contract.test.mjs
npm run typecheck --workspace @auto-video/remotion-video
```

Expected: exit 0; phrase timing, legacy compatibility, Composition metadata, and type checks pass.

- [ ] **Step 6: Commit the caption task**

```bash
git add packages/remotion-video/src/visual-timing.js packages/remotion-video/src/components/subtitle-layer.tsx packages/remotion-video/src/production-video.tsx scripts/visual-timing.test.mjs scripts/production-contract.test.mjs
git commit -m "feat: add deterministic phrase captions"
```

---

### Task 3: Evidence-First Shot and Overlay Layers

**Files:**

- Create: `packages/remotion-video/src/components/visual-theme.ts`
- Create: `packages/remotion-video/src/components/shot-layer.tsx`
- Create: `packages/remotion-video/src/components/overlay-layer.tsx`
- Modify: `packages/remotion-video/src/components/subtitle-layer.tsx:1-90`
- Modify: `packages/remotion-video/src/production-video.tsx:1-49`
- Modify: `scripts/production-contract.test.mjs:155-166`

**Interfaces:**

- Consumes: `ProductionProps["sentences"][number]`, `DOUYIN_SAFE_ZONE`, and `mediaTrimFrames()`.
- Produces: `ShotLayer({sentence,fps})`, `OverlayLayer({sentence,fps})`, and fixed `visualTheme`.

- [ ] **Step 1: Add failing Composition-wiring assertions**

In `production composition uses the required sentence media clock`, replace the existing direct `<OffthreadVideo ... muted` assertion with:

```js
assert.match(source, /<ShotLayer sentence=\{sentence\} fps=\{props\.fps\}/);
assert.match(source, /<OverlayLayer sentence=\{sentence\} fps=\{props\.fps\}/);
assert.doesNotMatch(source, /<OffthreadVideo/);
```

- [ ] **Step 2: Run the Composition test and confirm RED**

Run:

```bash
node --test scripts/production-contract.test.mjs
```

Expected: FAIL because `ProductionVideo` still renders `OffthreadVideo` directly.

- [ ] **Step 3: Add the fixed theme**

Create `components/visual-theme.ts`:

```ts
export const visualTheme = {
  background: "#08100d",
  text: "#FFFFFF",
  problem: "#FFD84D",
  result: "#57E389",
  fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif',
} as const;
```

- [ ] **Step 4: Implement `ShotLayer`**

Create `components/shot-layer.tsx`:

```tsx
import {AbsoluteFill, Freeze, interpolate, OffthreadVideo, staticFile, useCurrentFrame} from "remotion";
import type {ProductionProps} from "../production-contract.js";
import {mediaTrimFrames} from "../media-trim";

type Sentence = ProductionProps["sentences"][number];
const ranges = {hook: [1.08, 1.03], proof: [1.1, 1.04], feature: [1.02, 1.08], cta: [1.03, 1]} as const;

export const ShotLayer = ({sentence, fps}: {sentence: Sentence; fps: number}) => {
  const frame = useCurrentFrame();
  const range = sentence.visual ? ranges[sentence.visual.role] : [1, 1];
  const scale = interpolate(frame, [0, Math.max(1, sentence.voiceFrames - 1)], range, {extrapolateLeft: "clamp", extrapolateRight: "clamp"});
  return <AbsoluteFill style={{overflow: "hidden"}}>
    <Freeze frame={0} active={(current) => sentence.visual?.role === "hook" && current < 8}>
      <OffthreadVideo
        src={staticFile(sentence.shot.proxyPath)}
        {...mediaTrimFrames({...sentence.shot, fps})}
        muted
        style={{width: "100%", height: "100%", objectFit: sentence.shot.fit, objectPosition: `${sentence.shot.focusX * 100}% ${sentence.shot.focusY * 100}%`, transform: `scale(${scale})`}}
      />
    </Freeze>
    {sentence.visual && <AbsoluteFill style={{background: sentence.visual.role === "hook" ? "linear-gradient(180deg, rgba(0,0,0,0.46), transparent 48%, rgba(0,0,0,0.18))" : "linear-gradient(180deg, rgba(0,0,0,0.12), transparent 40%)"}} />}
  </AbsoluteFill>;
};
```

- [ ] **Step 5: Implement `OverlayLayer`**

Create `components/overlay-layer.tsx` with one switch and no registry:

```tsx
import {spring, useCurrentFrame} from "remotion";
import type {ProductionProps} from "../production-contract.js";
import {visualTheme} from "./visual-theme";

type Sentence = ProductionProps["sentences"][number];
const base = {position: "absolute" as const, fontFamily: visualTheme.fontFamily, color: visualTheme.text, textShadow: "0 4px 18px rgba(0,0,0,0.72)"};

export const OverlayLayer = ({sentence, fps}: {sentence: Sentence; fps: number}) => {
  const frame = useCurrentFrame();
  if (!sentence.visual?.label) return null;
  const enter = spring({frame, fps, durationInFrames: 8, config: {damping: 200}});
  const motion = {opacity: enter, transform: `translateY(${(1 - enter) * 20}px) scale(${0.96 + enter * 0.04})`};
  const emphasis = sentence.visual.emphasis;
  const emphasisIndex = emphasis && sentence.visual.label.includes(emphasis) ? sentence.visual.label.indexOf(emphasis) : -1;
  const label = emphasisIndex === -1 ? sentence.visual.label : <>
    {sentence.visual.label.slice(0, emphasisIndex)}
    <span style={{color: sentence.visual.role === "hook" ? visualTheme.problem : visualTheme.result}}>{emphasis}</span>
    {sentence.visual.label.slice(emphasisIndex + emphasis!.length)}
  </>;
  if (sentence.visual.role === "hook") return <div style={{...base, ...motion, left: 72, right: 200, top: 180, fontSize: 96, fontWeight: 900, lineHeight: 1.05, whiteSpace: "pre-wrap"}}>{label}</div>;
  if (sentence.visual.role === "proof") {
    const left = Math.min(820, Math.max(120, sentence.shot.focusX * 1080));
    const top = Math.min(1220, Math.max(300, sentence.shot.focusY * 1920));
    return <div style={{...base, ...motion, left: left - 58, top: top - 58}}>
      <div style={{width: 116, height: 116, borderRadius: "50%", border: `4px solid ${visualTheme.result}`, boxShadow: "0 0 0 6px rgba(0,0,0,0.28)"}} />
      <div style={{marginTop: 14, padding: "8px 14px", borderRadius: 999, background: "rgba(0,0,0,0.68)", fontSize: 38, fontWeight: 800}}>{label}</div>
    </div>;
  }
  if (sentence.visual.role === "feature") return <div style={{...base, ...motion, left: 72, top: 220, padding: "12px 22px", borderRadius: 999, background: "rgba(0,0,0,0.66)", border: "1px solid rgba(255,255,255,0.38)", fontSize: 46, fontWeight: 850}}>{label}</div>;
  return <div style={{...base, ...motion, left: 72, right: 200, bottom: 760, padding: "22px 28px", borderRadius: 24, background: "rgba(215,28,48,0.92)", fontSize: 58, fontWeight: 900, textAlign: "center"}}>{label}</div>;
};
```

- [ ] **Step 6: Wire the layers without moving the clock**

In `production-video.tsx`, keep the existing `Sequence` and tail `Freeze`, replacing only the direct video element:

```tsx
<Freeze frame={sentence.voiceFrames - 1} active={(frame) => frame >= sentence.voiceFrames}>
  <ShotLayer sentence={sentence} fps={props.fps} />
</Freeze>
<OverlayLayer sentence={sentence} fps={props.fps} />
<Audio src={staticFile(sentence.wavPath)} trimAfter={sentence.voiceFrames} />
```

Keep the existing Arial `brand` object for legacy cues. In `subtitle-layer.tsx`, use these exact replacements in the enhanced branch:

```tsx
import {visualTheme} from "./visual-theme";

const accent = cue.role === "hook" ? visualTheme.problem : visualTheme.result;
// In the enhanced outer wrapper:
fontFamily: visualTheme.fontFamily
// In the enhanced caption card:
color: visualTheme.text
```

In `production-video.tsx`, set the root only to `backgroundColor: visualTheme.background`; it is the same `#08100d` value as the legacy root. Do not alter the legacy subtitle branch or add a transition component.

- [ ] **Step 7: Run tests and typecheck**

Run:

```bash
node --test scripts/production-contract.test.mjs scripts/visual-timing.test.mjs
npm run typecheck --workspace @auto-video/remotion-video
```

Expected: exit 0; the static wiring assertions and TypeScript checks pass.

- [ ] **Step 8: Commit the visual-layer task**

```bash
git add packages/remotion-video/src/components/visual-theme.ts packages/remotion-video/src/components/shot-layer.tsx packages/remotion-video/src/components/overlay-layer.tsx packages/remotion-video/src/components/subtitle-layer.tsx packages/remotion-video/src/production-video.tsx scripts/production-contract.test.mjs
git commit -m "feat: add evidence-first visual layers"
```

---

### Task 4: Licensed Audio Pack and Production Staging

**Files:**

- Create: `assets/audio/s5max/bgm-deep-techno-ambience.mp3`
- Create: `assets/audio/s5max/hook-impact.wav`
- Create: `assets/audio/s5max/electric-razor.wav`
- Create: `assets/audio/s5max/water-splash.wav`
- Create: `assets/audio/s5max/interface-click.wav`
- Create: `assets/audio/s5max/cta-click.wav`
- Create: `assets/audio/s5max/sources.json`
- Create: `assets/audio/s5max/SHA256SUMS`
- Modify: `scripts/produce.mjs:18-21,84-100,115-300`
- Modify: `scripts/produce.test.mjs:12-150`

**Interfaces:**

- Consumes: validated `plan.sentences[].visual.sfx`, existing `regularFile()`, `stageFile()`, `sha256File()`, and job `publicDir`.
- Produces: `public/audio/design/*` for enhanced jobs and `manifest.designAudio`; legacy jobs do not require the pack.

- [ ] **Step 1: Add failing staging and tamper tests**

Extend the test workspace with an `assets/audio/s5max` directory only in the enhanced test. Use small test buffers whose hashes are written into a test `sources.json`. Add:

```js
test("visual jobs stage only required verified design audio and record licenses", async () => {
  const {root, files} = await makeWorkspace();
  const planValue = JSON.parse(await readFile(files.plan, "utf8"));
  planValue.sentences[0].visual = {role: "hook", label: "先看这一刀", sfx: "impact"};
  await writeFile(files.plan, JSON.stringify(planValue));
  const audioRoot = path.join(root, "assets/audio/s5max");
  await mkdir(audioRoot, {recursive: true});
  await writeFile(path.join(audioRoot, "bgm.mp3"), "bgm");
  await writeFile(path.join(audioRoot, "impact.wav"), "impact");
  await writeFile(path.join(audioRoot, "sources.json"), JSON.stringify({schemaVersion: 1, licenseCheckedAt: "2026-08-19", assets: [
    {key: "bgm", fileName: "bgm.mp3", sha256: sha256("bgm"), sourceUrl: "https://example.test/bgm", license: "test"},
    {key: "impact", fileName: "impact.wav", sha256: sha256("impact"), sourceUrl: "https://example.test/impact", license: "test"},
  ]}));
  const {execFileImpl} = fakeCommands(root, files);
  const result = await runProduction({planPath: files.plan, modelDir: files.model, pythonPath: files.python, outDir: files.outDir, workspaceRoot: root}, {execFileImpl});
  assert.equal(await readFile(path.join(root, "work/production/video-01/public/audio/design/bgm.mp3"), "utf8"), "bgm");
  assert.deepEqual(result.designAudio.assets.map(({key}) => key), ["bgm", "impact"]);
});

test("visual jobs reject a design audio hash mismatch before rendering", async () => {
  const {root, files} = await makeWorkspace();
  const planValue = JSON.parse(await readFile(files.plan, "utf8"));
  planValue.sentences[0].visual = {role: "hook", label: "先看", sfx: "impact"};
  await writeFile(files.plan, JSON.stringify(planValue));
  const audioRoot = path.join(root, "assets/audio/s5max");
  await mkdir(audioRoot, {recursive: true});
  await writeFile(path.join(audioRoot, "bgm.mp3"), "tampered");
  await writeFile(path.join(audioRoot, "impact.wav"), "impact");
  await writeFile(path.join(audioRoot, "sources.json"), JSON.stringify({schemaVersion: 1, licenseCheckedAt: "2026-08-19", assets: [
    {key: "bgm", fileName: "bgm.mp3", sha256: sha256("expected"), sourceUrl: "https://example.test/bgm", license: "test"},
    {key: "impact", fileName: "impact.wav", sha256: sha256("impact"), sourceUrl: "https://example.test/impact", license: "test"},
  ]}));
  await assert.rejects(runProduction({planPath: files.plan, modelDir: files.model, pythonPath: files.python, outDir: files.outDir, workspaceRoot: root}), /design audio hash/);
});
```

In the existing `runProduction executes one local TTS and one Remotion final render` legacy test, add:

```js
assert.equal(result.designAudio, null);
```

- [ ] **Step 2: Run the focused production tests and confirm RED**

Run:

```bash
node --test scripts/produce.test.mjs
```

Expected: FAIL because design audio is neither resolved nor staged.

- [ ] **Step 3: Download the exact licensed assets**

Create `assets/audio/s5max/`, then run these approved-source downloads:

```bash
mkdir -p assets/audio/s5max
curl -L --fail --silent --show-error https://assets.mixkit.co/music/134/134.mp3 -o assets/audio/s5max/bgm-deep-techno-ambience.mp3
curl -L --fail --silent --show-error https://assets.mixkit.co/active_storage/sfx/1492/1492.wav -o assets/audio/s5max/hook-impact.wav
curl -L --fail --silent --show-error https://opengameart.org/sites/default/files/electric_razor.wav -o assets/audio/s5max/electric-razor.wav
curl -L --fail --silent --show-error https://assets.mixkit.co/active_storage/sfx/1311/1311.wav -o assets/audio/s5max/water-splash.wav
curl -L --fail --silent --show-error https://assets.mixkit.co/active_storage/sfx/2577/2577.wav -o assets/audio/s5max/interface-click.wav
curl -L --fail --silent --show-error https://assets.mixkit.co/active_storage/sfx/2568/2568.wav -o assets/audio/s5max/cta-click.wav
```

Add this exact `SHA256SUMS` content:

```text
b873f8373c4d1cf134f358105ff5914e601d60dd518a7a5c0ad04398f47c0fad  bgm-deep-techno-ambience.mp3
02b8cd40b3761288d54f4d6706983a2f8c110182b669ae2cdf9aab02935a4e7a  hook-impact.wav
2b5d5afdc7a51a17e859aa927d32d746c26ceaa2d719134191385479efa537da  electric-razor.wav
a1ab335e5c632001c347574bfdd521c049755481067df44e7406476ec64df26e  water-splash.wav
bb9d4bb078ba650cd81027dfca724162cf1df0352fc56018cb6241aab5a406cc  interface-click.wav
248312c2ef619427ef7024126a846e4210fe37e39038cfd32c73b1fb854a8086  cta-click.wav
```

Verify:

```bash
cd assets/audio/s5max && shasum -a 256 -c SHA256SUMS
```

Expected: six `OK` lines.

- [ ] **Step 4: Add the exact license/source manifest**

Create `sources.json` with one object per key:

```json
{
  "schemaVersion": 1,
  "licenseCheckedAt": "2026-08-19",
  "assets": [
    {"key":"bgm","fileName":"bgm-deep-techno-ambience.mp3","sha256":"b873f8373c4d1cf134f358105ff5914e601d60dd518a7a5c0ad04398f47c0fad","title":"Deep Techno Ambience","author":"Alejandro Magaña (A. M.)","sourceUrl":"https://assets.mixkit.co/music/134/134.mp3","sourcePage":"https://mixkit.co/free-stock-music/tag/technology/","license":"Mixkit Stock Music Free License","licenseUrl":"https://mixkit.co/license/#musicFree"},
    {"key":"impact","fileName":"hook-impact.wav","sha256":"02b8cd40b3761288d54f4d6706983a2f8c110182b669ae2cdf9aab02935a4e7a","title":"Cinematic whoosh fast transition","sourceUrl":"https://assets.mixkit.co/active_storage/sfx/1492/1492.wav","sourcePage":"https://mixkit.co/free-sound-effects/transition/","license":"Mixkit Sound Effects Free License","licenseUrl":"https://mixkit.co/license/#sfxFree"},
    {"key":"motor","fileName":"electric-razor.wav","sha256":"2b5d5afdc7a51a17e859aa927d32d746c26ceaa2d719134191385479efa537da","title":"Electric Razor SFX","author":"Vinrax","sourceUrl":"https://opengameart.org/sites/default/files/electric_razor.wav","sourcePage":"https://opengameart.org/content/electric-razor-sfx","license":"CC-BY 3.0","licenseUrl":"https://creativecommons.org/licenses/by/3.0/","attribution":"Electric Razor SFX by Vinrax, CC-BY 3.0"},
    {"key":"water","fileName":"water-splash.wav","sha256":"a1ab335e5c632001c347574bfdd521c049755481067df44e7406476ec64df26e","title":"Water splash","sourceUrl":"https://assets.mixkit.co/active_storage/sfx/1311/1311.wav","sourcePage":"https://mixkit.co/free-sound-effects/water/","license":"Mixkit Sound Effects Free License","licenseUrl":"https://mixkit.co/license/#sfxFree"},
    {"key":"usb","fileName":"interface-click.wav","sha256":"bb9d4bb078ba650cd81027dfca724162cf1df0352fc56018cb6241aab5a406cc","title":"Interface device click","sourceUrl":"https://assets.mixkit.co/active_storage/sfx/2577/2577.wav","sourcePage":"https://mixkit.co/free-sound-effects/technology/","license":"Mixkit Sound Effects Free License","licenseUrl":"https://mixkit.co/license/#sfxFree"},
    {"key":"cta","fileName":"cta-click.wav","sha256":"248312c2ef619427ef7024126a846e4210fe37e39038cfd32c73b1fb854a8086","title":"Cool interface click tone","sourceUrl":"https://assets.mixkit.co/active_storage/sfx/2568/2568.wav","sourcePage":"https://mixkit.co/free-sound-effects/click/","license":"Mixkit Sound Effects Free License","licenseUrl":"https://mixkit.co/license/#sfxFree"}
  ]
}
```

- [ ] **Step 5: Stage verified assets only for enhanced plans**

In `pathsFor()`, add `designAudioDir: path.join(publicDir, "audio/design")`. In `runProduction()`, place this logic after all output-collision checks and before the proxy loop (Task 5 inserts font preflight between `usesVisual` and asset staging):

```js
const usesVisual = input.plan.sentences.some((sentence) => sentence.visual !== undefined);
let designAudio = null;
if (usesVisual) {
  await directory(input.workspaceRoot, paths.designAudioDir);
  const sourceRoot = await readableDirectory(path.join(input.workspaceRoot, "assets/audio/s5max"), "design audio root");
  const sourceManifestPath = await regularFile(path.join(sourceRoot, "sources.json"), "design audio manifest");
  const sourceManifest = await readJson(sourceManifestPath);
  if (sourceManifest?.schemaVersion !== 1 || !Array.isArray(sourceManifest.assets)) throw new Error("Invalid design audio manifest.");
  const byKey = new Map(sourceManifest.assets.map((entry) => [entry.key, entry]));
  if (byKey.size !== sourceManifest.assets.length) throw new Error("Design audio keys must be unique.");
  const requiredKeys = ["bgm", ...new Set(input.plan.sentences.map((sentence) => sentence.visual?.sfx).filter(Boolean))];
  const staged = [];
  for (const key of requiredKeys) {
    const entry = byKey.get(key);
    if (!entry || !/^[a-f0-9]{64}$/u.test(entry.sha256) || !JOB_RE.test(entry.key) || path.basename(entry.fileName) !== entry.fileName) throw new Error(`Invalid design audio entry: ${key}`);
    const source = await regularFile(path.join(sourceRoot, entry.fileName), `design audio ${key}`);
    assertDescendant(sourceRoot, source, `design audio ${key}`);
    if (await sha256File(source) !== entry.sha256) throw new Error(`design audio hash mismatch: ${key}`);
    const destination = path.join(paths.designAudioDir, entry.fileName);
    await stageFile(source, destination, entry.sha256);
    staged.push({...entry, stagedPath: `audio/design/${entry.fileName}`});
  }
  designAudio = {sourceManifestPath, licenseCheckedAt: sourceManifest.licenseCheckedAt, assets: staged};
}
```

Add `designAudio` to the final manifest. Legacy jobs record `designAudio: null` and do not read `assets/audio/s5max`.

- [ ] **Step 6: Run production tests**

Run:

```bash
node --test scripts/produce.test.mjs
```

Expected: exit 0; enhanced staging and tamper rejection pass, and all legacy production tests remain green.

- [ ] **Step 7: Commit the audio assets and staging**

```bash
git add assets/audio/s5max scripts/produce.mjs scripts/produce.test.mjs
git commit -m "feat: stage licensed S5Max design audio"
```

---

### Task 5: BGM, SFX, Ducking, and Enhanced Audio QC

**Files:**

- Create: `packages/remotion-video/src/audio-design.js`
- Create: `packages/remotion-video/src/components/sound-bed.tsx`
- Create: `scripts/audio-design.test.mjs`
- Modify: `packages/remotion-video/src/production-video.tsx:1-49`
- Modify: `scripts/lib/render-qc.mjs:32-55`
- Modify: `scripts/lib/render-qc.test.mjs:1-51`
- Modify: `scripts/produce.mjs:270-300`
- Modify: `scripts/produce.test.mjs:40-190`

**Interfaces:**

- Consumes: sentence frame ranges, `visual.sfx`, fixed staged file paths, and FFmpeg `volumedetect` stderr.
- Produces: `musicGainAt(frame,sentences)`, `sfxStartFrame(sentence)`, `SoundBed`, `analyzeVolume(stderr)`, `assertMixHeadroom(analysis)`, and `assertSystemFont(input,family)`.

- [ ] **Step 1: Write failing pure audio tests**

Create `scripts/audio-design.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {dbToGain, musicGainAt, sfxStartFrame} from "../packages/remotion-video/src/audio-design.js";

const sentences = [{startFrame: 10, voiceFrames: 30}, {startFrame: 45, voiceFrames: 20}];

test("BGM is 0.08 outside speech and ducks by exactly 5 dB during speech", () => {
  assert.equal(musicGainAt(0, sentences), 0.08);
  assert.ok(Math.abs(musicGainAt(10, sentences) - 0.08 * dbToGain(-5)) < 1e-12);
  assert.equal(musicGainAt(40, sentences), 0.08);
});

test("SFX timing is deterministic", () => {
  assert.equal(sfxStartFrame({startFrame: 20, visual: {sfx: "impact"}}), 20);
  assert.equal(sfxStartFrame({startFrame: 20, visual: {sfx: "usb"}}), 23);
  assert.equal(sfxStartFrame({startFrame: 20}), null);
});
```

Extend `render-qc.test.mjs`:

```js
test("enhanced volume analysis records mean and rejects insufficient headroom", () => {
  const analysis = analyzeVolume("mean_volume: -15.0 dB\nmax_volume: -1.0 dB\n");
  assert.deepEqual(analysis, {meanVolumeDb: -15, maxVolumeDb: -1});
  assert.doesNotThrow(() => assertMixHeadroom(analysis));
  assert.throws(() => assertMixHeadroom({meanVolumeDb: -15, maxVolumeDb: -0.9}), /headroom/);
});

test("enhanced font preflight requires enabled valid PingFang SC", () => {
  const inventory = {SPFontsDataType: [{enabled: "yes", typefaces: [{family: "PingFang SC", enabled: "yes", valid: "yes"}]}]};
  assert.equal(assertSystemFont(inventory, "PingFang SC"), "PingFang SC");
  assert.throws(() => assertSystemFont({SPFontsDataType: []}, "PingFang SC"), /PingFang SC/);
});
```

Replace the `render-qc.test.mjs` import with:

```js
import {analyzeVolume, assertAudibleVolume, assertMixHeadroom, assertQcMetadata, assertSystemFont, forceMonoAac, renderArgs} from "./render-qc.mjs";
```

- [ ] **Step 2: Run the audio tests and confirm RED**

Run:

```bash
node --test scripts/audio-design.test.mjs scripts/lib/render-qc.test.mjs
```

Expected: FAIL because the new modules and exports do not exist.

- [ ] **Step 3: Implement pure audio timing**

Create `audio-design.js`:

```js
export const DESIGN_AUDIO_PATHS = Object.freeze({
  bgm: "audio/design/bgm-deep-techno-ambience.mp3",
  impact: "audio/design/hook-impact.wav",
  motor: "audio/design/electric-razor.wav",
  water: "audio/design/water-splash.wav",
  usb: "audio/design/interface-click.wav",
  cta: "audio/design/cta-click.wav",
});

export const dbToGain = (db) => 10 ** (db / 20);
export const musicGainAt = (frame, sentences) => {
  const speaking = sentences.some((sentence) => frame >= sentence.startFrame && frame < sentence.startFrame + sentence.voiceFrames);
  return 0.08 * (speaking ? dbToGain(-5) : 1);
};
export const sfxStartFrame = (sentence) => {
  if (!sentence.visual?.sfx) return null;
  return sentence.startFrame + (sentence.visual.sfx === "usb" ? 3 : 0);
};
```

- [ ] **Step 4: Implement `SoundBed`**

Create `components/sound-bed.tsx`:

```tsx
import {Audio, Sequence, staticFile} from "remotion";
import type {ProductionProps} from "../production-contract.js";
import {DESIGN_AUDIO_PATHS, musicGainAt, sfxStartFrame} from "../audio-design.js";

const sfxVolume = {impact: 0.2, motor: 0.18, water: 0.2, usb: 0.22, cta: 0.22} as const;

export const SoundBed = ({sentences, durationInFrames}: Pick<ProductionProps, "sentences" | "durationInFrames">) => <>
  <Audio src={staticFile(DESIGN_AUDIO_PATHS.bgm)} trimAfter={durationInFrames} volume={(frame) => musicGainAt(frame, sentences)} />
  {sentences.flatMap((sentence) => {
    const key = sentence.visual?.sfx;
    const from = sfxStartFrame(sentence);
    if (!key || from === null) return [];
    const localOffset = from - sentence.startFrame;
    return [<Sequence key={`${sentence.id}-${key}`} from={from} durationInFrames={Math.max(1, sentence.voiceFrames - localOffset)}>
      <Audio src={staticFile(DESIGN_AUDIO_PATHS[key])} trimAfter={Math.max(1, sentence.voiceFrames - localOffset)} volume={sfxVolume[key]} />
    </Sequence>];
  })}
</>;
```

- [ ] **Step 5: Wire enhanced mixing and preserve legacy gain**

In `ProductionVideo`:

```tsx
const enhanced = props.sentences.some((sentence) => sentence.visual !== undefined);
// Inside each sentence Sequence:
<Audio src={staticFile(sentence.wavPath)} trimAfter={sentence.voiceFrames} volume={enhanced ? 0.82 : 1} />
// After sentence Sequences:
{enhanced && <SoundBed sentences={props.sentences} durationInFrames={props.durationInFrames} />}
```

Legacy videos continue to contain only TTS at gain 1.

- [ ] **Step 6: Parse mean/max volume and enforce enhanced headroom**

In `render-qc.mjs`, keep `assertAudibleVolume()` for compatibility and add:

```js
const volumeValue = (stderr, key) => {
  const match = String(stderr).match(new RegExp(`${key}:\\s*(-?inf|-?\\d+(?:\\.\\d+)?)\\s*dB`, "iu"));
  if (!match || match[1].toLowerCase() === "-inf") throw new Error(`QC requires finite ${key}.`);
  return Number(match[1]);
};

export const analyzeVolume = (stderr) => ({
  meanVolumeDb: volumeValue(stderr, "mean_volume"),
  maxVolumeDb: volumeValue(stderr, "max_volume"),
});

export const assertMixHeadroom = ({maxVolumeDb}) => {
  if (maxVolumeDb > -1) throw new Error(`Enhanced mix requires at least 1 dB headroom; max_volume was ${maxVolumeDb} dB.`);
};

export const assertSystemFont = (input, family) => {
  const value = typeof input === "string" ? JSON.parse(input) : input;
  const found = Array.isArray(value?.SPFontsDataType) && value.SPFontsDataType.some((font) =>
    font?.enabled === "yes" && Array.isArray(font.typefaces) && font.typefaces.some((face) =>
      face?.family === family && face.enabled === "yes" && face.valid === "yes",
    ),
  );
  if (!found) throw new Error(`Required enabled system font is unavailable: ${family}`);
  return family;
};
```

Replace the `render-qc.mjs` import in `produce.mjs` with:

```js
import {analyzeVolume, assertAudibleVolume, assertMixHeadroom, assertQcMetadata, assertSystemFont, renderArgs} from "./lib/render-qc.mjs";
```

Immediately after Task 4 computes `usesVisual`, and before proxying or TTS, add the enhanced-only macOS inventory check:

```js
if (usesVisual) {
  const {stdout: fontInventory} = await execFileImpl(
    "/usr/sbin/system_profiler",
    ["SPFontsDataType", "-json"],
    {maxBuffer: 64 * 1024 * 1024},
  );
  assertSystemFont(fontInventory, "PingFang SC");
}
```

Then replace the single-value volume assignment with:

```js
const analysis = analyzeVolume(volume.stderr);
assertAudibleVolume(volume.stderr);
if (usesVisual) assertMixHeadroom(analysis);
Object.assign(qc, analysis);
```

Update `fakeCommands()` in `produce.test.mjs` with both deterministic preflight responses:

```js
if (command === "/usr/sbin/system_profiler") return {stdout: JSON.stringify({SPFontsDataType: [{enabled: "yes", typefaces: [{family: "PingFang SC", enabled: "yes", valid: "yes"}]}]}), stderr: ""};
if (command === "ffmpeg" && args.includes("volumedetect")) return {stdout: "", stderr: `mean_volume: -15.0 dB\nmax_volume: ${maxVolume} dB\n`};
```

Add a production test proving the missing-font path stops before TTS:

```js
test("visual jobs fail before TTS when PingFang SC is unavailable", async () => {
  const {root, files} = await makeWorkspace();
  const planValue = JSON.parse(await readFile(files.plan, "utf8"));
  planValue.sentences[0].visual = {role: "hook", label: "先看", sfx: "impact"};
  await writeFile(files.plan, JSON.stringify(planValue));
  const audioRoot = path.join(root, "assets/audio/s5max");
  await mkdir(audioRoot, {recursive: true});
  for (const [name, value] of [["bgm.mp3", "bgm"], ["impact.wav", "impact"]]) await writeFile(path.join(audioRoot, name), value);
  await writeFile(path.join(audioRoot, "sources.json"), JSON.stringify({schemaVersion: 1, licenseCheckedAt: "2026-08-19", assets: [
    {key: "bgm", fileName: "bgm.mp3", sha256: sha256("bgm"), sourceUrl: "https://example.test/bgm", license: "test"},
    {key: "impact", fileName: "impact.wav", sha256: sha256("impact"), sourceUrl: "https://example.test/impact", license: "test"},
  ]}));
  const fake = fakeCommands(root, files);
  const execFileImpl = async (command, args) => command === "/usr/sbin/system_profiler"
    ? {stdout: JSON.stringify({SPFontsDataType: []}), stderr: ""}
    : fake.execFileImpl(command, args);
  await assert.rejects(runProduction({planPath: files.plan, modelDir: files.model, pythonPath: files.python, outDir: files.outDir, workspaceRoot: root}, {execFileImpl}), /PingFang SC/);
  assert.equal(fake.calls.some(([command]) => command === files.python), false);
});
```

- [ ] **Step 7: Run audio, production, and type checks**

Run:

```bash
node --test scripts/audio-design.test.mjs scripts/lib/render-qc.test.mjs scripts/produce.test.mjs
npm run typecheck --workspace @auto-video/remotion-video
```

Expected: exit 0; ducking, SFX timing, asset staging, legacy QC, enhanced headroom, and TypeScript checks pass.

- [ ] **Step 8: Commit the sound and QC task**

```bash
git add packages/remotion-video/src/audio-design.js packages/remotion-video/src/components/sound-bed.tsx packages/remotion-video/src/production-video.tsx scripts/audio-design.test.mjs scripts/lib/render-qc.mjs scripts/lib/render-qc.test.mjs scripts/produce.mjs scripts/produce.test.mjs
git commit -m "feat: mix S5Max design audio with headroom"
```

---

### Task 6: Safe-Zone QA and One Visual A/B Render

**Files:**

- Modify: `packages/remotion-video/src/contact-sheet.tsx:4-58`
- Modify: `packages/remotion-video/src/root.tsx:38-45`
- Modify: `scripts/produce.mjs:285-330`
- Modify: `scripts/produce.test.mjs:135-190`
- Modify: `scripts/production-contract.test.mjs:155-180`
- Create locally: `work/production-plans/s5max-01-remotion-visual.json`
- Render locally: `out/production/s5max-01-remotion-visual.mp4`
- Generated QA: `work/production/s5max-01-remotion-visual/contacts/final-cut.jpg`

**Interfaces:**

- Consumes: `DOUYIN_SAFE_ZONE`, enhanced final MP4, and existing `MediaContactSheet` Still.
- Produces: safe-zone-aware enhanced contact sheet, completed visual job manifest, and one A/B candidate MP4.

- [ ] **Step 1: Add failing contact-sheet assertions to the production test**

In the enhanced production test from Task 4, change `const {execFileImpl} = fakeCommands(root, files);` to `const {calls, execFileImpl} = fakeCommands(root, files);`, then inspect the Remotion `still` call:

```js
const still = calls.find(([, args]) => args[0] === "still")[1];
const stillProps = JSON.parse(still[still.indexOf("--props") + 1]);
assert.deepEqual(stillProps.safeZone, {left: 72, right: 200, top: 160, bottom: 530});
assert.ok(stillProps.samples.some(({frame}) => frame === 9));
```

Add this static regression test because Remotion `trimBefore` is measured in frames:

```js
test("contact sheet seeks to the requested frame without dividing by fps", async () => {
  const source = await readFile(new URL("../packages/remotion-video/src/contact-sheet.tsx", import.meta.url), "utf8");
  assert.match(source, /trimBefore=\{sample\.frame\}/);
  assert.doesNotMatch(source, /sample\.frame \/ 30/);
});
```

- [ ] **Step 2: Run the enhanced production test and confirm RED**

Run:

```bash
node --test scripts/produce.test.mjs
```

Expected: FAIL because contact-sheet Props do not include `safeZone` or frame 9, and the current contact sheet divides an already frame-based sample by 30.

- [ ] **Step 3: Add the optional safe-zone guide**

Extend `MediaContactSheetProps`:

```ts
safeZone?: {left: number; right: number; top: number; bottom: number} | null;
```

Replace `errorsFor`'s parameter with `{mediaPath, samples, safeZone}` and add this exact validation before `return errors`:

```ts
if (safeZone !== null && safeZone !== undefined) {
  if (typeof safeZone !== "object") errors.push("safeZone must be an object or null.");
  else {
    const values = [safeZone.left, safeZone.right, safeZone.top, safeZone.bottom];
    if (!values.every((value) => Number.isFinite(value) && value >= 0)) errors.push("safeZone values must be finite and non-negative.");
    else if (safeZone.left + safeZone.right >= 1080 || safeZone.top + safeZone.bottom >= 1920) errors.push("safeZone must leave a positive video area.");
  }
}
```

Change the component signature to `MediaContactSheet = ({mediaPath, samples, safeZone}: MediaContactSheetProps)`. In each contact-sheet cell, replace the bare `OffthreadVideo` with one centered 9:16 wrapper so the guide and contained video share the same coordinate box:

```tsx
<div style={{position: "absolute", top: 0, bottom: 0, left: "50%", aspectRatio: "9 / 16", transform: "translateX(-50%)"}}>
  <OffthreadVideo
    src={staticFile(mediaPath)}
    trimBefore={sample.frame}
    muted
    style={{width: "100%", height: "100%", objectFit: "contain"}}
  />
  {safeZone && <div style={{position: "absolute", inset: 0, pointerEvents: "none"}}>
    <div style={{position: "absolute", left: `${safeZone.left / 10.8}%`, right: `${safeZone.right / 10.8}%`, top: `${safeZone.top / 19.2}%`, bottom: `${safeZone.bottom / 19.2}%`, border: "3px solid #FFD84D", boxShadow: "0 0 0 1px rgba(0,0,0,0.8)"}} />
  </div>}
</div>
```

Update `root.tsx` default Props to `{mediaPath: "", samples: [], safeZone: null}`.

- [ ] **Step 4: Request enhanced QA frames**

Import `DOUYIN_SAFE_ZONE` into `produce.mjs`. For visual jobs use frames derived from `[0.3, 1.5, 3.5, 8.5, 11, 14, 17]` seconds, clamped to the final frame. Legacy jobs keep the existing sentence-cut samples:

```js
const visualSamples = [0.3, 1.5, 3.5, 8.5, 11, 14, 17].map((seconds) => ({
  frame: Math.min(props.durationInFrames - 1, Math.round(seconds * props.fps)),
  label: `QA · ${seconds.toFixed(1)}s`,
}));
const samples = usesVisual ? visualSamples : [
  {frame: 0, label: "START"},
  ...props.sentences.slice(1).map((sentence) => ({frame: sentence.startFrame + 1, label: `CUT · ${sentence.id}`})),
  {frame: props.durationInFrames - 1, label: "END"},
];
const contactProps = {mediaPath: path.basename(paths.partialOutputPath), samples, safeZone: usesVisual ? DOUYIN_SAFE_ZONE : null};
```

Pass `contactProps` to the existing Remotion `still` call.

- [ ] **Step 5: Create the local enhanced plan without changing copy or footage**

Use `apply_patch` to add `work/production-plans/s5max-01-remotion-visual.json` with this complete content:

```json
{
  "schemaVersion": 1,
  "id": "s5max-01-remotion-visual",
  "title": "七夕天天用的五刀头",
  "sourceText": "听我一句劝，想换剃须刀的，就买这把。去年七夕收到的，到现在天天用，五刀头刮得很干净。关键是Type-C充电，出差从来不用额外带线，省心。打理方便，一冲就干净，不用拆开抠。自磨刀头设计，用了一年多剃须效果还是很好，越用越值。上谷S5Max，买一次管用好几年。现在直播间还有活动，快去看看吧。",
  "catalogPath": "work/asset-library/catalog.json",
  "voice": {
    "promptPath": "work/indextts2-s5max/voice_03.wav",
    "durationFactor": 1
  },
  "sentences": [
    {
      "id": "s01",
      "text": "听我一句劝，想换剃须刀的，就买这把。",
      "ttsText": "听我一句劝，想换剃须刀的，就买这把。",
      "visual": {"role": "hook", "emphasis": "剃须刀", "label": "换剃须刀\n先看这把", "sfx": "impact"},
      "shot": {
        "sourceId": "ccf04e2020b7d533fe1296204567d6ac1732cf7adde999974f7cf38f3a44f617",
        "sourceInSeconds": 0,
        "sourceOutSeconds": 7.4,
        "fit": "cover",
        "focusX": 0.5,
        "focusY": 0.5
      }
    },
    {
      "id": "s02",
      "text": "去年七夕收到的，到现在天天用，五刀头刮得很干净。",
      "ttsText": "去年七夕收到的，到现在天天用，五刀头刮得很干净。",
      "visual": {"role": "proof", "emphasis": "五刀头", "label": "五刀头结构"},
      "shot": {
        "sourceId": "80c0c476035659bf9b4391e407c913f2147474214adf8f5edf62edcac6e62bb2",
        "sourceInSeconds": 0,
        "sourceOutSeconds": 11.4,
        "fit": "cover",
        "focusX": 0.5,
        "focusY": 0.31
      }
    },
    {
      "id": "s03",
      "text": "关键是Type-C充电，出差从来不用额外带线，省心。",
      "ttsText": "关键是Type C充电，出差从来不用额外带线，省心。",
      "visual": {"role": "feature", "emphasis": "Type-C", "label": "Type-C", "sfx": "usb"},
      "shot": {
        "sourceId": "4296e972814556f44ae73ae713c04410f852988d9e463082bf616d4033713ff3",
        "sourceInSeconds": 0,
        "sourceOutSeconds": 7.4,
        "fit": "cover",
        "focusX": 0.5,
        "focusY": 0.5
      }
    },
    {
      "id": "s04",
      "text": "打理方便，一冲就干净，不用拆开抠。",
      "ttsText": "打理方便，一冲就干净，不用拆开抠。",
      "visual": {"role": "feature", "emphasis": "一冲就干净", "label": "直接冲洗", "sfx": "water"},
      "shot": {
        "sourceId": "1c63f93b87cc32463d8198a65862083b7f9798496e43b9906035a896f10eefb0",
        "sourceInSeconds": 0,
        "sourceOutSeconds": 12,
        "fit": "cover",
        "focusX": 0.5,
        "focusY": 0.5
      }
    },
    {
      "id": "s05",
      "text": "自磨刀头设计，用了一年多剃须效果还是很好，越用越值。",
      "ttsText": "自磨刀头设计，用了一年多剃须效果还是很好，越用越值。",
      "visual": {"role": "feature", "emphasis": "自磨刀头", "label": "刀头结构"},
      "shot": {
        "sourceId": "cc124dc37cdb9380a67483fa6e7981e093d9de4cc4ea27a89fa1382a0f83574d",
        "sourceInSeconds": 0,
        "sourceOutSeconds": 8,
        "fit": "cover",
        "focusX": 0.5,
        "focusY": 0.5
      }
    },
    {
      "id": "s06",
      "text": "上谷S5Max，买一次管用好几年。",
      "ttsText": "上谷S五Max，买一次管用好几年。",
      "visual": {"role": "feature", "emphasis": "上谷S5Max", "label": "上谷 S5Max"},
      "shot": {
        "sourceId": "95e682c1d75bc16cf29a29bf17761d486d3a622bd24c3b8c2bceed0a7318f62b",
        "sourceInSeconds": 0,
        "sourceOutSeconds": 11.3,
        "fit": "cover",
        "focusX": 0.5,
        "focusY": 0.5
      }
    },
    {
      "id": "s07",
      "text": "现在直播间还有活动，快去看看吧。",
      "ttsText": "现在直播间还有活动，快去看看吧。",
      "visual": {"role": "cta", "emphasis": "活动", "label": "直播间看活动", "sfx": "cta"},
      "shot": {
        "sourceId": "c6bea3e8df09bd5fd5b822f3771412b2bac81b4b61deb1dfdbf9a930e6807a21",
        "sourceInSeconds": 2,
        "sourceOutSeconds": 6,
        "fit": "cover",
        "focusX": 0.5,
        "focusY": 0.5
      }
    }
  ]
}
```

The only shot changes versus A are deliberate: swap the existing s01/s02 source assignments so real shaving appears at frame 0, and set s02 `focusY` to `0.31` so the proof marker lands on the five-blade head. Keep all seven original source IDs exactly once; do not alter sentence order, `text`, `ttsText`, the other five shots, voice prompt, or duration factor.

- [ ] **Step 6: Verify source availability, baseline immutability, and the complete automated suite**

Run:

```bash
test -d /Volumes/192.168.50.79
shasum -a 256 out/production/s5max-01-remotion.mp4
npm test
npm run typecheck
```

Expected: all commands exit 0; the baseline hash is exactly `55adea03faeae4fac436cdd6660c4df6fa853ea596d023130bae462a6e5dcb3c`; every Node test and workspace TypeScript check passes. If the first command fails, stop here and mount the existing read-only SMB source—do not substitute, copy, or regenerate footage for this isolated A/B test.

- [ ] **Step 7: Render the enhanced A/B candidate**

Run:

```bash
npm run produce -- --plan work/production-plans/s5max-01-remotion-visual.json
```

Expected final output:

```text
/Users/gilgamesharcher/repo/Remotion/out/production/s5max-01-remotion-visual.mp4
```

The production command must reuse the cached TTS content, produce the same 694-frame timeline as A, complete one Remotion render, publish a manifest, and create `work/production/s5max-01-remotion-visual/contacts/final-cut.jpg` only after QC.

- [ ] **Step 8: Run fresh media verification**

Run:

```bash
ffprobe -v error -count_frames -show_entries format=duration,size -show_entries stream=index,codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,channels,nb_read_frames -of json out/production/s5max-01-remotion-visual.mp4
ffmpeg -nostdin -hide_banner -i out/production/s5max-01-remotion-visual.mp4 -af volumedetect -f null -
```

Expected:

- exactly 694 video frames (23.133 seconds at 30 fps), with MP4 container duration within AAC padding tolerance of the current 23.189-second A output;
- one 1080×1920 H.264/yuv420p 30 fps video stream;
- one mono AAC audio stream;
- finite `mean_volume` and `max_volume <= -1.0 dB`;
- full decode exits 0 through the existing production QC.

- [ ] **Step 9: Perform visual QA on the generated contact sheet**

Open `work/production/s5max-01-remotion-visual/contacts/final-cut.jpg` with `view_image`, run `open out/production/s5max-01-remotion-visual.mp4` to play the final MP4 once on the same machine, and check each item explicitly:

1. With audio muted, the first 3 seconds still communicate a razor, shaving action, and a reason to continue.
2. Hook, feature labels, subtitles, and CTA remain inside the yellow safe-zone guide.
3. At 25% viewing size, Hook and phrase captions are readable.
4. Proof circle points at the actual blade/contact region and does not cover the face.
5. No frame displays more than one primary overlay.
6. Text does not assert a result absent from the underlying shot.
7. Impact, water, USB, and CTA sounds align with their visible actions and never mask TTS.
8. Side-by-side with A, B has clearer hierarchy without losing the native Douyin/UGC feel.
9. `shasum -a 256 out/production/s5max-01-remotion.mp4` still prints `55adea03faeae4fac436cdd6660c4df6fa853ea596d023130bae462a6e5dcb3c`.
10. The output manifest lists source URL, license URL, filename, and SHA-256 for every staged audio asset; it does not claim the unused motor SFX was staged.

If a check fails, change only the fixed template value responsible, rerun the smallest related test, rerender under a new unused job ID, and repeat this QA. Never overwrite the rejected render.

- [ ] **Step 10: Commit safe-zone QA code only**

```bash
git add packages/remotion-video/src/contact-sheet.tsx packages/remotion-video/src/root.tsx scripts/produce.mjs scripts/produce.test.mjs scripts/production-contract.test.mjs
git commit -m "feat: add Douyin safe-zone visual QA"
```

Do not add ignored `work/` plans, rendered MP4s, proxies, TTS WAVs, manifests, or contact sheets to Git.

---

## Final Verification Checklist

- [ ] `git diff --check` reports no whitespace errors.
- [ ] `npm test` exits 0 with no failed subtests.
- [ ] `npm run typecheck` exits 0.
- [ ] `shasum -a 256 -c assets/audio/s5max/SHA256SUMS` reports six `OK` lines.
- [ ] A legacy plan without `visual` still validates and uses TTS-only gain 1.
- [ ] The enhanced plan manifest records visual intent, staged audio hashes, license metadata, mean volume, max volume, and ordinary video QC.
- [ ] `PingFang SC` preflight succeeds for the enhanced job and remains unused by legacy styling.
- [ ] The enhanced MP4 has 694 frames, the expected streams, dimensions, frame rate, pixel format, and audio headroom.
- [ ] The enhanced contact sheet and playback pass all ten manual checks in Task 6.
- [ ] `git status --short` shows no new tracked changes beyond the six task commits; unrelated pre-existing changes remain untouched.
