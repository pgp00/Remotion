import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {parseCli, runScan, runSearch} from "./asset-library.mjs";

const record = (id, relativePath = `${id}.mp4`) => ({
  id,
  sourcePath: `/fake/${relativePath}`,
  relativePath,
  sizeBytes: 10,
  mtimeMs: 1,
  durationInSeconds: 10,
  width: 1080,
  height: 1920,
  fps: 30,
  codec: "h264",
  tags: ["s5"],
  qualityFlags: [],
  state: "fingerprinted",
});

const fixture = async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "asset-library-cli-"));
  const sourceRoot = path.join(root, "source");
  const workDir = path.join(root, "work", "asset-library");
  await mkdir(sourceRoot, {recursive: true});
  await writeFile(path.join(sourceRoot, "clip.mp4"), "fixture");
  t.after(() => rm(root, {recursive: true, force: true}));
  return {sourceRoot, workDir};
};

const scanResult = (sourceRoot, assets = [record("first")]) => ({
  catalog: {schemaVersion: 1, sourceRoot, assets},
  checkpoint: {schemaVersion: 1, sourceRoot, assets},
  metrics: {discovered: assets.length, cached: 0, probed: assets.length, fingerprinted: assets.length, failed: 0},
  missing: [],
  warnings: [],
  sourceSnapshots: {before: {count: 1, bytes: 7, maxMtimeMs: 1}, after: {count: 1, bytes: 7, maxMtimeMs: 1}},
});

test("parseCli accepts the supported scan and repeated search filters", () => {
  assert.deepEqual(parseCli(["scan", "--source-root", "/tmp/source", "--work-dir", "work", "--resume", "run-1"]), {
    command: "scan", sourceRoot: "/tmp/source", workDir: "work", resume: "run-1", mediaConcurrency: 1,
  });
  assert.equal(parseCli(["scan", "--source-root", "/tmp/source", "--media-concurrency", "4"]).mediaConcurrency, 4);
  assert.deepEqual(parseCli(["search", "portrait", "--catalog", "catalog.json", "--tag", "s5", "--tag", "产品", "--state", "complete", "--flag", "ok", "--exclude-flag", "bad", "--orientation", "portrait", "--codec", "h264", "--min-duration", "3", "--max-duration", "10", "--json"]), {
    command: "search", keyword: "portrait", catalogPath: "catalog.json", tag: ["s5", "产品"], state: ["complete"], flag: ["ok"], excludeFlag: ["bad"], orientation: ["portrait"], codec: ["h264"], minDuration: 3, maxDuration: 10, json: true,
  });
  assert.throws(() => parseCli(["scan", "--source-root", "relative"]), /absolute/);
});

test("runScan creates the library layout, checkpoints media progress, and atomically publishes only after completion", async (t) => {
  const {sourceRoot, workDir} = await fixture(t);
  const assets = [record("first"), record("second", "second.mov")];
  const rendered = [];
  const result = await runScan({
    sourceRoot,
    workDir,
    resume: "resume-1",
    scanImpl: async (options) => {
      assert.equal(options.previousCatalog, null);
      return scanResult(sourceRoot, assets);
    },
    renderSheetsImpl: async ({record: asset}) => {
      rendered.push(asset.id);
      return {contactSheetPath: `contacts/${asset.id}.jpg`, ctaSheetPath: `cta/${asset.id}.jpg`, qualityFlags: ["mostly_black"]};
    },
    snapshotImpl: async () => ({count: 1, bytes: 7, maxMtimeMs: 1}),
  });
  assert.equal(result.runId, "resume-1");
  assert.deepEqual(rendered, ["first", "second"]);
  assert.ok((await Promise.all(["contacts", "cta", "runs", ".staging"].map((name) => stat(path.join(workDir, name))))).every((info) => info.isDirectory()));
  const catalog = JSON.parse(await readFile(path.join(workDir, "catalog.json"), "utf8"));
  assert.ok(catalog.assets.every((asset) => asset.state === "complete"));
  assert.ok(catalog.assets.every((asset) => asset.qualityFlags.includes("mostly_black")));
  const checkpoint = JSON.parse(await readFile(path.join(workDir, "checkpoint.json"), "utf8"));
  assert.ok(checkpoint.assets.every((asset) => asset.state === "complete"));
  const run = JSON.parse(await readFile(path.join(workDir, "runs", "resume-1.json"), "utf8"));
  assert.equal(run.status, "complete");
  await readFile(path.join(workDir, "manifest.json"), "utf8");
});

test("runScan renders media in bounded parallel shards", async (t) => {
  const {sourceRoot, workDir} = await fixture(t);
  const assets = [record("one"), record("two"), record("three"), record("four")];
  let active = 0;
  let peak = 0;
  const rendered = [];
  await runScan({
    sourceRoot,
    workDir,
    mediaConcurrency: 2,
    scanImpl: async () => scanResult(sourceRoot, assets),
    renderSheetsImpl: async ({record: asset}) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      rendered.push(asset.id);
      active -= 1;
      return {contactSheetPath: `contacts/${asset.id}.jpg`, ctaSheetPath: `cta/${asset.id}.jpg`, qualityFlags: []};
    },
    snapshotImpl: async () => ({count: 1, bytes: 7, maxMtimeMs: 1}),
  });
  assert.equal(peak, 2);
  assert.deepEqual(rendered.sort(), assets.map(({id}) => id).sort());
});

test("runScan retains the prior catalog when scanning or final source verification fails", async (t) => {
  const {sourceRoot, workDir} = await fixture(t);
  await mkdir(workDir, {recursive: true});
  const oldCatalog = {sourceRoot, assets: [record("old")]};
  await writeFile(path.join(workDir, "catalog.json"), JSON.stringify(oldCatalog));
  await assert.rejects(runScan({sourceRoot, workDir, scanImpl: async () => { throw new Error("mount disconnected"); }}), /mount disconnected/);
  assert.deepEqual(JSON.parse(await readFile(path.join(workDir, "catalog.json"), "utf8")), oldCatalog);
  await assert.rejects(runScan({
    sourceRoot,
    workDir,
    scanImpl: async () => scanResult(sourceRoot),
    snapshotImpl: async () => { throw new Error("mount disconnected late"); },
  }), /mount disconnected late/);
  assert.deepEqual(JSON.parse(await readFile(path.join(workDir, "catalog.json"), "utf8")), oldCatalog);
});

test("runScan refuses to write under the read-only source root", async (t) => {
  const {sourceRoot} = await fixture(t);
  await assert.rejects(runScan({sourceRoot, workDir: path.join(sourceRoot, "work"), scanImpl: async () => scanResult(sourceRoot)}), /outside sourceRoot|read-only/);
});

test("runScan persists a scan checkpoint before a mid-scan failure", async (t) => {
  const {sourceRoot, workDir} = await fixture(t);
  const partial = {schemaVersion: 1, sourceRoot, assets: [record("done")]};
  await assert.rejects(runScan({
    sourceRoot,
    workDir,
    scanImpl: async ({onCheckpoint}) => {
      await onCheckpoint(partial);
      throw new Error("interrupted");
    },
  }), /interrupted/);
  assert.deepEqual(JSON.parse(await readFile(path.join(workDir, "checkpoint.json"), "utf8")), partial);
});

test("runScan refuses to replace a prior catalog with an empty result", async (t) => {
  const {sourceRoot, workDir} = await fixture(t);
  await mkdir(workDir, {recursive: true});
  const oldCatalog = {sourceRoot, assets: [record("old")]};
  await writeFile(path.join(workDir, "catalog.json"), JSON.stringify(oldCatalog));
  await assert.rejects(
    runScan({sourceRoot, workDir, scanImpl: async () => ({catalog: {sourceRoot, assets: []}, checkpoint: {sourceRoot, assets: []}})}),
    /empty catalog/,
  );
  assert.deepEqual(JSON.parse(await readFile(path.join(workDir, "catalog.json"), "utf8")), oldCatalog);
});

test("runScan exposes a cleanup candidate only after two consecutive missing scans", async (t) => {
  const {sourceRoot, workDir} = await fixture(t);
  const missing = [record("gone", "gone.mp4")];
  const scan = async () => ({
    ...scanResult(sourceRoot),
    catalog: {sourceRoot, assets: [record("present")]},
    checkpoint: {sourceRoot, assets: [record("present")]},
    missing,
  });
  const snapshotImpl = async () => ({count: 1, bytes: 7, maxMtimeMs: 1});
  await runScan({sourceRoot, workDir, scanImpl: scan, snapshotImpl});
  const firstManifest = JSON.parse(await readFile(path.join(workDir, "manifest.json"), "utf8"));
  assert.deepEqual(firstManifest.missingCleanupCandidates, []);
  await runScan({sourceRoot, workDir, scanImpl: scan, snapshotImpl});
  const secondManifest = JSON.parse(await readFile(path.join(workDir, "manifest.json"), "utf8"));
  assert.deepEqual(secondManifest.missingCleanupCandidates, [{relativePath: "gone.mp4", missingScans: 2}]);
});

test("runSearch returns deterministic filtered records and JSON output", async (t) => {
  const {workDir} = await fixture(t);
  await mkdir(workDir, {recursive: true});
  await writeFile(path.join(workDir, "catalog.json"), JSON.stringify({assets: [
    {...record("portrait", "S5/portrait.mp4"), state: "complete"},
    {...record("duplicate", "S5/other.mov"), width: 1920, height: 1080, qualityFlags: ["duplicate_candidate"]},
  ]}));
  let output = "";
  const results = await runSearch({catalogPath: path.join(workDir, "catalog.json"), keyword: "s5", state: ["complete"], orientation: ["portrait"], json: true}, (value) => { output += value; });
  assert.deepEqual(results.map((asset) => asset.id), ["portrait"]);
  assert.deepEqual(JSON.parse(output).map((asset) => asset.id), ["portrait"]);
});
