import assert from "node:assert/strict";
import {mkdtemp, mkdir, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertDescendant,
  assertReadableProxyFiles,
  ensureWorkDirs,
  loadJobDefinition,
  loadJob,
  readJson,
  writeResult,
} from "./job.mjs";

const makeTree = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "auto-edit-job-"));
  const workspaceRoot = path.join(root, "repo");
  const mountRoot = path.join(root, "mount");
  const sourceRoot = path.join(mountRoot, "S16素材");
  await mkdir(path.join(workspaceRoot, "examples", "scripts"), {recursive: true});
  await mkdir(sourceRoot, {recursive: true});
  await writeFile(
    path.join(workspaceRoot, "examples", "scripts", "smoke.txt"),
    "产品展示",
  );
  return {root, workspaceRoot, mountRoot, sourceRoot};
};

test("assertDescendant rejects prefix tricks and equality", () => {
  assert.doesNotThrow(() => assertDescendant("/mount", "/mount/a", "sourceRoot"));
  assert.throws(() => assertDescendant("/mount", "/mount-other/a", "sourceRoot"));
  assert.throws(() => assertDescendant("/mount", "/mount", "sourceRoot"));
});

test("loadJob rejects illegal job IDs", async () => {
  for (const jobId of ["", "../x", "a/b", "中文"]) {
    const tree = await makeTree();
    const jobPath = path.join(tree.workspaceRoot, "job.json");
    await writeFile(jobPath, JSON.stringify({
      schemaVersion: 1,
      jobId,
      sourceRoot: tree.sourceRoot,
      scriptPath: "examples/scripts/smoke.txt",
      product: {sku: "TEST", name: "Test", sellingPoints: [], aliases: [], referenceImages: []},
      target: {width: 1080, height: 1920, fps: 30, minDurationSeconds: 20, maxDurationSeconds: 40},
    }));
    await assert.rejects(loadJob(jobPath, tree), /jobId/);
  }
});

test("loadJob resolves only a strict mounted descendant", async () => {
  const tree = await makeTree();
  const jobPath = path.join(tree.workspaceRoot, "job.json");
  await writeFile(jobPath, JSON.stringify({
    schemaVersion: 1,
    jobId: "s16-smoke",
    sourceRoot: tree.sourceRoot,
    scriptPath: "examples/scripts/smoke.txt",
    product: {sku: "TEST", name: "Test", sellingPoints: [], aliases: [], referenceImages: []},
    target: {width: 1080, height: 1920, fps: 30, minDurationSeconds: 20, maxDurationSeconds: 40},
  }));
  const {config, paths} = await loadJob(jobPath, tree);
  assert.equal(config.scriptPath, path.join(tree.workspaceRoot, "examples/scripts/smoke.txt"));
  assert.deepEqual(Object.keys(paths).sort(), [
    "contactsDir", "finalCutContactPath", "indexPath", "jobId", "outputPath",
    "partialOutputPath", "propsPath", "proxiesDir", "publicDir", "resultPath",
    "sourceRoot", "timelinePath", "workDir", "workspaceRoot",
  ]);
  assert.equal(paths.workDir, path.join(tree.workspaceRoot, "work/s16-smoke"));
  assert.equal(paths.outputPath, path.join(tree.workspaceRoot, "out/s16-smoke.mp4"));
});

test("loadJob rejects a sourceRoot symlink escaping the mount", async () => {
  const tree = await makeTree();
  const outside = path.join(tree.root, "outside");
  const link = path.join(tree.mountRoot, "escape");
  await mkdir(outside);
  await symlink(outside, link);
  const jobPath = path.join(tree.workspaceRoot, "job.json");
  await writeFile(jobPath, JSON.stringify({
    schemaVersion: 1,
    jobId: "escape",
    sourceRoot: link,
    scriptPath: "examples/scripts/smoke.txt",
    product: {sku: "TEST", name: "Test", sellingPoints: [], aliases: [], referenceImages: []},
    target: {width: 1080, height: 1920, fps: 30, minDurationSeconds: 20, maxDurationSeconds: 40},
  }));
  await assert.rejects(loadJob(jobPath, tree), /sourceRoot/);
});

test("proxy validation rejects absolute, escaping, missing, and directory paths", async () => {
  const tree = await makeTree();
  const publicDir = path.join(tree.workspaceRoot, "work/job/public");
  await mkdir(path.join(publicDir, "proxies"), {recursive: true});
  await writeFile(path.join(publicDir, "proxies/ok.mp4"), "ok");
  const props = (proxyPath) => ({shots: {shot: {id: "shot", proxyPath}}});
  await assertReadableProxyFiles(props("proxies/ok.mp4"), publicDir);
  await assert.rejects(assertReadableProxyFiles(props("/tmp/x.mp4"), publicDir), /relative/);
  await assert.rejects(assertReadableProxyFiles(props("../x.mp4"), publicDir), /escape/);
  await assert.rejects(assertReadableProxyFiles(props("proxies/missing.mp4"), publicDir), /readable/);
  await assert.rejects(assertReadableProxyFiles(props("proxies"), publicDir), /regular file/);
});

test("ensureWorkDirs rejects an output-directory symlink escape", async () => {
  const tree = await makeTree();
  const outside = path.join(tree.root, "derived-outside");
  await mkdir(outside);
  await symlink(outside, path.join(tree.workspaceRoot, "work"));
  const workDir = path.join(tree.workspaceRoot, "work/job");
  await assert.rejects(ensureWorkDirs({
    workspaceRoot: tree.workspaceRoot,
    workDir,
    publicDir: path.join(workDir, "public"),
    proxiesDir: path.join(workDir, "public/proxies"),
    contactsDir: path.join(workDir, "contacts"),
    outputPath: path.join(tree.workspaceRoot, "out/job.mp4"),
  }), /symbolic link/);
});

test("loadJobDefinition does not require a mounted source", async () => {
  const tree = await makeTree();
  const missingSource = path.join(tree.mountRoot, "missing-batch");
  const jobPath = path.join(tree.workspaceRoot, "missing-source.json");
  await writeFile(jobPath, JSON.stringify({
    schemaVersion: 1,
    jobId: "missing-source",
    sourceRoot: missingSource,
    scriptPath: "examples/scripts/smoke.txt",
    product: {sku: "TEST", name: "Test", sellingPoints: [], aliases: [], referenceImages: []},
    target: {width: 1080, height: 1920, fps: 30, minDurationSeconds: 20, maxDurationSeconds: 40},
  }));
  const definition = await loadJobDefinition(jobPath, tree);
  assert.equal(definition.paths.sourceRoot, missingSource);
  await assert.rejects(loadJob(jobPath, tree), /ENOENT|no such file/i);
});

test("writeResult preserves review notes while trusted status fields win", async () => {
  const tree = await makeTree();
  const paths = {
    jobId: "state-test",
    resultPath: path.join(tree.workspaceRoot, "work/state-test/result.json"),
  };
  const reviewNotes = {selectedShots: [{clipId: "clip-1"}], lowConfidence: []};
  await writeResult(paths, "needs_review", {reviewNotes, status: "complete", jobId: "spoofed"});
  await writeResult(paths, "render_failed", {error: "render broke"});
  const result = await readJson(paths.resultPath);
  assert.equal(result.status, "render_failed");
  assert.equal(result.jobId, "state-test");
  assert.deepEqual(result.reviewNotes, reviewNotes);
});
