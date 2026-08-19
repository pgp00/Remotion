import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdtemp, readFile, writeFile} from "node:fs/promises";
import test from "node:test";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";

import {
  buildProductionProps,
  subtitleOpacityAt,
  validateProductionPlan,
  validateProductionProps,
} from "../packages/remotion-video/src/production-contract.js";

const sentence = (id = "sentence-01", sourceId = "source-01") => ({
  id,
  text: `${id} 文案`,
  ttsText: `${id} 文案`,
  shot: {sourceId, sourceInSeconds: 0, sourceOutSeconds: 2, fit: "cover", focusX: 0.5, focusY: 0.5},
});

const plan = (sentences = [sentence()]) => ({
  schemaVersion: 1,
  id: "production-01",
  title: "标题",
  sourceText: sentences.map(({text}) => text).join(" "),
  catalogPath: "work/asset-library/catalog.json",
  voice: {promptPath: "work/voices/reference.wav", durationFactor: 1},
  sentences,
});

const inputs = (value, durationInSeconds = 1) => ({
  plan: value,
  audio: Object.fromEntries(value.sentences.map(({id}) => [id, {wavPath: `audio/${id}.wav`, durationInSeconds, sha256: "abc"}])),
  proxies: Object.fromEntries(value.sentences.map(({shot}) => [shot.sourceId, {proxyPath: `proxies/${shot.sourceId}.mp4`}])),
});

test("plan requires the normalized sentence text to reconstruct sourceText", () => {
  const value = plan();
  value.sourceText = "不同文案";
  assert.throws(() => validateProductionPlan(value), /sourceText/);
  assert.doesNotThrow(() => validateProductionPlan({...value, sourceText: "sentence-01\n  文案"}));
});

test("plan rejects unknown top-level and sentence fields", () => {
  assert.throws(() => validateProductionPlan({...plan(), timeline: {}}), /field/);
  const value = plan([{...sentence(), proxyPath: "proxy.mp4"}]);
  assert.throws(() => validateProductionPlan(value), /field/);
});

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

test("plan requires valid sentence identity and speech text", () => {
  for (const patch of [{id: ""}, {ttsText: ""}, {shot: {...sentence().shot, sourceId: ""}}]) {
    const value = plan([{...sentence(), ...patch}]);
    assert.throws(() => validateProductionPlan(value));
  }
  const duplicate = plan([sentence("same", "source-01"), sentence("same", "source-02")]);
  assert.throws(() => validateProductionPlan(duplicate), /unique/);
});

test("plan accepts only non-empty local catalog and voice paths", () => {
  for (const catalogPath of ["", "https://example.com/catalog.json"]) {
    assert.throws(() => validateProductionPlan({...plan(), catalogPath}), /catalogPath/);
  }
  for (const promptPath of ["", "file://voice.wav", "https://example.com/voice.wav"]) {
    const value = plan();
    value.voice = {...value.voice, promptPath};
    assert.throws(() => validateProductionPlan(value), /promptPath/);
  }
});

test("durationFactor accepts the inclusive 0.5 through 2.0 range", () => {
  for (const durationFactor of [0.5, 2]) {
    const value = plan();
    value.voice = {...value.voice, durationFactor};
    assert.doesNotThrow(() => validateProductionPlan(value));
  }
  for (const durationFactor of [0.49, 2.01]) {
    const value = plan();
    value.voice = {...value.voice, durationFactor};
    assert.throws(() => validateProductionPlan(value), /durationFactor/);
  }
});

test("shot fit accepts exactly cover and contain in plans and derived props", () => {
  for (const fit of ["cover", "contain"]) {
    const value = plan();
    value.sentences[0].shot.fit = fit;
    assert.doesNotThrow(() => validateProductionPlan(value));
    const props = buildProductionProps(inputs(value));
    assert.equal(props.sentences[0].shot.fit, fit);
    assert.doesNotThrow(() => validateProductionProps(props));
  }
  const value = plan();
  value.sentences[0].shot.fit = "fill";
  assert.throws(() => validateProductionPlan(value), /fit/);
  const props = buildProductionProps(inputs(plan()));
  props.sentences[0].shot.fit = "fill";
  assert.throws(() => validateProductionProps(props), /fit/);
});

test("one sentence has no pause and two sentences pause only after the first", () => {
  const one = buildProductionProps(inputs(plan()));
  assert.deepEqual(one.sentences.map(({pauseFrames}) => pauseFrames), [0]);
  const two = buildProductionProps(inputs(plan([sentence("one", "a"), sentence("two", "b")])));
  assert.deepEqual(two.sentences.map(({pauseFrames}) => pauseFrames), [5, 0]);
});

test("voice frames ceil positive finite durations at 30fps", () => {
  for (const [duration, frames] of [[0.001, 1], [1 / 30, 1], [1 / 30 + Number.EPSILON, 2], [1.01, 31]]) {
    assert.equal(buildProductionProps(inputs(plan(), duration)).sentences[0].voiceFrames, frames);
  }
  for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => buildProductionProps(inputs(plan(), duration)), /duration/);
  }
});

test("derived media paths are strict public-dir relative POSIX paths", () => {
  const invalid = ["/absolute.wav", "audio\\voice.wav", ".", "..", "audio/../voice.wav", "./voice.wav", "public/audio.wav", "https://example.com/a.wav"];
  for (const path of invalid) {
    const value = inputs(plan());
    value.audio["sentence-01"].wavPath = path;
    assert.throws(() => buildProductionProps(value), /wavPath/);
    value.audio["sentence-01"].wavPath = "audio/voice.wav";
    value.proxies["source-01"].proxyPath = path;
    assert.throws(() => buildProductionProps(value), /proxyPath/);
  }
});

test("source trim rounded to frames must cover the voice", () => {
  const value = plan();
  value.sentences[0].shot.sourceOutSeconds = 1;
  assert.throws(() => buildProductionProps(inputs(value, 1.01)), /source trim/);
});

test("derived frame ranges are contiguous and total durationInFrames", () => {
  const value = plan([sentence("one", "a"), sentence("two", "b")]);
  const props = buildProductionProps(inputs(value, 0.5));
  assert.deepEqual(props.sentences.map(({startFrame, voiceFrames, pauseFrames}) => ({startFrame, voiceFrames, pauseFrames})), [
    {startFrame: 0, voiceFrames: 15, pauseFrames: 5},
    {startFrame: 20, voiceFrames: 15, pauseFrames: 0},
  ]);
  assert.equal(props.durationInFrames, 35);
  assert.equal(validateProductionProps(props), props);
  assert.throws(() => validateProductionProps({...props, durationInFrames: 34}), /durationInFrames/);
});

test("subtitle opacity stays finite for short cues and one frame is fully visible", () => {
  for (let duration = 1; duration <= 16; duration++) {
    for (let frame = 0; frame < duration; frame++) assert.ok(Number.isFinite(subtitleOpacityAt(frame, 0, duration)));
  }
  assert.equal(subtitleOpacityAt(0, 0, 1), 1);
});

test("production composition uses the required sentence media clock", async () => {
  const source = await readFile(new URL("../packages/remotion-video/src/production-video.tsx", import.meta.url), "utf8");
  const root = await readFile(new URL("../packages/remotion-video/src/root.tsx", import.meta.url), "utf8");
  assert.match(root, /id="ProductMarketingProduction"/);
  assert.match(root, /calculateMetadata=\{calculateProductionMetadata\}/);
  assert.match(source, /validateProductionProps\(props\)/);
  assert.match(source, /<Sequence[\s\S]*from=\{sentence\.startFrame\}[\s\S]*durationInFrames=\{sentence\.voiceFrames \+ sentence\.pauseFrames\}/);
  assert.match(source, /<Freeze[\s\S]*frame=\{sentence\.voiceFrames - 1\}[\s\S]*active=\{\(frame\) => frame >= sentence\.voiceFrames\}/);
  assert.match(source, /<ShotLayer sentence=\{sentence\} fps=\{props\.fps\}/);
  assert.match(source, /<OverlayLayer sentence=\{sentence\} fps=\{props\.fps\}/);
  assert.doesNotMatch(source, /<OffthreadVideo/);
  assert.match(source, /<Audio[\s\S]*src=\{staticFile\(sentence\.wavPath\)\}[\s\S]*trimAfter=\{sentence\.voiceFrames\}/);
  assert.match(source, /flatMap\(captionCuesForSentence\)/);
});

test("visual overlays keep proof and feature labels inside the Douyin safe zone", async () => {
  const source = await readFile(new URL("../packages/remotion-video/src/components/overlay-layer.tsx", import.meta.url), "utf8");
  assert.match(source, /import \{DOUYIN_SAFE_ZONE\} from "\.\.\/visual-timing\.js"/);
  assert.match(source, /left: DOUYIN_SAFE_ZONE\.left, right: DOUYIN_SAFE_ZONE\.right/);
  assert.match(source, /maxWidth: 808, whiteSpace: "normal", overflowWrap: "anywhere"/);
  assert.match(source, /const proofMarkerMargin = 68;/);
  assert.match(source, /DOUYIN_SAFE_ZONE\.left \+ proofMarkerMargin/);
  assert.match(source, /1920 - DOUYIN_SAFE_ZONE\.bottom - proofMarkerMargin/);
});

test("production props type is owned by the shared contract", async () => {
  const source = await readFile(new URL("../packages/remotion-video/src/production-video.tsx", import.meta.url), "utf8");
  const contract = await readFile(new URL("../packages/remotion-video/src/production-contract.js", import.meta.url), "utf8");
  assert.match(source, /import type \{ProductionProps\} from "\.\/production-contract\.js";/);
  assert.doesNotMatch(source, /type ProductionSentence|(?:export )?type ProductionProps\s*=/);
  assert.match(contract, /@returns \{ProductionProps\}[\s\S]*export const buildProductionProps/);
});

test("production metadata reports the exact validated clock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remotion-production-"));
  const propsPath = join(directory, "props.json");
  const props = buildProductionProps(inputs(plan(), 0.5));
  await writeFile(propsPath, JSON.stringify(props));
  const run = promisify(execFile);
  const command = join(process.cwd(), "node_modules/.bin/remotion");
  const entry = join(process.cwd(), "packages/remotion-video/src/index.ts");
  const valid = await run(command, ["compositions", entry, `--props=${propsPath}`, `--public-dir=${directory}`]);
  assert.match(valid.stdout, /ProductMarketingProduction/);
  assert.match(valid.stdout, /15\s+\(0\.50 sec\)/);
});
