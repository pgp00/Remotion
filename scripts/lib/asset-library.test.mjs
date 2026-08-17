import assert from "node:assert/strict";
import {mkdtemp, mkdir, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractTags,
  qualityFlagsForMetadata,
  scanAssetLibrary,
  searchAssets,
} from "./asset-library.mjs";

const metadata = {durationInSeconds: 10, width: 1080, height: 1920, fps: 30, codec: "h264", rotation: 0, hasAudio: true};

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "asset-library-"));
  await mkdir(path.join(root, "12.20 S5", "产品展示"), {recursive: true});
  await writeFile(path.join(root, "12.20 S5", "产品展示", "same-a.mp4"), "same");
  await writeFile(path.join(root, "12.20 S5", "产品展示", "same-b.mov"), "same");
  await writeFile(path.join(root, "broken.m4v"), "broken");
  return root;
};

test("scanAssetLibrary retains per-file failures, fingerprints every successful video, and groups duplicates", async (t) => {
  const sourceRoot = await fixture();
  t.after(() => rm(sourceRoot, {recursive: true, force: true}));
  const calls = [];
  const checkpoints = [];
  const result = await scanAssetLibrary({
    sourceRoot,
    workDir: path.join(sourceRoot, "work"),
    probe: async (sourcePath) => {
      calls.push(path.basename(sourcePath));
      if (sourcePath.endsWith("broken.m4v")) throw new Error("bad media");
      return metadata;
    },
    now: () => new Date("2026-08-07T00:00:00.000Z"),
    onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint.assets.length),
  });

  assert.deepEqual(result.metrics, {discovered: 3, cached: 0, probed: 3, fingerprinted: 2, failed: 1});
  assert.deepEqual(calls.sort(), ["broken.m4v", "same-a.mp4", "same-b.mov"]);
  assert.equal(result.catalog.assets.length, 3);
  const successful = result.catalog.assets.filter((asset) => asset.state === "fingerprinted");
  assert.equal(successful.length, 2);
  assert.ok(successful.every((asset) => asset.quickFingerprint));
  assert.ok(successful.every((asset) => asset.qualityFlags.includes("duplicate_candidate")));
  assert.equal(new Set(successful.map((asset) => asset.duplicateGroup)).size, 1);
  assert.deepEqual(successful[0].tags, ["12.20 s5", "12.20", "s5", "产品展示", "产品", "same a", "same", "a"]);
  const failed = result.catalog.assets.find((asset) => asset.relativePath === "broken.m4v");
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.error, {stage: "probe", message: "bad media"});
  assert.ok(failed.qualityFlags.includes("probe_failed"));
  assert.equal(result.checkpoint.assets.length, 3);
  assert.deepEqual(checkpoints, [1, 2, 3]);
  assert.deepEqual(result.catalog.sourceSnapshot, {count: 3, bytes: 14, maxMtimeMs: result.catalog.sourceSnapshot.maxMtimeMs});
  await assert.rejects(stat(path.join(sourceRoot, "work")), /ENOENT/);
});

test("scanAssetLibrary reuses unchanged records, reports missing records, and isolates fingerprint failures", async (t) => {
  const sourceRoot = await fixture();
  t.after(() => rm(sourceRoot, {recursive: true, force: true}));
  const probeCalls = [];
  const first = await scanAssetLibrary({
    sourceRoot,
    workDir: path.join(sourceRoot, "work"),
    probe: async (sourcePath) => {
      probeCalls.push(path.basename(sourcePath));
      if (sourcePath.endsWith("broken.m4v")) throw new Error("bad media");
      return metadata;
    },
  });
  await rm(path.join(sourceRoot, "12.20 S5", "产品展示", "same-b.mov"));
  probeCalls.length = 0;
  const second = await scanAssetLibrary({
    sourceRoot,
    workDir: path.join(sourceRoot, "work"),
    previousCatalog: first.catalog,
    checkpoint: first.checkpoint,
    probe: async (sourcePath) => {
      probeCalls.push(path.basename(sourcePath));
      if (sourcePath.endsWith("broken.m4v")) throw new Error("bad media");
      return metadata;
    },
  });
  assert.deepEqual(second.metrics, {discovered: 2, cached: 1, probed: 1, fingerprinted: 0, failed: 1});
  assert.deepEqual(probeCalls, ["broken.m4v"]);
  assert.deepEqual(second.missing.map((asset) => asset.relativePath), ["12.20 S5/产品展示/same-b.mov"]);

  await writeFile(path.join(sourceRoot, "fingerprint-fails.mp4"), "ok");
  const third = await scanAssetLibrary({
    sourceRoot,
    workDir: path.join(sourceRoot, "work"),
    probe: async (sourcePath) => sourcePath.endsWith("broken.m4v") ? Promise.reject(new Error("bad media")) : metadata,
    fingerprint: async (sourcePath) => {
      if (sourcePath.endsWith("fingerprint-fails.mp4")) throw new Error("cannot read");
      return "fingerprint";
    },
  });
  const fingerprintFailure = third.catalog.assets.find((asset) => asset.relativePath === "fingerprint-fails.mp4");
  assert.deepEqual(fingerprintFailure.error, {stage: "fingerprint", message: "cannot read"});
  assert.equal(fingerprintFailure.state, "failed");
  assert.equal(third.catalog.assets.filter((asset) => asset.state === "fingerprinted").length, 1);
});

test("tags, metadata flags, and search use only deterministic local record fields", () => {
  assert.deepEqual(extractTags("12.20 S5/产品展示/模特_使用展示.MP4"), [
    "12.20 s5", "12.20", "s5", "产品展示", "产品", "模特 使用展示", "模特", "使用展示",
  ]);
  assert.deepEqual(qualityFlagsForMetadata({...metadata, durationInSeconds: 0.5, width: 640, fps: 12}), [
    "too_short", "low_resolution", "invalid_fps",
  ]);
  const catalog = {assets: [
    {id: "portrait", relativePath: "S5/产品.mp4", tags: ["s5", "产品"], state: "complete", qualityFlags: [], width: 1080, height: 1920, rotation: 0, codec: "h264", durationInSeconds: 12},
    {id: "duplicate", relativePath: "S5/other.mov", tags: ["s5"], state: "fingerprinted", qualityFlags: ["duplicate_candidate"], width: 1920, height: 1080, rotation: 0, codec: "hevc", durationInSeconds: 3},
  ]};
  assert.deepEqual(searchAssets(catalog, {tag: "s5", state: "complete", orientation: "portrait", minDuration: 10}).map((asset) => asset.id), ["portrait"]);
  assert.deepEqual(searchAssets(catalog, {keyword: "s5", excludeFlag: "duplicate_candidate"}).map((asset) => asset.id), ["portrait"]);
});

test("scanAssetLibrary rejects an unreadable source root before publishing a new catalog", async () => {
  await assert.rejects(
    scanAssetLibrary({sourceRoot: path.join(tmpdir(), "does-not-exist-asset-library"), workDir: tmpdir()}),
    /ENOENT/,
  );
});

test("scanAssetLibrary refuses an empty source root", async (t) => {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), "asset-library-empty-"));
  t.after(() => rm(sourceRoot, {recursive: true, force: true}));
  await assert.rejects(scanAssetLibrary({sourceRoot}), /no supported video files/);
});

test("scanAssetLibrary preserves visual flags and retries only failed frame derivatives", async (t) => {
  const sourceRoot = await fixture();
  t.after(() => rm(sourceRoot, {recursive: true, force: true}));
  const first = await scanAssetLibrary({sourceRoot, probe: async () => metadata});
  const cached = first.catalog.assets.find((asset) => asset.state === "fingerprinted");
  cached.state = "failed";
  cached.error = {stage: "frames", message: "sheet failed"};
  cached.qualityFlags.push("mostly_black");
  let probes = 0;
  const second = await scanAssetLibrary({
    sourceRoot,
    previousCatalog: first.catalog,
    probe: async () => { probes += 1; return metadata; },
  });
  assert.equal(probes, 0); // frames failure reuses validated probe/fingerprint metadata
  const resumed = second.catalog.assets.find((asset) => asset.id === cached.id);
  assert.equal(resumed.state, "fingerprinted");
  assert.ok(resumed.qualityFlags.includes("mostly_black"));
});

test("scanAssetLibrary keeps every record when every probe fails", async (t) => {
  const sourceRoot = await fixture();
  t.after(() => rm(sourceRoot, {recursive: true, force: true}));
  const result = await scanAssetLibrary({
    sourceRoot,
    workDir: path.join(sourceRoot, "work"),
    probe: async () => { throw new Error("unreadable media"); },
  });
  assert.equal(result.catalog.assets.length, 3);
  assert.ok(result.catalog.assets.every((asset) => asset.state === "failed"));
  assert.ok(result.catalog.assets.every((asset) => asset.qualityFlags.length === 1 && asset.qualityFlags[0] === "probe_failed"));
});
