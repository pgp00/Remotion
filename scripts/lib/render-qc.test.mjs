import assert from "node:assert/strict";
import {execFile as execFileCallback} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {
  assertNoDuplicateFingerprints,
  assertQcMetadata,
  assertRenderManifest,
  assertSubtitlesFromScript,
  buildContactSamples,
  buildRenderProps,
  renderArgs,
} from "./render-qc.mjs";

const execFile = promisify(execFileCallback);
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const remotion = path.join(workspaceRoot, "node_modules/.bin/remotion");
const remotionCwd = path.join(workspaceRoot, "packages/remotion-video");

const timeline = {
  schemaVersion: 1,
  id: "real-contract",
  title: "真实素材契约",
  productSku: "REAL-SKU",
  status: "approved",
  width: 1080,
  height: 1920,
  fps: 30,
  durationInFrames: 600,
  brand: {name: "TEST", primary: "#fff", accent: "#0f0", text: "#fff", mutedText: "#aaa", fontFamily: "sans-serif"},
  clips: [{id: "clip-1", assetShotId: "shot-1", startFrame: 0, durationInFrames: 600, sourceInSeconds: 0, sourceOutSeconds: 20, label: "产品展示", sellingPoint: "产品展示", fit: "cover", focusX: 0.5, focusY: 0.5, placeholder: {from: "#000", to: "#111"}}],
  subtitles: [{id: "sub-1", startFrame: 0, endFrame: 300, text: "产品展示"}],
  voiceover: {id: "voice", kind: "voiceover", source: null, volume: 1, state: "not_configured"},
  music: {id: "music", kind: "music", source: null, volume: 0, state: "not_configured"},
  cta: "查看商品详情",
};

const validProps = {
  timeline,
  shots: {
    "shot-1": {id: "shot-1", sourceId: "source-1", sourcePath: "/Volumes/share/1.mp4", proxyPath: "proxies/source-1.mp4", sourceInSeconds: 0, sourceOutSeconds: 20, productSkus: [], tags: [], qualityScore: 0, confidence: 1, reviewState: "confirmed"},
  },
};

const runCompositions = async (props) => {
  const root = await mkdtemp(path.join(tmpdir(), "auto-edit-remotion-contract-"));
  const publicDir = path.join(root, "public");
  const propsPath = path.join(root, "props.json");
  await mkdir(publicDir);
  await writeFile(propsPath, JSON.stringify(props));
  return execFile(remotion, [
    "compositions", "src/index.ts", "--props", propsPath, "--public-dir", publicDir,
  ], {cwd: remotionCwd, maxBuffer: 16 * 1024 * 1024});
};

test("ProductMarketingReal accepts valid approved metadata", async () => {
  const {stdout} = await runCompositions(validProps);
  assert.match(stdout, /ProductMarketingReal/);
  assert.match(stdout, /MediaContactSheet/);
});

test("ProductMarketingReal blocks non-approved and unresolved shots", async () => {
  await assert.rejects(
    runCompositions({...validProps, timeline: {...timeline, status: "needs_review"}}),
    /approved/,
  );
  await assert.rejects(
    runCompositions({...validProps, shots: {}}),
    /shot-1/,
  );
});

test("ProductMarketingReal blocks continuity, focus, range, and proxy violations", async () => {
  const cases = [
    [{...validProps, timeline: {...timeline, clips: [{...timeline.clips[0], startFrame: 1, durationInFrames: 599}]}}, /start at frame 0/],
    [{...validProps, timeline: {...timeline, clips: [{...timeline.clips[0], focusX: 2}]}}, /focusX/],
    [{...validProps, timeline: {...timeline, clips: [{...timeline.clips[0], sourceOutSeconds: 21}]}}, /outside shot/],
    [{...validProps, shots: {"shot-1": {...validProps.shots["shot-1"], proxyPath: "../escape.mp4"}}}, /proxyPath/],
  ];
  for (const [props, pattern] of cases) await assert.rejects(runCompositions(props), pattern);
});

test("buildRenderProps keeps only referenced shots", () => {
  const extra = {...validProps.shots["shot-1"], id: "unused", sourceId: "unused"};
  const props = buildRenderProps({shots: [validProps.shots["shot-1"], extra], sources: []}, timeline);
  assert.deepEqual(Object.keys(props.shots), ["shot-1"]);
  assert.throws(() => buildRenderProps({shots: [], sources: []}, timeline), /shot-1/);
});

test("subtitles must be literal text from the user script", () => {
  assert.doesNotThrow(() => assertSubtitlesFromScript("开头。 产品展示，然后查看商品详情。", timeline));
  assert.throws(
    () => assertSubtitlesFromScript("完全无关", timeline),
    /sub-1/,
  );
});

test("selected sources cannot share a quick fingerprint", () => {
  const index = {
    shots: [validProps.shots["shot-1"]],
    sources: [{id: "source-1", quickFingerprint: "same"}],
  };
  assert.doesNotThrow(() => assertNoDuplicateFingerprints(index, timeline));
  const secondShot = {...validProps.shots["shot-1"], id: "shot-2", sourceId: "source-2"};
  const secondTimeline = {...timeline, clips: [
    {...timeline.clips[0], durationInFrames: 300, sourceOutSeconds: 10},
    {...timeline.clips[0], id: "clip-2", assetShotId: "shot-2", startFrame: 300, durationInFrames: 300, sourceInSeconds: 10, sourceOutSeconds: 20},
  ]};
  assert.throws(() => assertNoDuplicateFingerprints({
    shots: [validProps.shots["shot-1"], secondShot],
    sources: [{id: "source-1", quickFingerprint: "same"}, {id: "source-2", quickFingerprint: "same"}],
  }, secondTimeline), /duplicate fingerprint/);
});

test("final contact samples cover first, cuts, and last", () => {
  const twoClips = {...timeline, clips: [
    {...timeline.clips[0], durationInFrames: 300, sourceOutSeconds: 10},
    {...timeline.clips[0], id: "clip-2", startFrame: 300, durationInFrames: 300, sourceInSeconds: 10, sourceOutSeconds: 20},
  ]};
  assert.deepEqual(buildContactSamples(twoClips).map(({frame}) => frame), [0, 301, 599]);
});

test("QC requires exact video, silent AAC, and timeline frame count", () => {
  const valid = {
    format: {duration: "20.04", size: "123456"},
    streams: [
      {codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: 1080, height: 1920, avg_frame_rate: "30/1", nb_read_frames: "600"},
      {codec_type: "audio", codec_name: "aac"},
    ],
  };
  assert.equal(assertQcMetadata(valid, timeline).durationInSeconds, 20);
  for (const [field, mutate] of [
    ["codec", (value) => { value.streams[0].codec_name = "hevc"; }],
    ["pixel", (value) => { value.streams[0].pix_fmt = "yuvj420p"; }],
    ["size", (value) => { value.streams[0].width = 1920; }],
    ["fps", (value) => { value.streams[0].avg_frame_rate = "30000/1001"; }],
    ["audio", (value) => { value.streams = [value.streams[0]]; }],
    ["frames", (value) => { value.streams[0].nb_read_frames = "599"; }],
    ["container duration", (value) => { value.format.duration = "21"; }],
  ]) {
    const changed = structuredClone(valid);
    mutate(changed);
    assert.throws(() => assertQcMetadata(changed, timeline), undefined, field);
  }
});

test("render args disable overwrite and force silent AAC", () => {
  const args = renderArgs({
    partialOutputPath: "/repo/out/job.partial.mp4",
    propsPath: "/repo/work/job/props.json",
    publicDir: "/repo/work/job/public",
  });
  for (const flag of ["--codec=h264", "--pixel-format=yuv420p", "--color-space=bt709", "--audio-codec=aac", "--enforce-audio-track", "--overwrite=false"]) {
    assert.ok(args.includes(flag), flag);
  }
});

test("QC accepts only the props manifest that created the partial", () => {
  const propsBytes = Buffer.from('{"timeline":"approved"}\n');
  const propsSha256 = createHash("sha256").update(propsBytes).digest("hex");
  assert.equal(assertRenderManifest({render: {propsSha256}}, propsBytes), propsSha256);
  assert.throws(() => assertRenderManifest({render: {propsSha256: "stale"}}, propsBytes), /manifest/);
  assert.throws(() => assertRenderManifest({}, propsBytes), /manifest/);
});
