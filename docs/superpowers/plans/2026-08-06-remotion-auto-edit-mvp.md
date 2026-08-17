# Remotion Single-Batch Auto-Edit MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, restartable pipeline that reads one explicitly selected SMB batch, lets Codex produce one approved 20–40 second vertical Timeline from the user's script, and renders and verifies one real-footage MP4 with Remotion.

**Architecture:** A Node `.mjs` CLI owns the deterministic stages `index → prepare → validate → render → qc`; its only external executables are system `ffmpeg`/`ffprobe` and the already-installed Remotion CLI. Codex runs between `prepare` and `validate` to inspect local contact sheets and author `timeline.json`; all SMB access is read-only and every derived artifact is constrained to local `work/<job-id>/` and `out/` paths.

**Tech Stack:** Node.js `>=20` standard library, TypeScript 5.9.3, React, Remotion/@remotion CLI 4.0.496 from the current lockfile, system FFmpeg/ffprobe, `node:test`, `assert`.

## Global Constraints

- Treat `/Volumes/192.168.50.79` and every configured `sourceRoot` below it as read-only; never create, rename, move, delete, or modify an SMB file.
- The SMB share is currently disconnected. Real Stage 1–5 acceptance must wait until the user remounts `smb://192.168.50.79/D`; a missing mount must exit nonzero with `index_failed`, never fall back to demo footage.
- Accept only `.mp4`, `.mov`, and `.m4v` media, case-insensitively, inside one explicit `sourceRoot`; never scan the whole share.
- Write derived state only to `work/<job-id>/` and `out/<job-id>.mp4`; constrain every resolved output path to the repository root.
- `jobId` must match `/^[A-Za-z0-9_-]+$/`.
- Use 1080×1920, 30fps, and 600–1200 frames (20–40 seconds) for every real MVP Timeline.
- Generate one traceable draft, not three candidates. Keep source audio muted; force a silent AAC output track; leave TTS and music `not_configured`.
- Do not add npm dependencies, a database, queue, cloud model call, TTS, BGM, Web editor, tracking, source relinking, or automatic claim writing.
- Do not run `npm install` or rewrite the lockfile; use the already-installed Remotion/@remotion CLI 4.0.496 and fail Stage 0 if `npm ls` reports another version.
- Use `execFile()` with argument arrays for all child processes; never interpolate a shell command.
- Use Node's standard library for JSON, hashing, traversal, atomic rename, and tests.
- Current `/opt/homebrew/bin/ffmpeg` 8.1.1 has no `drawtext` or `subtitles` filter. Render labels with one Remotion `MediaContactSheet` Still; do not install another FFmpeg or silently omit labels.
- Preserve `ProductMarketingDemo`, the current Web demo, and `out/demo-product.mp4` behavior.
- Do not initialize Git: this workspace currently has no `.git`. Every commit step below is conditional—run it only if `git rev-parse --is-inside-work-tree` succeeds; otherwise record “commit skipped: workspace is not a Git worktree” and continue.

---

## Locked File Map

| Path | Action | Single responsibility |
|---|---|---|
| `packages/shared/src/index.ts` | Modify | Add source/index/render contracts and optional framing fields. |
| `packages/core/src/validate-timeline.ts` | Modify | Keep `validateTimeline()` and add pure cross-entity `validateRenderJob()`. |
| `scripts/lib/job.mjs` | Create | Parse job JSON, enforce path trust boundaries, provide `JobPaths`, atomic JSON, and proxy readability checks. |
| `scripts/lib/job.test.mjs` | Create | Job schema and containment tests. |
| `scripts/lib/index-assets.mjs` | Create | Read-only discovery, ffprobe parsing, cache, fingerprinting, and index assembly. |
| `scripts/lib/index-assets.test.mjs` | Create | Filtering, sorting, probing, cache, and fingerprint tests. |
| `scripts/lib/prepare-media.mjs` | Create | Generate/verify local proxies and source contact sheets. |
| `scripts/lib/prepare-media.test.mjs` | Create | Sampling, command, resume, and per-source failure tests. |
| `scripts/lib/render-qc.mjs` | Create | Build props, validate through Remotion, render partial output, verify it, render final contact sheet, and promote atomically. |
| `scripts/lib/render-qc.test.mjs` | Create | Subtitle, props, render-command, cut-sample, and QC metadata tests. |
| `scripts/auto-edit.mjs` | Create | Parse CLI arguments, run stages, and map failures to the approved statuses. |
| `scripts/auto-edit.test.mjs` | Create | Stage range, stop/resume, and status-transition tests. |
| `packages/remotion-video/src/contact-sheet.tsx` | Create | Render labeled frames from a public-dir video as one JPEG Still. |
| `packages/remotion-video/src/product-marketing-real.tsx` | Create | Render real `AssetShot` proxies with `OffthreadVideo`. |
| `packages/remotion-video/src/product-marketing-video.tsx` | Modify | Export and reuse the existing brand/subtitle/CTA chrome. |
| `packages/remotion-video/src/root.tsx` | Modify | Register `ProductMarketingReal` and `MediaContactSheet` while preserving the demo. |
| `examples/jobs/s16-smoke.json` | Create | Approved two-file S16 smoke job. |
| `examples/scripts/shaver-smoke.txt` | Create | Neutral, non-claim S16 smoke script. |
| `examples/jobs/4-27-scale.json` | Create | Neutral 76-file scale job. |
| `examples/scripts/4-27-scale.txt` | Create | Neutral scale-test script. |
| `skills/auto-edit-product-video/SKILL.md` | Modify | Encode the two-pass one-draft approval workflow. |
| `skills/auto-edit-product-video/references/timeline-contract.md` | Modify | Document real Timeline/props invariants. |
| `skills/auto-edit-product-video/agents/openai.yaml` | Modify | Change the default prompt from three drafts to one traceable Timeline. |
| `package.json` | Modify | Add `auto:edit` and `test:auto-edit` scripts; add no dependency. |
| `.gitignore` | Modify | Ignore `work/`; existing `out/*.mp4` already covers partial renders. |

The implementation deliberately keeps source probing metadata in `AssetSource` at the approved contract size. `parseProbeJson()` also reads container, pixel/color, and audio-sample fields for diagnostics, but only required render fields are persisted. A failed probe uses numeric zeroes, an empty codec, `status: "failed"`, and a non-empty `error`, and produces no `AssetShot`.

---

### Task 1: Add the Shared Data Contracts

**Files:**
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: existing `AssetShot`, `Timeline`, and `TimelineClip`.
- Produces: `AssetSource`, `AssetIndex`, `RenderJobProps`; `TimelineClip.fit`, `focusX`, and `focusY`.

- [ ] **Step 1: Prove the baseline is green**

Run:

```bash
npm run typecheck
```

Expected: exit 0 for all current workspaces.

- [ ] **Step 2: Add the approved contracts**

Append these fields inside the existing `TimelineClip` interface, immediately before `placeholder`:

```ts
  fit?: "cover" | "contain";
  focusX?: number;
  focusY?: number;
```

Append these declarations after `AssetShot`:

```ts
export interface AssetSource {
  id: string;
  sourcePath: string;
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
  durationInSeconds: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  rotation: number;
  hasAudio: boolean;
  quickFingerprint: string | null;
  proxyPath: string | null;
  contactSheetPath: string | null;
  status: "indexed" | "prepared" | "skipped" | "failed";
  error: string | null;
}

export interface AssetIndex {
  schemaVersion: 1;
  sourceRoot: string;
  scannedAt: string;
  sources: AssetSource[];
  shots: AssetShot[];
}

export interface RenderJobProps {
  timeline: Timeline;
  shots: Record<string, AssetShot>;
}
```

- [ ] **Step 3: Verify every existing consumer still compiles**

Run:

```bash
npm run typecheck
```

Expected: exit 0; no demo fixture change is required because the three framing fields are optional.

- [ ] **Step 4: Commit if Git is available**

```bash
git rev-parse --is-inside-work-tree && git add packages/shared/src/index.ts && git commit -m "feat: add real media contracts"
```

Expected in this workspace: the first command reports that this is not a Git repository, so skip the commit without initializing one.

---

### Task 2: Enforce Job and Filesystem Trust Boundaries

**Files:**
- Create: `scripts/lib/job.mjs`
- Create: `scripts/lib/job.test.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: one UTF-8 job JSON path and an optional test-only mount root.
- Produces:

```js
loadJob(jobFile, options) // Promise<{config, paths: JobPaths}>
ensureWorkDirs(paths) // Promise<void>
readJson(filePath) // Promise<unknown>
writeJsonAtomic(filePath, value) // Promise<void>
writeResult(paths, status, detail) // Promise<void>
assertReadableProxyFiles(props, publicDir) // Promise<void>
assertDescendant(parent, child, label) // void
```

`JobPaths` is locked to these fields:

```js
/**
 * @typedef {object} JobPaths
 * @property {string} jobId
 * @property {string} workspaceRoot
 * @property {string} sourceRoot
 * @property {string} workDir
 * @property {string} publicDir
 * @property {string} proxiesDir
 * @property {string} contactsDir
 * @property {string} indexPath
 * @property {string} timelinePath
 * @property {string} propsPath
 * @property {string} resultPath
 * @property {string} partialOutputPath
 * @property {string} outputPath
 * @property {string} finalCutContactPath
 */
```

- [ ] **Step 1: Add failing trust-boundary tests**

Create `scripts/lib/job.test.mjs` with tests that use only `mkdtemp()` under `os.tmpdir()`. The core cases must be written exactly as assertions, not as snapshots:

```js
import assert from "node:assert/strict";
import {mkdtemp, mkdir, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertDescendant,
  assertReadableProxyFiles,
  ensureWorkDirs,
  loadJob,
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
```

- [ ] **Step 2: Run the test and confirm the module is missing**

Run:

```bash
node --test scripts/lib/job.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/lib/job.mjs`.

- [ ] **Step 3: Implement the minimal job module**

Create `scripts/lib/job.mjs`. Use these exact checks and path derivations:

```js
import {constants as fsConstants} from "node:fs";
import {randomUUID} from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const JOB_ID_RE = /^[A-Za-z0-9_-]+$/;
const STATUSES = new Set([
  "index_failed", "indexed", "prepare_failed", "prepared", "needs_review",
  "validation_failed", "render_failed", "qc_failed", "complete",
]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const readUtf8 = async (filePath) => new TextDecoder("utf-8", {fatal: true}).decode(await readFile(filePath));

export const assertDescendant = (parent, child, label = "path") => {
  const relative = path.relative(parent, child);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a strict descendant of ${parent}: ${child}`);
  }
};

const validateStringArray = (value, label, errors) => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    errors.push(`${label} must be an array of strings.`);
  }
};

const validateConfig = (value) => {
  const errors = [];
  if (!isObject(value)) errors.push("Job config must be a JSON object.");
  if (value?.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  if (typeof value?.jobId !== "string" || !JOB_ID_RE.test(value.jobId)) errors.push("jobId must match /^[A-Za-z0-9_-]+$/.");
  if (typeof value?.sourceRoot !== "string" || !path.isAbsolute(value.sourceRoot)) errors.push("sourceRoot must be an absolute path.");
  if (typeof value?.scriptPath !== "string" || value.scriptPath.length === 0) errors.push("scriptPath must be a non-empty string.");
  if (!isObject(value?.product)) {
    errors.push("product must be an object.");
  } else {
    for (const key of ["sku", "name"]) {
      if (typeof value.product[key] !== "string" || value.product[key].length === 0) errors.push(`product.${key} must be non-empty.`);
    }
    validateStringArray(value.product.sellingPoints, "product.sellingPoints", errors);
    validateStringArray(value.product.aliases, "product.aliases", errors);
    validateStringArray(value.product.referenceImages, "product.referenceImages", errors);
  }
  const target = value?.target;
  if (!isObject(target)) {
    errors.push("target must be an object.");
  } else if (
    target.width !== 1080 || target.height !== 1920 || target.fps !== 30 ||
    target.minDurationSeconds !== 20 || target.maxDurationSeconds !== 40
  ) {
    errors.push("target must be exactly 1080x1920, 30fps, 20-40 seconds.");
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return value;
};

export const loadJob = async (
  jobFile,
  {workspaceRoot = process.cwd(), mountRoot = "/Volumes/192.168.50.79"} = {},
) => {
  const realWorkspace = await realpath(workspaceRoot);
  const resolvedJobFile = path.resolve(realWorkspace, jobFile);
  assertDescendant(realWorkspace, resolvedJobFile, "jobFile");
  const raw = validateConfig(JSON.parse(await readUtf8(resolvedJobFile)));
  const [realMount, realSource] = await Promise.all([realpath(mountRoot), realpath(raw.sourceRoot)]);
  assertDescendant(realMount, realSource, "sourceRoot");
  const sourceStat = await stat(realSource);
  if (!sourceStat.isDirectory()) throw new Error("sourceRoot must be a readable directory.");
  await access(realSource, fsConstants.R_OK);

  const scriptCandidate = path.isAbsolute(raw.scriptPath)
    ? raw.scriptPath
    : path.resolve(realWorkspace, raw.scriptPath);
  const scriptPath = await realpath(scriptCandidate);
  assertDescendant(realWorkspace, scriptPath, "scriptPath");
  if (!(await stat(scriptPath)).isFile()) throw new Error("scriptPath must be a regular file.");
  await access(scriptPath, fsConstants.R_OK);
  await readUtf8(scriptPath);

  const workDir = path.join(realWorkspace, "work", raw.jobId);
  const publicDir = path.join(workDir, "public");
  const contactsDir = path.join(workDir, "contacts");
  const outputPath = path.join(realWorkspace, "out", `${raw.jobId}.mp4`);
  const paths = {
    jobId: raw.jobId,
    workspaceRoot: realWorkspace,
    sourceRoot: realSource,
    workDir,
    publicDir,
    proxiesDir: path.join(publicDir, "proxies"),
    contactsDir,
    indexPath: path.join(workDir, "index.json"),
    timelinePath: path.join(workDir, "timeline.json"),
    propsPath: path.join(workDir, "props.json"),
    resultPath: path.join(workDir, "result.json"),
    partialOutputPath: path.join(realWorkspace, "out", `${raw.jobId}.partial.mp4`),
    outputPath,
    finalCutContactPath: path.join(contactsDir, "final-cut.jpg"),
  };
  for (const output of [workDir, publicDir, contactsDir, outputPath, paths.partialOutputPath]) {
    assertDescendant(realWorkspace, output, "derived path");
  }
  return {config: {...raw, scriptPath}, paths};
};

const ensureSafeDirectory = async (workspaceRoot, directory) => {
  assertDescendant(workspaceRoot, directory, "derived directory");
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink()) throw new Error(`Derived directory may not be a symbolic link: ${directory}`);
    if (!info.isDirectory()) throw new Error(`Derived directory path is not a directory: ${directory}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(directory);
  }
  assertDescendant(workspaceRoot, await realpath(directory), "derived directory realpath");
};

export const ensureWorkDirs = async (paths) => {
  const workRoot = path.join(paths.workspaceRoot, "work");
  const outRoot = path.dirname(paths.outputPath);
  for (const directory of [workRoot, outRoot, paths.workDir, paths.publicDir, paths.proxiesDir, paths.contactsDir]) {
    await ensureSafeDirectory(paths.workspaceRoot, directory);
  }
};

export const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

export const writeJsonAtomic = async (filePath, value) => {
  await mkdir(path.dirname(filePath), {recursive: true});
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {encoding: "utf8", flag: "wx"});
  await rename(temporary, filePath);
};

export const writeResult = async (paths, status, detail = {}) => {
  if (!STATUSES.has(status)) throw new Error(`Unknown result status: ${status}`);
  await writeJsonAtomic(paths.resultPath, {
    ...detail,
    schemaVersion: 1,
    jobId: paths.jobId,
    status,
    updatedAt: new Date().toISOString(),
  });
};

export const assertReadableProxyFiles = async (props, publicDir) => {
  const realPublic = await realpath(publicDir);
  for (const [key, shot] of Object.entries(props.shots ?? {})) {
    const proxyPath = shot?.proxyPath;
    if (typeof proxyPath !== "string" || proxyPath.length === 0 || path.isAbsolute(proxyPath)) {
      throw new Error(`Shot ${key} proxyPath must be a non-empty public-dir relative path.`);
    }
    const candidate = path.resolve(realPublic, proxyPath);
    assertDescendant(realPublic, candidate, `Shot ${key} proxyPath escape`);
    let resolved;
    try {
      resolved = await realpath(candidate);
      assertDescendant(realPublic, resolved, `Shot ${key} proxyPath escape`);
      await access(resolved, fsConstants.R_OK);
    } catch (error) {
      throw new Error(`Shot ${key} proxy is not readable: ${error.message}`);
    }
    if (!(await stat(resolved)).isFile()) throw new Error(`Shot ${key} proxy must be a regular file.`);
  }
};
```

- [ ] **Step 4: Run the trust-boundary tests**

Run:

```bash
node --test scripts/lib/job.test.mjs
```

Expected: all tests PASS. If the platform denies symlink creation, skip only that one test with `t.skip()` and retain the production realpath check.

- [ ] **Step 5: Add repository scripts and ignores**

Add these root `package.json` scripts without changing dependencies:

```json
"auto:edit": "node scripts/auto-edit.mjs",
"test:auto-edit": "node --test scripts/lib/*.test.mjs"
```

Append to `.gitignore`:

```gitignore
work/
```

Do not add a separate partial pattern: the existing `out/*.mp4` already ignores both final and `.partial.mp4` outputs.

Run:

```bash
node --test scripts/lib/job.test.mjs
npm run typecheck
```

Expected: selected Node tests PASS and all TypeScript workspaces exit 0.

- [ ] **Step 6: Commit if Git is available**

```bash
git rev-parse --is-inside-work-tree && git add scripts/lib/job.mjs scripts/lib/job.test.mjs package.json .gitignore && git commit -m "feat: protect auto-edit job paths"
```

---

### Task 3: Build the Read-Only Incremental Asset Index

**Files:**
- Create: `scripts/lib/index-assets.mjs`
- Create: `scripts/lib/index-assets.test.mjs`

**Interfaces:**
- Consumes: `config`, `paths.sourceRoot`, and optional prior `AssetIndex`.
- Produces:

```js
isAcceptedMedia(relativePath) // boolean
naturalSort(paths) // string[]
parseFrameRate(value) // number
parseProbeJson(json) // probe metadata object
probeVideo(sourcePath, options) // Promise<probe metadata object>
createSourceId(relativePath, sizeBytes, mtimeMs) // hex string
quickFingerprint(sourcePath, sizeBytes) // Promise<hex string>
assertIndexMatchesSourceRoot(index, sourceRoot) // void
indexAssets({sourceRoot, previousIndex, probe, now})
// Promise<{index, metrics: {sources, cached, probed, failed}}>
```

- [ ] **Step 1: Write failing filtering, parsing, cache, and fingerprint tests**

Create `scripts/lib/index-assets.test.mjs` using local temporary files. Include these assertions:

```js
import assert from "node:assert/strict";
import {mkdtemp, mkdir, stat, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertIndexMatchesSourceRoot,
  createSourceId,
  indexAssets,
  isAcceptedMedia,
  naturalSort,
  parseFrameRate,
  parseProbeJson,
  quickFingerprint,
} from "./index-assets.mjs";

test("filters supported media and excluded path segments", () => {
  assert.equal(isAcceptedMedia("1.MP4"), true);
  assert.equal(isAcceptedMedia("folder/clip.mov"), true);
  assert.equal(isAcceptedMedia("folder/clip.m4v"), true);
  for (const name of [
    ".DS_Store", "._1.mp4", "Thumbs.db", "shortcut.lnk",
    ".accelerate/1.mp4", "$RECYCLE.BIN/1.mp4", "System Volume Information/1.mp4",
  ]) assert.equal(isAcceptedMedia(name), false, name);
});

test("naturalSort is numeric and stable for Chinese paths", () => {
  assert.deepEqual(naturalSort(["11 (10).mp4", "2.mp4", "11 (2).mp4", "1.mp4"]), [
    "1.mp4", "2.mp4", "11 (2).mp4", "11 (10).mp4",
  ]);
});

test("parses frame rates and ffprobe metadata", () => {
  assert.ok(Math.abs(parseFrameRate("30000/1001") - 29.97002997) < 0.000001);
  assert.equal(parseFrameRate("30/1"), 30);
  assert.equal(parseFrameRate("0/0"), 0);
  const probe = parseProbeJson({
    format: {duration: "4.25", format_name: "mov,mp4,m4a,3gp,3g2,mj2"},
    streams: [
      {codec_type: "video", codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30/1", pix_fmt: "yuv420p", tags: {rotate: "90"}},
      {codec_type: "audio", codec_name: "aac", sample_rate: "48000"},
    ],
  });
  assert.deepEqual(
    {duration: probe.durationInSeconds, width: probe.width, height: probe.height, fps: probe.fps, codec: probe.codec, rotation: probe.rotation, hasAudio: probe.hasAudio},
    {duration: 4.25, width: 1080, height: 1920, fps: 30, codec: "h264", rotation: 90, hasAudio: true},
  );
  assert.equal(probe.container, "mov,mp4,m4a,3gp,3g2,mj2");
  assert.equal(parseProbeJson({format: {duration: "1"}, streams: [{codec_type: "video", codec_name: "hevc", width: 1920, height: 1080, avg_frame_rate: "60/1", side_data_list: [{rotation: -90}]}]}).rotation, -90);
  assert.equal(parseProbeJson({format: {duration: "1"}, streams: [{codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1"}]}).hasAudio, false);
  assert.throws(() => parseProbeJson("{"));
  assert.throws(() => parseProbeJson({streams: []}), /video stream/);
});

test("source IDs are deterministic and fingerprints distinguish equal-size files", async () => {
  assert.equal(createSourceId("a.mp4", 4, 100), createSourceId("a.mp4", 4, 100));
  assert.equal(createSourceId("a.mp4", 4, 100).length, 64);
  assert.notEqual(createSourceId("a.mp4", 4, 100), createSourceId("a.mp4", 4, 101));
  const root = await mkdtemp(path.join(tmpdir(), "auto-edit-fingerprint-"));
  const a = path.join(root, "a.mp4");
  const b = path.join(root, "b.mp4");
  await writeFile(a, "aaaa");
  await writeFile(b, "bbbb");
  assert.notEqual(await quickFingerprint(a, 4), await quickFingerprint(b, 4));
});

test("indexAssets rejects an internal symbolic-link escape", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "auto-edit-index-symlink-"));
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.mp4`);
  await writeFile(outside, "outside");
  await symlink(outside, path.join(root, "escape.mp4"));
  await assert.rejects(indexAssets({sourceRoot: root, probe: async () => ({})}), /Symbolic links/);
});

test("assertIndexMatchesSourceRoot binds every source and shot to one explicit batch", () => {
  const root = "/Volumes/share/batch";
  const sourcePath = path.join(root, "nested/1.mp4");
  const index = {
    sourceRoot: root,
    sources: [{id: "source-1", relativePath: "nested/1.mp4", sourcePath}],
    shots: [{id: "source-1", sourceId: "source-1", sourcePath}],
  };
  assert.doesNotThrow(() => assertIndexMatchesSourceRoot(index, root));
  assert.throws(() => assertIndexMatchesSourceRoot(index, "/Volumes/share/other"), /sourceRoot/);
  assert.throws(() => assertIndexMatchesSourceRoot({
    ...index,
    sources: [{...index.sources[0], relativePath: "../escape.mp4", sourcePath: "/Volumes/share/escape.mp4"}],
  }, root), /outside sourceRoot/);
  assert.throws(() => assertIndexMatchesSourceRoot({
    ...index,
    shots: [{...index.shots[0], sourcePath: "/Volumes/share/other/1.mp4"}],
  }, root), /shot source/);
});

test("indexAssets caches unchanged probes and preserves a failed source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "auto-edit-index-"));
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "1.mp4"), "same");
  await writeFile(path.join(root, "nested/2.mp4"), "same");
  await writeFile(path.join(root, "3.mov"), "fail");
  const calls = [];
  const probe = async (sourcePath) => {
    calls.push(sourcePath);
    if (sourcePath.endsWith("3.mov")) throw new Error("probe failed");
    return {durationInSeconds: 10, width: 1080, height: 1920, fps: 30, codec: "h264", rotation: 0, hasAudio: true};
  };
  const first = await indexAssets({sourceRoot: root, probe, now: () => new Date("2026-08-06T00:00:00.000Z")});
  assert.deepEqual(first.metrics, {sources: 3, cached: 0, probed: 3, failed: 1});
  assert.equal(first.index.shots.length, 2);
  assert.equal(first.index.sources.filter((source) => source.quickFingerprint !== null).length, 2);
  assert.match(first.index.sources.find((source) => source.relativePath === "3.mov").error, /probe failed/);
  calls.length = 0;
  const second = await indexAssets({sourceRoot: root, previousIndex: first.index, probe});
  assert.deepEqual(second.metrics, {sources: 3, cached: 2, probed: 1, failed: 1});
  assert.deepEqual(calls.map((value) => path.basename(value)), ["3.mov"]);
  for (const source of second.index.sources.filter((item) => item.status !== "failed")) {
    const info = await stat(source.sourcePath);
    assert.equal(source.sizeBytes, info.size);
  }

  const otherRoot = await mkdtemp(path.join(tmpdir(), "auto-edit-index-other-root-"));
  await writeFile(path.join(otherRoot, "1.mp4"), "same");
  calls.length = 0;
  const other = await indexAssets({sourceRoot: otherRoot, previousIndex: first.index, probe});
  assert.deepEqual(other.metrics, {sources: 1, cached: 0, probed: 1, failed: 0});
  assert.equal(calls.length, 1);
});

test("indexAssets fails the stage when every probe fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "auto-edit-index-all-failed-"));
  await writeFile(path.join(root, "1.mp4"), "broken");
  await assert.rejects(
    indexAssets({sourceRoot: root, probe: async () => { throw new Error("bad media"); }}),
    /No source video passed ffprobe/,
  );
});
```

- [ ] **Step 2: Run the tests and confirm the module is missing**

Run:

```bash
node --test scripts/lib/index-assets.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `index-assets.mjs`.

- [ ] **Step 3: Implement deterministic discovery and probing**

Create `scripts/lib/index-assets.mjs` with the following public helpers and exact algorithms:

```js
import {execFile as execFileCallback} from "node:child_process";
import {createHash} from "node:crypto";
import {open, readdir, stat} from "node:fs/promises";
import path from "node:path";
import {promisify} from "node:util";

const execFile = promisify(execFileCallback);
const collator = new Intl.Collator("zh-CN", {numeric: true, sensitivity: "base"});
const acceptedExtensions = new Set([".mp4", ".mov", ".m4v"]);
const excludedSegments = new Set([
  ".accelerate", ".ds_store", "thumbs.db", "$recycle.bin", "system volume information",
]);

export const isAcceptedMedia = (relativePath) => {
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => {
    const lower = segment.toLowerCase();
    return excludedSegments.has(lower) || lower.startsWith("._") || lower.endsWith(".lnk");
  })) return false;
  return acceptedExtensions.has(path.extname(relativePath).toLowerCase());
};

export const naturalSort = (paths) => [...paths].sort((a, b) => collator.compare(a, b));

export const parseFrameRate = (value) => {
  if (typeof value !== "string") return 0;
  const [numerator, denominator = "1"] = value.split("/").map(Number);
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0
    ? numerator / denominator
    : 0;
};

export const parseProbeJson = (input) => {
  const value = typeof input === "string" ? JSON.parse(input) : input;
  const video = value?.streams?.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("ffprobe returned no video stream.");
  const durationInSeconds = Number(value?.format?.duration ?? video.duration);
  const rotationSideData = video.side_data_list?.find((item) => Number.isFinite(Number(item.rotation)))?.rotation;
  const result = {
    container: value?.format?.format_name ?? null,
    durationInSeconds,
    width: Number(video.width),
    height: Number(video.height),
    fps: parseFrameRate(video.avg_frame_rate || video.r_frame_rate),
    codec: String(video.codec_name || ""),
    rotation: Number(rotationSideData ?? video.tags?.rotate ?? 0),
    hasAudio: Boolean(value?.streams?.some((stream) => stream.codec_type === "audio")),
    pixelFormat: video.pix_fmt ?? null,
    colorSpace: video.color_space ?? null,
    colorPrimaries: video.color_primaries ?? null,
    colorTransfer: video.color_transfer ?? null,
    audioSampleRate: Number(value?.streams?.find((stream) => stream.codec_type === "audio")?.sample_rate) || null,
  };
  if (
    !Number.isFinite(result.durationInSeconds) || result.durationInSeconds <= 0 ||
    !Number.isFinite(result.width) || result.width <= 0 ||
    !Number.isFinite(result.height) || result.height <= 0 ||
    !Number.isFinite(result.fps) || result.fps <= 0 || result.codec.length === 0
  ) throw new Error("ffprobe returned invalid required video metadata.");
  return result;
};

export const probeVideo = async (sourcePath, {ffprobeCommand = "ffprobe", execFileImpl = execFile} = {}) => {
  try {
    const {stdout} = await execFileImpl(ffprobeCommand, [
      "-v", "error", "-print_format", "json", "-show_format", "-show_streams", sourcePath,
    ], {maxBuffer: 16 * 1024 * 1024});
    return parseProbeJson(stdout);
  } catch (error) {
    const code = error.code ?? "unknown";
    const stderr = String(error.stderr ?? error.message ?? error).trim();
    throw new Error(`ffprobe exit ${code}: ${stderr}`);
  }
};

export const createSourceId = (relativePath, sizeBytes, mtimeMs) => createHash("sha256")
  .update(`${relativePath}\0${sizeBytes}\0${mtimeMs}`)
  .digest("hex");

const readExact = async (handle, length, position) => {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const {bytesRead} = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error("Source file ended while computing its quick fingerprint.");
    offset += bytesRead;
  }
  return buffer;
};

export const quickFingerprint = async (sourcePath, sizeBytes) => {
  const handle = await open(sourcePath, "r");
  try {
    const chunk = 1024 * 1024;
    if (sizeBytes < chunk * 2) {
      const buffer = await readExact(handle, sizeBytes, 0);
      return createHash("sha256").update(buffer).digest("hex");
    }
    const first = await readExact(handle, chunk, 0);
    const last = await readExact(handle, chunk, sizeBytes - chunk);
    return createHash("sha256").update(first).update(last).digest("hex");
  } finally {
    await handle.close();
  }
};

const discover = async (sourceRoot) => {
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(sourceRoot, absolute);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in sourceRoot: ${relative}`);
      if (entry.isDirectory()) {
        if (isAcceptedMedia(`${relative}/x.mp4`)) await walk(absolute);
      } else if (entry.isFile() && isAcceptedMedia(relative)) {
        files.push(relative);
      }
    }
  };
  await walk(sourceRoot);
  return naturalSort(files);
};

export const assertIndexMatchesSourceRoot = (index, sourceRoot) => {
  const expectedRoot = path.resolve(sourceRoot);
  if (path.resolve(String(index?.sourceRoot ?? "")) !== expectedRoot) {
    throw new Error(`Index sourceRoot does not match the configured sourceRoot: ${index?.sourceRoot}`);
  }
  const sourceById = new Map();
  for (const source of index.sources ?? []) {
    const expectedPath = path.resolve(expectedRoot, source.relativePath);
    const relative = path.relative(expectedRoot, expectedPath);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Indexed source ${source.id} is outside sourceRoot.`);
    }
    if (path.resolve(source.sourcePath) !== expectedPath) {
      throw new Error(`Indexed source path does not match its relativePath: ${source.id}`);
    }
    sourceById.set(source.id, source);
  }
  for (const shot of index.shots ?? []) {
    const source = sourceById.get(shot.sourceId);
    if (!source || shot.sourcePath !== source.sourcePath) {
      throw new Error(`Indexed shot source does not match sourceRoot: ${shot.id}`);
    }
  }
};

export const indexAssets = async ({
  sourceRoot,
  previousIndex = null,
  probe = probeVideo,
  now = () => new Date(),
}) => {
  const relativePaths = await discover(sourceRoot);
  if (relativePaths.length === 0) throw new Error("sourceRoot contains no supported video files.");
  const reusablePrevious = previousIndex?.sourceRoot === sourceRoot ? previousIndex : null;
  const previousSources = new Map((reusablePrevious?.sources ?? []).map((source) => [source.relativePath, source]));
  const previousShots = new Map((reusablePrevious?.shots ?? []).map((shot) => [shot.id, shot]));
  const sources = [];
  let cached = 0;
  let probed = 0;

  for (const relativePath of relativePaths) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const info = await stat(sourcePath);
    const old = previousSources.get(relativePath);
    if (old && old.sizeBytes === info.size && old.mtimeMs === info.mtimeMs && old.durationInSeconds > 0) {
      cached += 1;
      sources.push({
        ...old,
        sourcePath,
        status: old.status === "prepared" ? "prepared" : "indexed",
        error: null,
      });
      continue;
    }
    probed += 1;
    const id = createSourceId(relativePath, info.size, info.mtimeMs);
    try {
      const metadata = await probe(sourcePath);
      sources.push({
        id, sourcePath, relativePath, sizeBytes: info.size, mtimeMs: info.mtimeMs,
        durationInSeconds: metadata.durationInSeconds, width: metadata.width, height: metadata.height,
        fps: metadata.fps, codec: metadata.codec, rotation: metadata.rotation,
        hasAudio: metadata.hasAudio, quickFingerprint: null, proxyPath: null,
        contactSheetPath: null, status: "indexed", error: null,
      });
    } catch (error) {
      sources.push({
        id, sourcePath, relativePath, sizeBytes: info.size, mtimeMs: info.mtimeMs,
        durationInSeconds: 0, width: 0, height: 0, fps: 0, codec: "", rotation: 0,
        hasAudio: false, quickFingerprint: null, proxyPath: null, contactSheetPath: null,
        status: "failed", error: error.message,
      });
    }
  }

  const sizeGroups = new Map();
  for (const source of sources.filter((item) => item.status !== "failed")) {
    source.quickFingerprint = null;
    const group = sizeGroups.get(source.sizeBytes) ?? [];
    group.push(source);
    sizeGroups.set(source.sizeBytes, group);
  }
  for (const group of sizeGroups.values()) {
    if (group.length < 2) continue;
    for (const source of group) {
      source.quickFingerprint = await quickFingerprint(source.sourcePath, source.sizeBytes);
    }
  }

  const shots = sources
    .filter((source) => source.durationInSeconds > 0)
    .map((source) => ({
      id: source.id,
      sourceId: source.id,
      sourcePath: source.sourcePath,
      proxyPath: source.proxyPath ?? undefined,
      sourceInSeconds: 0,
      sourceOutSeconds: source.durationInSeconds,
      productSkus: previousShots.get(source.id)?.productSkus ?? [],
      tags: previousShots.get(source.id)?.tags ?? source.relativePath.split(/[\\/]/).slice(0, -1),
      qualityScore: previousShots.get(source.id)?.qualityScore ?? 0,
      confidence: previousShots.get(source.id)?.confidence ?? 0,
      reviewState: previousShots.get(source.id)?.reviewState ?? "unreviewed",
    }));
  if (shots.length === 0) throw new Error("No source video passed ffprobe.");
  const failed = sources.filter((source) => source.status === "failed").length;
  return {
    index: {schemaVersion: 1, sourceRoot, scannedAt: now().toISOString(), sources, shots},
    metrics: {sources: sources.length, cached, probed, failed},
  };
};
```

- [ ] **Step 4: Run focused and full tests**

Run:

```bash
node --test scripts/lib/index-assets.test.mjs
npm run test:auto-edit
npm run typecheck
```

Expected: all Node tests PASS; TypeScript remains green. The tests' source file size and `mtimeMs` values must be unchanged before and after indexing.

- [ ] **Step 5: Commit if Git is available**

```bash
git rev-parse --is-inside-work-tree && git add scripts/lib/index-assets.mjs scripts/lib/index-assets.test.mjs && git commit -m "feat: index one read-only media batch"
```

---

### Task 4: Generate Local Proxies and Labeled Contact Sheets

**Files:**
- Create: `packages/remotion-video/src/contact-sheet.tsx`
- Modify: `packages/remotion-video/src/root.tsx`
- Create: `scripts/lib/prepare-media.mjs`
- Create: `scripts/lib/prepare-media.test.mjs`

**Interfaces:**
- Consumes: an `AssetIndex`, the locked `JobPaths`, installed FFmpeg/ffprobe, and Remotion.
- Produces:

```js
contactSheetSamples(durationInSeconds, fps = 30)
// {frame: number, timecode: string}[]
proxyArgs(sourcePath, outputPath) // string[]
assertProxyProbeJson(input) // normalized proxy metadata
isJpeg(filePath) // Promise<boolean>
prepareMedia({index, paths, execFileImpl})
// Promise<{updatedIndex, metrics: {prepared, cached, failed}}>
```

The one local Still contract is:

```ts
export interface MediaContactSheetProps {
  mediaPath: string;
  samples: Array<{frame: number; label: string}>;
}
```

`mediaPath` is always relative to the current Remotion `--public-dir`. Source sheets use `proxies/<source-id>.mp4`; final QC uses `<job-id>.partial.mp4` with `out/` as public-dir.

- [ ] **Step 1: Write failing media-preparation tests**

Create `scripts/lib/prepare-media.test.mjs`:

```js
import assert from "node:assert/strict";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertProxyProbeJson,
  contactSheetSamples,
  prepareMedia,
  proxyArgs,
} from "./prepare-media.mjs";

test("contactSheetSamples follows the approved duration bands", () => {
  assert.deepEqual(contactSheetSamples(8), [{frame: 120, timecode: "00:00:04.000"}]);
  assert.deepEqual(contactSheetSamples(9), [
    {frame: 54, timecode: "00:00:01.800"},
    {frame: 135, timecode: "00:00:04.500"},
    {frame: 216, timecode: "00:00:07.200"},
  ]);
  assert.deepEqual(contactSheetSamples(31).map(({frame}) => frame), [0, 300, 600, 900]);
  assert.equal(contactSheetSamples(100).length, 8);
  assert.ok(contactSheetSamples(100).every(({frame}) => Number.isInteger(frame) && frame >= 0));
});

test("proxyArgs writes H264 yuv420p CFR30 without audio", () => {
  const args = proxyArgs("/Volumes/share/素材 1.mp4", "/repo/work/job/public/proxies/id.partial.mp4");
  assert.equal(args[args.indexOf("-i") + 1], "/Volumes/share/素材 1.mp4");
  for (const value of ["libx264", "18", "yuv420p", "cfr", "-an"]) assert.ok(args.includes(value), value);
  assert.match(args[args.indexOf("-vf") + 1], /fps=30/);
  assert.equal(args.at(-1), "/repo/work/job/public/proxies/id.partial.mp4");
});

test("proxy metadata rejects the wrong format", () => {
  const valid = {
    format: {duration: "10"},
    streams: [{codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: 1080, height: 1920, avg_frame_rate: "30/1"}],
  };
  assert.equal(assertProxyProbeJson(valid).fps, 30);
  assert.throws(() => assertProxyProbeJson({...valid, streams: [{...valid.streams[0], codec_name: "hevc"}]}), /H.264/);
  assert.throws(() => assertProxyProbeJson({...valid, streams: [...valid.streams, {codec_type: "audio", codec_name: "aac"}]}), /audio/);
});

test("prepareMedia resumes cached work and isolates a source failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "auto-edit-prepare-"));
  const publicDir = path.join(root, "public");
  const paths = {
    workspaceRoot: root,
    workDir: root,
    publicDir,
    proxiesDir: path.join(publicDir, "proxies"),
    contactsDir: path.join(root, "contacts"),
  };
  await mkdir(paths.proxiesDir, {recursive: true});
  await mkdir(paths.contactsDir, {recursive: true});
  const sourcePath = path.join(root, "source.mp4");
  await writeFile(sourcePath, "source");
  const index = {
    schemaVersion: 1,
    sourceRoot: root,
    scannedAt: "2026-08-06T00:00:00.000Z",
    sources: [
      {id: "ok", sourcePath, relativePath: "产品/1.mp4", sizeBytes: 6, mtimeMs: 1, durationInSeconds: 9, width: 1080, height: 1920, fps: 30, codec: "h264", rotation: 0, hasAudio: true, quickFingerprint: null, proxyPath: null, contactSheetPath: null, status: "indexed", error: null},
      {id: "bad", sourcePath: `${sourcePath}-bad`, relativePath: "产品/2.mp4", sizeBytes: 6, mtimeMs: 1, durationInSeconds: 9, width: 1080, height: 1920, fps: 30, codec: "h264", rotation: 0, hasAudio: true, quickFingerprint: null, proxyPath: null, contactSheetPath: null, status: "indexed", error: null},
    ],
    shots: [
      {id: "ok", sourceId: "ok", sourcePath, sourceInSeconds: 0, sourceOutSeconds: 9, productSkus: [], tags: ["产品"], qualityScore: 0, confidence: 0, reviewState: "unreviewed"},
      {id: "bad", sourceId: "bad", sourcePath: `${sourcePath}-bad`, sourceInSeconds: 0, sourceOutSeconds: 9, productSkus: [], tags: ["产品"], qualityScore: 0, confidence: 0, reviewState: "unreviewed"},
    ],
  };
  const calls = [];
  const execFileImpl = async (command, args) => {
    calls.push({command, args});
    if (args.includes(`${sourcePath}-bad`)) throw new Error("decode failed");
    if (command === "ffprobe") return {stdout: JSON.stringify({format: {duration: "9"}, streams: [{codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: 1080, height: 1920, avg_frame_rate: "30/1"}]})};
    const output = command === "ffmpeg" ? args.at(-1) : args[3];
    await writeFile(output, command === "ffmpeg" ? "derived" : Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    return {stdout: "", stderr: ""};
  };
  const result = await prepareMedia({index, paths, execFileImpl});
  assert.deepEqual(result.metrics, {prepared: 1, cached: 0, failed: 1});
  assert.equal(result.updatedIndex.sources[0].proxyPath, "proxies/ok.mp4");
  assert.equal(result.updatedIndex.sources[0].contactSheetPath, "contacts/ok.jpg");
  assert.equal(result.updatedIndex.shots[0].proxyPath, "proxies/ok.mp4");
  assert.equal(result.updatedIndex.sources[1].status, "failed");
  assert.equal(result.updatedIndex.sources[1].proxyPath, null);
  assert.equal(result.updatedIndex.shots[1].proxyPath, undefined);
  const stillCall = calls.find(({args}) => args[0] === "still");
  const stillProps = JSON.parse(stillCall.args[stillCall.args.indexOf("--props") + 1]);
  assert.equal(stillProps.mediaPath, "proxies/ok.mp4");
  assert.ok(stillProps.samples.every(({label}) => label.includes("产品/1.mp4")));

  calls.length = 0;
  const resumed = await prepareMedia({index: result.updatedIndex, paths, execFileImpl});
  assert.deepEqual(resumed.metrics, {prepared: 0, cached: 1, failed: 1});
  assert.equal(calls.some(({command, args}) => command === "ffmpeg" && args.includes(sourcePath)), false);
  assert.equal(calls.some(({args}) => args[0] === "still"), false);
});
```

- [ ] **Step 2: Run the tests and confirm the module is missing**

Run:

```bash
node --test scripts/lib/prepare-media.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `prepare-media.mjs`.

- [ ] **Step 3: Implement sample generation, proxy arguments, and proxy verification**

Create the pure portion of `scripts/lib/prepare-media.mjs`:

```js
import {execFile as execFileCallback} from "node:child_process";
import {randomUUID} from "node:crypto";
import {lstat, open, rename} from "node:fs/promises";
import path from "node:path";
import {promisify} from "node:util";
import {parseFrameRate} from "./index-assets.mjs";

const execFile = promisify(execFileCallback);
const PROXY_FILTER = "scale=w=min(1920\\,iw):h=min(1920\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30";

const formatTimecode = (seconds) => {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const secs = Math.floor((milliseconds % 60000) / 1000);
  const millis = milliseconds % 1000;
  return [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":") + `.${String(millis).padStart(3, "0")}`;
};

export const contactSheetSamples = (durationInSeconds, fps = 30) => {
  if (!Number.isFinite(durationInSeconds) || durationInSeconds <= 0) throw new Error("durationInSeconds must be positive.");
  let seconds;
  if (durationInSeconds <= 8) seconds = [durationInSeconds / 2];
  else if (durationInSeconds <= 30) seconds = [0.2, 0.5, 0.8].map((ratio) => durationInSeconds * ratio);
  else seconds = Array.from({length: Math.min(8, Math.floor(durationInSeconds / 10) + 1)}, (_, index) => index * 10);
  const lastFrame = Math.max(0, Math.ceil(durationInSeconds * fps) - 1);
  return seconds.map((value) => ({
    frame: Math.min(Math.round(value * fps), lastFrame),
    timecode: formatTimecode(value),
  }));
};

export const proxyArgs = (sourcePath, outputPath) => [
  "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
  "-i", sourcePath,
  "-map", "0:v:0", "-map_metadata", "-1",
  "-vf", PROXY_FILTER,
  "-c:v", "libx264", "-preset", "fast", "-crf", "18",
  "-pix_fmt", "yuv420p", "-fps_mode", "cfr", "-an",
  "-movflags", "+faststart", outputPath,
];

export const assertProxyProbeJson = (input) => {
  const value = typeof input === "string" ? JSON.parse(input) : input;
  const videos = value?.streams?.filter((stream) => stream.codec_type === "video") ?? [];
  const audios = value?.streams?.filter((stream) => stream.codec_type === "audio") ?? [];
  if (videos.length !== 1 || videos[0].codec_name !== "h264") throw new Error("Proxy must have exactly one H.264 video stream.");
  if (videos[0].pix_fmt !== "yuv420p") throw new Error("Proxy must use yuv420p.");
  const fps = parseFrameRate(videos[0].avg_frame_rate);
  if (Math.abs(fps - 30) > 0.001) throw new Error("Proxy must be 30fps.");
  if (Math.max(Number(videos[0].width), Number(videos[0].height)) > 1920) throw new Error("Proxy longest edge must be <= 1920.");
  if (audios.length !== 0) throw new Error("Proxy must not contain audio.");
  const durationInSeconds = Number(value?.format?.duration);
  if (!Number.isFinite(durationInSeconds) || durationInSeconds <= 0) throw new Error("Proxy duration must be positive.");
  return {fps, durationInSeconds, width: Number(videos[0].width), height: Number(videos[0].height)};
};
```

- [ ] **Step 4: Implement one reusable Remotion contact-sheet Still**

Create `packages/remotion-video/src/contact-sheet.tsx`:

```tsx
import type {CalculateMetadataFunction} from "remotion";
import {AbsoluteFill, OffthreadVideo, staticFile} from "remotion";

export interface MediaContactSheetProps {
  mediaPath: string;
  samples: Array<{frame: number; label: string}>;
}

const errorsFor = ({mediaPath, samples}: MediaContactSheetProps) => {
  const errors: string[] = [];
  if (
    typeof mediaPath !== "string" || mediaPath.length === 0 || mediaPath.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(mediaPath) || mediaPath.includes("\\") || mediaPath.split("/").includes("..")
  ) errors.push("mediaPath must be a non-empty public-dir relative path.");
  if (!Array.isArray(samples) || samples.length === 0 || samples.length > 64) errors.push("samples must contain 1-64 frames.");
  for (const sample of Array.isArray(samples) ? samples : []) {
    if (!Number.isInteger(sample.frame) || sample.frame < 0) errors.push("sample.frame must be a non-negative integer.");
    if (typeof sample.label !== "string" || sample.label.length === 0) errors.push("sample.label must be non-empty.");
  }
  return errors;
};

export const calculateContactSheetMetadata: CalculateMetadataFunction<MediaContactSheetProps> = ({props, isRendering}) => {
  const errors = errorsFor(props);
  const sampleCount = Array.isArray(props.samples) ? props.samples.length : 0;
  const isEmptyStudioDefault = !isRendering && props.mediaPath === "" && sampleCount === 0;
  if (!isEmptyStudioDefault && errors.length > 0) throw new Error(errors.join("\n"));
  return {
    width: 1920,
    height: Math.max(540, Math.ceil(Math.max(1, sampleCount) / 4) * 540),
  };
};

export const MediaContactSheet = ({mediaPath, samples}: MediaContactSheetProps) => {
  if (samples.length === 0) {
    return <AbsoluteFill style={{backgroundColor: "#111", color: "white", alignItems: "center", justifyContent: "center", fontSize: 42}}>Provide contact-sheet props</AbsoluteFill>;
  }
  return (
    <AbsoluteFill style={{backgroundColor: "#050505", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gridAutoRows: 540, fontFamily: "PingFang SC, sans-serif"}}>
      {samples.map((sample) => (
        <div key={`${sample.frame}-${sample.label}`} style={{position: "relative", overflow: "hidden", border: "4px solid #111"}}>
          <OffthreadVideo
            src={staticFile(mediaPath)}
            trimBefore={sample.frame / 30}
            muted
            style={{width: "100%", height: "100%", objectFit: "contain"}}
          />
          <div style={{position: "absolute", left: 0, right: 0, bottom: 0, padding: "14px 16px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "rgba(0,0,0,0.78)", color: "white", fontSize: 22, lineHeight: 1.25}}>
            {sample.label}
          </div>
        </div>
      ))}
    </AbsoluteFill>
  );
};
```

The division by `30` is required: Remotion implements `<Still>` as one frame at 1fps, while `trimBefore` uses composition frames. Source proxies and final output are both fixed at 30fps.

Modify `packages/remotion-video/src/root.tsx` to preserve the current demo and add:

```tsx
import {Composition, Still} from "remotion";
import {
  calculateContactSheetMetadata,
  MediaContactSheet,
} from "./contact-sheet";

// Keep the existing ProductMarketingDemo Composition unchanged, then add:
<Still
  id="MediaContactSheet"
  component={MediaContactSheet}
  defaultProps={{mediaPath: "", samples: []}}
  calculateMetadata={calculateContactSheetMetadata}
/>
```

Return both registrations inside a fragment.

- [ ] **Step 5: Complete the preparation orchestrator**

Append to `scripts/lib/prepare-media.mjs`:

```js
const isNonemptyFile = async (filePath) => {
  try {
    const info = await lstat(filePath);
    return !info.isSymbolicLink() && info.isFile() && info.size > 0;
  } catch {
    return false;
  }
};

export const isJpeg = async (filePath) => {
  if (!(await isNonemptyFile(filePath))) return false;
  const info = await lstat(filePath);
  if (info.size < 4) return false;
  const handle = await open(filePath, "r");
  try {
    const start = Buffer.alloc(2);
    const end = Buffer.alloc(2);
    await handle.read(start, 0, 2, 0);
    await handle.read(end, 0, 2, info.size - 2);
    return start.equals(Buffer.from([0xff, 0xd8])) && end.equals(Buffer.from([0xff, 0xd9]));
  } finally {
    await handle.close();
  }
};

const verifyProxy = async (filePath, execFileImpl) => {
  const {stdout} = await execFileImpl("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=index,codec_type,codec_name,pix_fmt,width,height,avg_frame_rate:format=duration",
    "-of", "json", filePath,
  ], {maxBuffer: 4 * 1024 * 1024});
  return assertProxyProbeJson(stdout);
};

export const prepareMedia = async ({index, paths, execFileImpl = execFile}) => {
  const sources = index.sources.map((source) => ({...source}));
  const shots = index.shots.map((shot) => ({...shot}));
  const shotBySource = new Map(shots.map((shot) => [shot.sourceId, shot]));
  let prepared = 0;
  let cached = 0;
  let failed = 0;
  const remotion = path.join(paths.workspaceRoot, "node_modules", ".bin", "remotion");
  const remotionCwd = path.join(paths.workspaceRoot, "packages", "remotion-video");

  for (const source of sources) {
    if (source.durationInSeconds <= 0) {
      failed += 1;
      continue;
    }
    const proxyRelative = `proxies/${source.id}.mp4`;
    const contactRelative = `contacts/${source.id}.jpg`;
    const proxyFinal = path.join(paths.publicDir, proxyRelative);
    const contactFinal = path.join(paths.workDir, contactRelative);
    try {
      let proxyReady = await isNonemptyFile(proxyFinal);
      const contactReady = await isJpeg(contactFinal);
      if (proxyReady) {
        try {
          await verifyProxy(proxyFinal, execFileImpl);
        } catch {
          proxyReady = false;
        }
      }
      if (!proxyReady) {
        const proxyTemporary = path.join(paths.proxiesDir, `${source.id}.${randomUUID()}.partial.mp4`);
        await execFileImpl("ffmpeg", proxyArgs(source.sourcePath, proxyTemporary), {maxBuffer: 16 * 1024 * 1024});
        await verifyProxy(proxyTemporary, execFileImpl);
        await rename(proxyTemporary, proxyFinal);
      }
      if (!contactReady) {
        const contactTemporary = path.join(paths.contactsDir, `${source.id}.${randomUUID()}.partial.jpg`);
        const samples = contactSheetSamples(source.durationInSeconds).map(({frame, timecode}) => ({
          frame,
          label: `${source.relativePath}\n${timecode}`,
        }));
        await execFileImpl(remotion, [
          "still", "src/index.ts", "MediaContactSheet", contactTemporary,
          "--props", JSON.stringify({mediaPath: proxyRelative, samples}),
          "--public-dir", paths.publicDir,
          "--image-format", "jpeg", "--jpeg-quality", "90", "--overwrite=true",
        ], {cwd: remotionCwd, maxBuffer: 16 * 1024 * 1024});
        if (!(await isJpeg(contactTemporary))) throw new Error(`Remotion produced an invalid JPEG for ${source.id}.`);
        await rename(contactTemporary, contactFinal);
      }
      source.proxyPath = proxyRelative;
      source.contactSheetPath = contactRelative;
      source.status = "prepared";
      source.error = null;
      const shot = shotBySource.get(source.id);
      if (shot) shot.proxyPath = proxyRelative;
      if (proxyReady && contactReady) cached += 1;
      else prepared += 1;
    } catch (error) {
      source.proxyPath = null;
      source.contactSheetPath = null;
      source.status = "failed";
      source.error = error.message;
      const shot = shotBySource.get(source.id);
      if (shot) delete shot.proxyPath;
      failed += 1;
    }
  }
  return {
    updatedIndex: {...index, sources, shots},
    metrics: {prepared, cached, failed},
  };
};
```

- [ ] **Step 6: Run unit and TypeScript checks**

Run:

```bash
node --test scripts/lib/prepare-media.test.mjs
npm run typecheck
```

Expected: preparation tests PASS; Remotion TypeScript compiles.

- [ ] **Step 7: Run the approved local integration source without SMB**

From the repository root, invoke `prepareMedia()` on the existing demo MP4 with all output in a fresh `/tmp` job:

```bash
node --input-type=module -e 'import {mkdtemp,mkdir,stat} from "node:fs/promises"; import {tmpdir} from "node:os"; import path from "node:path"; import {prepareMedia} from "./scripts/lib/prepare-media.mjs"; const workspaceRoot=process.cwd(); const workDir=await mkdtemp(path.join(tmpdir(),"remotion-prepare-smoke-")); const publicDir=path.join(workDir,"public"); const proxiesDir=path.join(publicDir,"proxies"); const contactsDir=path.join(workDir,"contacts"); await mkdir(proxiesDir,{recursive:true}); await mkdir(contactsDir); const sourcePath=path.join(workspaceRoot,"out/demo-product.mp4"); const sourceStat=await stat(sourcePath); const source={id:"demo-local",sourcePath,relativePath:"demo-product.mp4",sizeBytes:sourceStat.size,mtimeMs:sourceStat.mtimeMs,durationInSeconds:24,width:1080,height:1920,fps:30,codec:"h264",rotation:0,hasAudio:true,quickFingerprint:null,proxyPath:null,contactSheetPath:null,status:"indexed",error:null}; const shot={id:"demo-local",sourceId:"demo-local",sourcePath,sourceInSeconds:0,sourceOutSeconds:24,productSkus:[],tags:[],qualityScore:0,confidence:0,reviewState:"unreviewed"}; const result=await prepareMedia({index:{schemaVersion:1,sourceRoot:path.dirname(sourcePath),scannedAt:new Date().toISOString(),sources:[source],shots:[shot]},paths:{workspaceRoot,workDir,publicDir,proxiesDir,contactsDir}}); if(result.metrics.prepared!==1||result.metrics.failed!==0) process.exit(1); console.log(JSON.stringify({workDir,proxy:path.join(proxiesDir,"demo-local.mp4"),contact:path.join(contactsDir,"demo-local.jpg")},null,2));'
```

Expected: exit 0 and printed paths to a real H.264/yuv420p/30fps silent proxy plus a nonzero labeled JPEG. Open the printed contact path and verify distinct visible demo frames, `demo-product.mp4`, and the three timecodes. A blank or unlabeled image fails the integration check.

- [ ] **Step 8: Commit if Git is available**

```bash
git rev-parse --is-inside-work-tree && git add packages/remotion-video/src/contact-sheet.tsx packages/remotion-video/src/root.tsx scripts/lib/prepare-media.mjs scripts/lib/prepare-media.test.mjs && git commit -m "feat: prepare proxies and contact sheets"
```

---

### Task 5: Validate and Render a Real Timeline in Remotion

**Files:**
- Modify: `packages/core/src/validate-timeline.ts`
- Modify: `packages/remotion-video/src/product-marketing-video.tsx`
- Create: `packages/remotion-video/src/product-marketing-real.tsx`
- Modify: `packages/remotion-video/src/root.tsx`
- Create: `scripts/lib/render-qc.test.mjs` (metadata integration portion; Task 6 extends it)

**Interfaces:**
- Consumes: `RenderJobProps` from Task 1 and existing demo chrome components.
- Produces:

```ts
validateTimeline(timeline: Timeline): TimelineValidationResult
validateRenderJob(props: RenderJobProps): TimelineValidationResult
ProductMarketingChrome({timeline}: {timeline: Timeline}): React.ReactNode
ProductMarketingReal(props: RenderJobProps): React.ReactNode
calculateProductMarketingRealMetadata: CalculateMetadataFunction<RenderJobProps>
```

The browser-safe validator checks only data and public-dir-relative proxy strings. The Node CLI performs the required existence/readability check with `assertReadableProxyFiles()` immediately before invoking Remotion.

- [ ] **Step 1: Write a failing metadata integration test**

Create the first portion of `scripts/lib/render-qc.test.mjs`:

```js
import assert from "node:assert/strict";
import {execFile as execFileCallback} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

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
```

- [ ] **Step 2: Run the integration test and confirm the real Composition is absent**

Run:

```bash
node --test scripts/lib/render-qc.test.mjs
```

Expected: FAIL because `ProductMarketingReal` is not registered.

- [ ] **Step 3: Complete Timeline and render-props validation**

Replace `packages/core/src/validate-timeline.ts` with the existing exported result interface plus these two functions:

```ts
import type {RenderJobProps, Timeline} from "@auto-video/shared";

export interface TimelineValidationResult {
  valid: boolean;
  errors: string[];
}

const finiteInRange = (value: unknown, minimum: number, maximum: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;

export const validateTimeline = (timeline: Timeline): TimelineValidationResult => {
  const errors: string[] = [];
  if (timeline.schemaVersion !== 1) errors.push("Only timeline schemaVersion 1 is supported.");
  if (![timeline.width, timeline.height, timeline.fps, timeline.durationInFrames].every((value) => Number.isInteger(value) && value > 0)) {
    errors.push("Canvas, fps, and duration must be positive integers.");
  }
  if (timeline.clips.length === 0) errors.push("Timeline must contain at least one clip.");

  const clipIds = new Set<string>();
  let expectedStart = 0;
  for (const clip of timeline.clips) {
    if (clipIds.has(clip.id)) errors.push(`Duplicate clip id: ${clip.id}`);
    clipIds.add(clip.id);
    if (!Number.isInteger(clip.startFrame) || !Number.isInteger(clip.durationInFrames) || clip.startFrame < 0 || clip.durationInFrames <= 0) {
      errors.push(`Clip ${clip.id} has an invalid frame range.`);
    }
    if (clip.startFrame !== expectedStart) errors.push(`Clip ${clip.id} must start at frame ${expectedStart}; gaps and overlaps are not allowed.`);
    expectedStart = clip.startFrame + clip.durationInFrames;
    if (expectedStart > timeline.durationInFrames) errors.push(`Clip ${clip.id} extends beyond the timeline.`);
    if (!Number.isFinite(clip.sourceInSeconds) || !Number.isFinite(clip.sourceOutSeconds) || clip.sourceInSeconds < 0 || clip.sourceOutSeconds <= clip.sourceInSeconds) {
      errors.push(`Clip ${clip.id} has an invalid source range.`);
    }
    if (clip.fit !== undefined && clip.fit !== "cover" && clip.fit !== "contain") errors.push(`Clip ${clip.id} has an invalid fit.`);
    if (clip.focusX !== undefined && !finiteInRange(clip.focusX, 0, 1)) errors.push(`Clip ${clip.id} focusX must be between 0 and 1.`);
    if (clip.focusY !== undefined && !finiteInRange(clip.focusY, 0, 1)) errors.push(`Clip ${clip.id} focusY must be between 0 and 1.`);
  }
  if (expectedStart !== timeline.durationInFrames) errors.push("Clips must exactly cover timeline.durationInFrames.");

  const subtitleIds = new Set<string>();
  for (const cue of timeline.subtitles) {
    if (subtitleIds.has(cue.id)) errors.push(`Duplicate subtitle id: ${cue.id}`);
    subtitleIds.add(cue.id);
    if (!Number.isInteger(cue.startFrame) || !Number.isInteger(cue.endFrame) || cue.startFrame < 0 || cue.endFrame <= cue.startFrame || cue.endFrame > timeline.durationInFrames) {
      errors.push(`Subtitle ${cue.id} has an invalid frame range.`);
    }
  }
  return {valid: errors.length === 0, errors};
};

const isPublicRelativePath = (value: unknown) => typeof value === "string" && value.length > 0 &&
  !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value) && !value.includes("\\") && !value.split("/").includes("..");

export const validateRenderJob = (props: RenderJobProps): TimelineValidationResult => {
  const errors = [...validateTimeline(props.timeline).errors];
  const {timeline, shots} = props;
  if (timeline.status !== "approved") errors.push("Real Timeline status must be approved.");
  if (timeline.productSku === "DEMO-SKU-001") errors.push("Demo SKU cannot be rendered by ProductMarketingReal.");
  if (timeline.width !== 1080 || timeline.height !== 1920 || timeline.fps !== 30) errors.push("Real Timeline must be 1080x1920 at 30fps.");
  if (timeline.durationInFrames < 600 || timeline.durationInFrames > 1200) errors.push("Real Timeline must be 600-1200 frames.");
  if (!timeline.voiceover || timeline.voiceover.source !== null || timeline.voiceover.state !== "not_configured") errors.push("MVP voiceover must remain not_configured with a null source.");
  if (!timeline.music || timeline.music.source !== null || timeline.music.state !== "not_configured") errors.push("MVP music must remain not_configured with a null source.");

  for (const [key, shot] of Object.entries(shots ?? {})) {
    if (key !== shot.id) errors.push(`Shot record key ${key} must equal shot.id ${shot.id}.`);
    if (!isPublicRelativePath(shot.proxyPath)) errors.push(`Shot ${shot.id} requires a safe public-dir relative proxyPath.`);
  }
  const usedRanges = new Set<string>();
  for (const clip of timeline.clips) {
    if (clip.assetShotId === null) {
      errors.push(`Clip ${clip.id} requires a real assetShotId.`);
      continue;
    }
    const shot = shots?.[clip.assetShotId];
    if (!shot) {
      errors.push(`Clip ${clip.id} references missing shot ${clip.assetShotId}.`);
      continue;
    }
    if (clip.sourceInSeconds < shot.sourceInSeconds || clip.sourceOutSeconds > shot.sourceOutSeconds) {
      errors.push(`Clip ${clip.id} source range is outside shot ${shot.id}.`);
    }
    const availableFrames = Math.round(clip.sourceOutSeconds * timeline.fps) - Math.round(clip.sourceInSeconds * timeline.fps);
    if (availableFrames < clip.durationInFrames) {
      errors.push(`Clip ${clip.id} source range is shorter than its timeline duration.`);
    }
    const rangeKey = `${shot.sourceId}:${clip.sourceInSeconds}:${clip.sourceOutSeconds}`;
    if (usedRanges.has(rangeKey)) errors.push(`Clip ${clip.id} repeats an exact source range.`);
    usedRanges.add(rangeKey);
  }
  return {valid: errors.length === 0, errors};
};
```

- [ ] **Step 4: Refactor the existing visual chrome without changing the demo**

In `packages/remotion-video/src/product-marketing-video.tsx`, keep the current placeholder sequences and export this fragment:

```tsx
export const ProductMarketingChrome = ({timeline}: {timeline: Timeline}) => (
  <>
    <BrandBadge brand={timeline.brand} />
    <SubtitleLayer cues={timeline.subtitles} brand={timeline.brand} />
    <div
      style={{
        position: "absolute",
        left: 66,
        right: 66,
        bottom: 58,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        color: timeline.brand.mutedText,
        fontFamily: timeline.brand.fontFamily,
        fontSize: 20,
        letterSpacing: 2,
      }}
    >
      <span>{timeline.productSku}</span>
      <span>{timeline.cta}</span>
    </div>
  </>
);
```

Replace the three existing chrome blocks inside `ProductMarketingVideo` with:

```tsx
<ProductMarketingChrome timeline={timeline} />
```

Do not change `PlaceholderScene`, demo clip timing, colors, copy, or the `ProductMarketingDemo` composition ID.

- [ ] **Step 5: Implement the real-footage Composition**

Create `packages/remotion-video/src/product-marketing-real.tsx`:

```tsx
import {demoProduct, validateRenderJob} from "@auto-video/core";
import type {RenderJobProps} from "@auto-video/shared";
import type {CalculateMetadataFunction} from "remotion";
import {AbsoluteFill, OffthreadVideo, Sequence, staticFile} from "remotion";
import {ProductMarketingChrome, ProductMarketingVideo} from "./product-marketing-video";

const assertValid = (props: RenderJobProps) => {
  const result = validateRenderJob(props);
  if (!result.valid) throw new Error(result.errors.join("\n"));
};

export const calculateProductMarketingRealMetadata: CalculateMetadataFunction<RenderJobProps> = ({props, isRendering}) => {
  if (isRendering || props.timeline.productSku !== demoProduct.sku) assertValid(props);
  return {
    width: props.timeline.width,
    height: props.timeline.height,
    fps: props.timeline.fps,
    durationInFrames: props.timeline.durationInFrames,
  };
};

export const ProductMarketingReal = (props: RenderJobProps) => {
  const {timeline, shots} = props;
  if (timeline.productSku === demoProduct.sku) return <ProductMarketingVideo timeline={timeline} />;
  assertValid(props);
  return (
    <AbsoluteFill style={{backgroundColor: "#08100d", overflow: "hidden"}}>
      {timeline.clips.map((clip) => {
        const shot = shots[clip.assetShotId as string];
        if (!shot?.proxyPath) throw new Error(`Clip ${clip.id} has no readable proxy mapping.`);
        const focusX = (clip.focusX ?? 0.5) * 100;
        const focusY = (clip.focusY ?? 0.5) * 100;
        return (
          <Sequence key={clip.id} from={clip.startFrame} durationInFrames={clip.durationInFrames} premountFor={15}>
            <OffthreadVideo
              src={staticFile(shot.proxyPath)}
              trimBefore={Math.round(clip.sourceInSeconds * timeline.fps)}
              trimAfter={Math.round(clip.sourceOutSeconds * timeline.fps)}
              muted
              style={{width: "100%", height: "100%", objectFit: clip.fit ?? "cover", objectPosition: `${focusX}% ${focusY}%`}}
            />
          </Sequence>
        );
      })}
      <ProductMarketingChrome timeline={timeline} />
    </AbsoluteFill>
  );
};
```

- [ ] **Step 6: Register the real Composition with a safe Studio default**

In `packages/remotion-video/src/root.tsx`, import `demoTimeline`, `ProductMarketingReal`, and its metadata function. Keep the existing demo and contact-sheet registrations and add:

```tsx
<Composition
  id="ProductMarketingReal"
  component={ProductMarketingReal}
  width={demoTimeline.width}
  height={demoTimeline.height}
  fps={demoTimeline.fps}
  durationInFrames={demoTimeline.durationInFrames}
  defaultProps={{timeline: demoTimeline, shots: {}}}
  calculateMetadata={calculateProductMarketingRealMetadata}
/>
```

`calculateMetadata()` skips full validation only while Studio enumerates the demo default. During an actual render, `isRendering` is true, so rendering that default fails on demo SKU/null shots instead of creating a fake real output.

- [ ] **Step 7: Run metadata, type, demo-render, and baseline checks**

Run:

```bash
node --test scripts/lib/render-qc.test.mjs
npm run typecheck
npm run render:demo
ffprobe -v error -show_entries stream=codec_type,codec_name,width,height,avg_frame_rate -show_entries format=duration -of json out/demo-product.mp4
real_default_dir="$(mktemp -d /tmp/product-marketing-real-default.XXXXXX)"
(cd packages/remotion-video && ! ../../node_modules/.bin/remotion render src/index.ts ProductMarketingReal "$real_default_dir/output.mp4" --overwrite=true)
test ! -e "$real_default_dir/output.mp4"
```

Expected:

- Both metadata tests PASS; invalid props exit nonzero and name the blocking condition.
- Typecheck exits 0.
- `ProductMarketingDemo` still renders.
- The demo remains H.264/AAC, 1080×1920, 30fps, approximately 24 seconds.
- Rendering `ProductMarketingReal` with its Studio-only demo defaults exits nonzero and produces no MP4.

- [ ] **Step 8: Commit if Git is available**

```bash
git rev-parse --is-inside-work-tree && git add packages/core/src/validate-timeline.ts packages/remotion-video/src/product-marketing-video.tsx packages/remotion-video/src/product-marketing-real.tsx packages/remotion-video/src/root.tsx scripts/lib/render-qc.test.mjs && git commit -m "feat: render approved real timelines"
```

---

### Task 6: Render a Partial MP4 and Promote It Only After QC

**Files:**
- Create: `scripts/lib/render-qc.mjs`
- Modify: `scripts/lib/render-qc.test.mjs`

**Interfaces:**
- Consumes: loaded job `config`, `JobPaths`, `index.json`, `timeline.json`, and `props.json`.
- Produces:

```js
buildRenderProps(index, timeline) // RenderJobProps containing referenced shots only
assertSubtitlesFromScript(scriptText, timeline) // void
assertNoDuplicateFingerprints(index, timeline) // void
assertRenderManifest(result, propsBytes) // props SHA-256 or throws
buildContactSamples(timeline) // {frame, label}[]
assertQcMetadata(probeJson, timeline) // normalized QC metadata
renderArgs(paths) // string[]
validateWithRemotion({config, paths, execFileImpl}) // Promise<{index, timeline, props}>
renderJob({paths, execFileImpl, now}) // Promise<{command, elapsedMs, propsSha256}>
qcRender({paths, execFileImpl, now}) // Promise<QcResult>
```

- [ ] **Step 1: Extend the failing tests with pure render/QC rules**

Add this import to `scripts/lib/render-qc.test.mjs`:

```js
import {
  assertNoDuplicateFingerprints,
  assertQcMetadata,
  assertRenderManifest,
  assertSubtitlesFromScript,
  buildContactSamples,
  buildRenderProps,
  renderArgs,
} from "./render-qc.mjs";
```

Append these tests:

```js
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
  for (const flag of ["--codec=h264", "--pixel-format=yuv420p", "--audio-codec=aac", "--enforce-audio-track", "--overwrite=false"]) {
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
```

- [ ] **Step 2: Run and confirm the new module is missing**

Run:

```bash
node --test scripts/lib/render-qc.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `render-qc.mjs`.

- [ ] **Step 3: Implement props and pre-render truth checks**

Create the first portion of `scripts/lib/render-qc.mjs`:

```js
import {execFile as execFileCallback} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {lstat, readFile, rename} from "node:fs/promises";
import path from "node:path";
import {performance} from "node:perf_hooks";
import {promisify} from "node:util";
import {
  assertReadableProxyFiles,
  readJson,
  writeJsonAtomic,
} from "./job.mjs";
import {assertIndexMatchesSourceRoot, parseFrameRate} from "./index-assets.mjs";
import {isJpeg} from "./prepare-media.mjs";

const execFile = promisify(execFileCallback);
const normalized = (value) => value.replace(/\s+/gu, "").trim();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const assertRenderManifest = (result, propsBytes) => {
  const propsSha256 = sha256(propsBytes);
  if (result?.render?.propsSha256 !== propsSha256) {
    throw new Error("Partial render manifest does not match the currently validated props.");
  }
  return propsSha256;
};

export const buildRenderProps = (index, timeline) => {
  const allShots = new Map(index.shots.map((shot) => [shot.id, shot]));
  const shots = {};
  for (const clip of timeline.clips) {
    if (clip.assetShotId === null) throw new Error(`Clip ${clip.id} has no assetShotId.`);
    const shot = allShots.get(clip.assetShotId);
    if (!shot) throw new Error(`Clip ${clip.id} references missing shot ${clip.assetShotId}.`);
    shots[shot.id] = shot;
  }
  return {timeline, shots};
};

export const assertSubtitlesFromScript = (scriptText, timeline) => {
  const source = normalized(scriptText);
  for (const cue of timeline.subtitles) {
    if (cue.text.trim().length === 0 || !source.includes(normalized(cue.text))) {
      throw new Error(`Subtitle ${cue.id} is not literal text from the configured script.`);
    }
  }
};

export const assertNoDuplicateFingerprints = (index, timeline) => {
  const shots = new Map(index.shots.map((shot) => [shot.id, shot]));
  const sources = new Map(index.sources.map((source) => [source.id, source]));
  const fingerprintSource = new Map();
  for (const clip of timeline.clips) {
    const shot = shots.get(clip.assetShotId);
    const source = sources.get(shot?.sourceId);
    const fingerprint = source?.quickFingerprint;
    if (!fingerprint) continue;
    const priorSourceId = fingerprintSource.get(fingerprint);
    if (priorSourceId && priorSourceId !== source.id) {
      throw new Error(`Selected sources ${priorSourceId} and ${source.id} share a duplicate fingerprint.`);
    }
    fingerprintSource.set(fingerprint, source.id);
  }
};

const remotionCommand = (paths) => path.join(paths.workspaceRoot, "node_modules", ".bin", "remotion");
const remotionCwd = (paths) => path.join(paths.workspaceRoot, "packages", "remotion-video");

export const validateWithRemotion = async ({config, paths, execFileImpl = execFile}) => {
  const [index, timeline, scriptText] = await Promise.all([
    readJson(paths.indexPath),
    readJson(paths.timelinePath),
    readFile(config.scriptPath, "utf8"),
  ]);
  assertIndexMatchesSourceRoot(index, paths.sourceRoot);
  if (timeline.productSku === "DEMO-SKU-001") throw new Error("Demo SKU cannot enter the real render pipeline.");
  assertSubtitlesFromScript(scriptText, timeline);
  assertNoDuplicateFingerprints(index, timeline);
  const props = buildRenderProps(index, timeline);
  await assertReadableProxyFiles(props, paths.publicDir);
  await writeJsonAtomic(paths.propsPath, props);
  await execFileImpl(remotionCommand(paths), [
    "compositions", "src/index.ts", "--props", paths.propsPath, "--public-dir", paths.publicDir,
  ], {cwd: remotionCwd(paths), maxBuffer: 16 * 1024 * 1024});
  return {index, timeline, props};
};
```

- [ ] **Step 4: Implement deterministic render arguments and no-overwrite render**

Append:

```js
const exists = async (filePath) => {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
};

export const renderArgs = (paths) => [
  "render", "src/index.ts", "ProductMarketingReal", paths.partialOutputPath,
  "--props", paths.propsPath,
  "--public-dir", paths.publicDir,
  "--codec=h264",
  "--pixel-format=yuv420p",
  "--audio-codec=aac",
  "--enforce-audio-track",
  "--overwrite=false",
];

export const renderJob = async ({paths, execFileImpl = execFile, now = () => performance.now()}) => {
  if (await exists(paths.outputPath)) throw new Error(`Final output already exists: ${paths.outputPath}`);
  if (await exists(paths.partialOutputPath)) throw new Error(`Partial output already exists: ${paths.partialOutputPath}`);
  const propsSha256 = sha256(await readFile(paths.propsPath));
  const args = renderArgs(paths);
  const started = now();
  await execFileImpl(remotionCommand(paths), args, {cwd: remotionCwd(paths), maxBuffer: 32 * 1024 * 1024});
  const info = await lstat(paths.partialOutputPath);
  if (info.isSymbolicLink() || !info.isFile() || info.size === 0) throw new Error("Remotion produced an empty or unsafe partial output.");
  if (sha256(await readFile(paths.propsPath)) !== propsSha256) throw new Error("Props changed while Remotion was rendering.");
  return {command: [remotionCommand(paths), ...args], elapsedMs: Math.round(now() - started), propsSha256};
};
```

- [ ] **Step 5: Implement exact post-render QC and atomic promotion**

Append:

```js
export const buildContactSamples = (timeline) => {
  const candidates = [
    {frame: 0, label: "START · frame 0"},
    ...timeline.clips.slice(1).map((clip) => ({frame: Math.min(timeline.durationInFrames - 1, clip.startFrame + 1), label: `CUT · ${clip.id} · frame ${clip.startFrame + 1}`})),
    {frame: timeline.durationInFrames - 1, label: `END · frame ${timeline.durationInFrames - 1}`},
  ];
  return [...new Map(candidates.map((sample) => [sample.frame, sample])).values()].sort((a, b) => a.frame - b.frame);
};

export const assertQcMetadata = (input, timeline) => {
  const value = typeof input === "string" ? JSON.parse(input) : input;
  const video = value?.streams?.find((stream) => stream.codec_type === "video");
  const audio = value?.streams?.find((stream) => stream.codec_type === "audio");
  if (!video || video.codec_name !== "h264") throw new Error("QC requires H.264 video.");
  if (video.pix_fmt !== "yuv420p") throw new Error("QC requires yuv420p video.");
  if (Number(video.width) !== 1080 || Number(video.height) !== 1920) throw new Error("QC requires 1080x1920 video.");
  const fps = parseFrameRate(video.avg_frame_rate);
  if (Math.abs(fps - 30) > 0.001) throw new Error("QC requires exactly 30fps.");
  if (!audio || audio.codec_name !== "aac") throw new Error("QC requires an AAC audio track.");
  const frameCount = Number(video.nb_read_frames);
  if (!Number.isInteger(frameCount) || frameCount !== timeline.durationInFrames) throw new Error(`QC frame count ${frameCount} does not match Timeline ${timeline.durationInFrames}.`);
  const durationInSeconds = frameCount / fps;
  if (durationInSeconds < 20 || durationInSeconds > 40) throw new Error("QC duration must be 20-40 seconds.");
  const containerDurationInSeconds = Number(value?.format?.duration);
  if (
    !Number.isFinite(containerDurationInSeconds) ||
    containerDurationInSeconds < 20 || containerDurationInSeconds > 40.25 ||
    Math.abs(containerDurationInSeconds - durationInSeconds) > 0.25
  ) throw new Error("QC container duration must match the 20-40 second video within AAC padding tolerance.");
  const sizeBytes = Number(value?.format?.size);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) throw new Error("QC output must be non-empty.");
  return {videoCodec: video.codec_name, pixelFormat: video.pix_fmt, width: 1080, height: 1920, fps, audioCodec: audio.codec_name, frameCount, durationInSeconds, containerDurationInSeconds, sizeBytes};
};

export const qcRender = async ({paths, execFileImpl = execFile, now = () => performance.now()}) => {
  if (await exists(paths.outputPath)) throw new Error(`Final output already exists: ${paths.outputPath}`);
  const partial = await lstat(paths.partialOutputPath);
  if (partial.isSymbolicLink() || !partial.isFile() || partial.size === 0) throw new Error("Partial output is missing, empty, or unsafe.");
  const [timeline, index, result, propsBytes] = await Promise.all([
    readJson(paths.timelinePath),
    readJson(paths.indexPath),
    readJson(paths.resultPath),
    readFile(paths.propsPath),
  ]);
  assertRenderManifest(result, propsBytes);
  const shots = new Map(index.shots.map((shot) => [shot.id, shot]));
  const usedShots = timeline.clips.map((clip) => {
    const shot = shots.get(clip.assetShotId);
    if (!shot) throw new Error(`QC cannot resolve shot ${clip.assetShotId}.`);
    return {
      clipId: clip.id,
      assetShotId: clip.assetShotId,
      sourceId: shot.sourceId,
      sourcePath: shot.sourcePath,
      sourceInSeconds: clip.sourceInSeconds,
      sourceOutSeconds: clip.sourceOutSeconds,
      confidence: shot.confidence,
      reviewState: shot.reviewState,
    };
  });
  const started = now();
  const {stdout} = await execFileImpl("ffprobe", [
    "-v", "error", "-count_frames",
    "-show_entries", "stream=index,codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,nb_read_frames:format=duration,size",
    "-of", "json", paths.partialOutputPath,
  ], {maxBuffer: 8 * 1024 * 1024});
  const media = assertQcMetadata(stdout, timeline);
  await execFileImpl("ffmpeg", [
    "-nostdin", "-v", "error", "-xerror", "-i", paths.partialOutputPath, "-f", "null", "-",
  ], {maxBuffer: 16 * 1024 * 1024});
  const samples = buildContactSamples(timeline);
  if (!(await isJpeg(paths.finalCutContactPath))) {
    if (await exists(paths.finalCutContactPath)) throw new Error("Existing final-cut contact sheet is invalid or unsafe.");
    const contactTemporary = path.join(paths.contactsDir, `final-cut.${randomUUID()}.partial.jpg`);
    await execFileImpl(remotionCommand(paths), [
      "still", "src/index.ts", "MediaContactSheet", contactTemporary,
      "--props", JSON.stringify({mediaPath: path.basename(paths.partialOutputPath), samples}),
      "--public-dir", path.dirname(paths.partialOutputPath),
      "--image-format", "jpeg", "--jpeg-quality", "90", "--overwrite=false",
    ], {cwd: remotionCwd(paths), maxBuffer: 16 * 1024 * 1024});
    if (!(await isJpeg(contactTemporary))) throw new Error("Remotion produced an invalid final-cut JPEG.");
    await rename(contactTemporary, paths.finalCutContactPath);
  }
  const contact = await lstat(paths.finalCutContactPath);
  if (contact.isSymbolicLink() || !contact.isFile() || contact.size === 0) throw new Error("Final-cut contact sheet is missing, empty, or unsafe.");
  if (await exists(paths.outputPath)) throw new Error(`Final output appeared during QC: ${paths.outputPath}`);
  await rename(paths.partialOutputPath, paths.outputPath);
  return {
    outputPath: paths.outputPath,
    finalCutContactPath: paths.finalCutContactPath,
    ...media,
    qcElapsedMs: Math.round(now() - started),
    usedShots,
  };
};
```

Do not catch and delete the partial inside `qcRender()`. Any ffprobe, decode, contact-sheet, manifest, or promotion failure must leave diagnostic output in place and must not create a final MP4. A later `qc` retry is safe only because validation deterministically rewrites `props.json` and `assertRenderManifest()` binds those exact bytes to the render that produced the partial.

- [ ] **Step 6: Run all deterministic checks**

Run:

```bash
node --test scripts/lib/render-qc.test.mjs
npm run test:auto-edit
npm run typecheck
```

Expected: all tests PASS. The valid QC fixture returns exactly 600 frames/20 seconds; every one-field mutation fails.

- [ ] **Step 7: Commit if Git is available**

```bash
git rev-parse --is-inside-work-tree && git add scripts/lib/render-qc.mjs scripts/lib/render-qc.test.mjs && git commit -m "feat: render and verify partial outputs"
```

---

### Task 7: Wire the Restartable CLI and Status Machine

**Files:**
- Create: `scripts/auto-edit.mjs`
- Create: `scripts/auto-edit.test.mjs`
- Modify: `scripts/lib/job.mjs` and `scripts/lib/job.test.mjs` to expose local job paths before the SMB is mounted
- Modify: `package.json` to include the root CLI test

**Interfaces:**
- Consumes: all Task 2–6 modules.
- Produces these exact commands:

```text
node scripts/auto-edit.mjs index --config <job.json>
node scripts/auto-edit.mjs prepare --config <job.json>
node scripts/auto-edit.mjs validate --config <job.json>
node scripts/auto-edit.mjs render --config <job.json>
node scripts/auto-edit.mjs qc --config <job.json>
node scripts/auto-edit.mjs run --config <job.json> --through prepare
node scripts/auto-edit.mjs run --config <job.json> --from validate
```

Only the two documented `run` ranges are accepted. This keeps the human approval gate explicit and prevents `run --from render` from bypassing validation.
The individual `render` and `qc` commands prepend the `validate` stage internally, so validation failures always become `validation_failed`. After a `qc_failed` result leaves a manifest-bound partial in place, `qc --config <job.json>` is the only approved retry; `run --from validate` must not try to render over that diagnostic partial.

- [ ] **Step 1: Make local paths available even when the mount is absent**

Refactor Task 2's `loadJob()` without changing its tests:

```js
const buildPaths = (workspaceRoot, sourceRoot, jobId) => {
  const workDir = path.join(workspaceRoot, "work", jobId);
  const publicDir = path.join(workDir, "public");
  const contactsDir = path.join(workDir, "contacts");
  return {
    jobId,
    workspaceRoot,
    sourceRoot,
    workDir,
    publicDir,
    proxiesDir: path.join(publicDir, "proxies"),
    contactsDir,
    indexPath: path.join(workDir, "index.json"),
    timelinePath: path.join(workDir, "timeline.json"),
    propsPath: path.join(workDir, "props.json"),
    resultPath: path.join(workDir, "result.json"),
    partialOutputPath: path.join(workspaceRoot, "out", `${jobId}.partial.mp4`),
    outputPath: path.join(workspaceRoot, "out", `${jobId}.mp4`),
    finalCutContactPath: path.join(contactsDir, "final-cut.jpg"),
  };
};

export const loadJobDefinition = async (jobFile, {workspaceRoot = process.cwd()} = {}) => {
  const realWorkspace = await realpath(workspaceRoot);
  const resolvedJobFile = path.resolve(realWorkspace, jobFile);
  assertDescendant(realWorkspace, resolvedJobFile, "jobFile");
  const raw = validateConfig(JSON.parse(await readUtf8(resolvedJobFile)));
  const scriptCandidate = path.isAbsolute(raw.scriptPath) ? raw.scriptPath : path.resolve(realWorkspace, raw.scriptPath);
  const scriptPath = await realpath(scriptCandidate);
  assertDescendant(realWorkspace, scriptPath, "scriptPath");
  if (!(await stat(scriptPath)).isFile()) throw new Error("scriptPath must be a regular file.");
  await access(scriptPath, fsConstants.R_OK);
  await readUtf8(scriptPath);
  return {
    config: {...raw, scriptPath},
    paths: buildPaths(realWorkspace, raw.sourceRoot, raw.jobId),
  };
};

export const loadJob = async (jobFile, options = {}) => {
  const definition = await loadJobDefinition(jobFile, options);
  const mountRoot = options.mountRoot ?? "/Volumes/192.168.50.79";
  const [realMount, realSource] = await Promise.all([
    realpath(mountRoot),
    realpath(definition.config.sourceRoot),
  ]);
  assertDescendant(realMount, realSource, "sourceRoot");
  if (!(await stat(realSource)).isDirectory()) throw new Error("sourceRoot must be a readable directory.");
  await access(realSource, fsConstants.R_OK);
  return {
    config: {...definition.config, sourceRoot: realSource},
    paths: buildPaths(definition.paths.workspaceRoot, realSource, definition.config.jobId),
  };
};
```

Delete the now-duplicated parsing/path-building code from the original `loadJob()` body. Add this test to `scripts/lib/job.test.mjs`:

```js
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
```

Add `loadJobDefinition`, `readJson`, `writeResult` to that test file's import list. These tests prove local failure state and the proxy-only second pass do not depend on a live SMB connection, while review decisions survive later stage updates.

Also change `writeResult()` to preserve review fields and render timing across stage updates:

```js
export const writeResult = async (paths, status, detail = {}) => {
  if (!STATUSES.has(status)) throw new Error(`Unknown result status: ${status}`);
  let previous = {};
  try {
    previous = await readJson(paths.resultPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeJsonAtomic(paths.resultPath, {
    ...previous,
    ...detail,
    schemaVersion: 1,
    jobId: paths.jobId,
    status,
    updatedAt: new Date().toISOString(),
  });
};
```

- [ ] **Step 2: Write failing CLI range and stop-on-error tests**

Create `scripts/auto-edit.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  executeStages,
  failureStatus,
  parseCli,
  stagesFor,
} from "./auto-edit.mjs";

test("parses individual and approved two-pass commands", () => {
  assert.deepEqual(parseCli(["index", "--config", "job.json"]), {command: "index", configPath: "job.json", from: null, through: null});
  assert.deepEqual(stagesFor(parseCli(["render", "--config", "job.json"])), ["validate", "render"]);
  assert.deepEqual(stagesFor(parseCli(["qc", "--config", "job.json"])), ["validate", "qc"]);
  assert.deepEqual(stagesFor(parseCli(["run", "--config", "job.json", "--through", "prepare"])), ["index", "prepare"]);
  assert.deepEqual(stagesFor(parseCli(["run", "--config", "job.json", "--from", "validate"])), ["validate", "render", "qc"]);
  for (const argv of [
    ["run", "--config", "job.json"],
    ["run", "--config", "job.json", "--from", "render"],
    ["run", "--config", "job.json", "--through", "qc"],
    ["index", "--config", "job.json", "--from", "validate"],
    ["unknown", "--config", "job.json"],
  ]) assert.throws(() => stagesFor(parseCli(argv)));
});

test("maps every failing stage to the approved status", () => {
  assert.deepEqual(failureStatus, {
    index: "index_failed",
    prepare: "prepare_failed",
    validate: "validation_failed",
    render: "render_failed",
    qc: "qc_failed",
  });
  for (const command of ["render", "qc"]) {
    const firstStage = stagesFor(parseCli([command, "--config", "job.json"]))[0];
    assert.equal(failureStatus[firstStage], "validation_failed");
  }
});

test("executeStages stops at the first failure", async () => {
  const seen = [];
  const failures = [];
  await assert.rejects(executeStages(
    ["validate", "render", "qc"],
    async (stage) => {
      seen.push(stage);
      if (stage === "render") throw new Error("render broke");
    },
    async (stage, error) => failures.push([stage, error.message]),
  ), /render broke/);
  assert.deepEqual(seen, ["validate", "render"]);
  assert.deepEqual(failures, [["render", "render broke"]]);
});
```

- [ ] **Step 3: Run and confirm the CLI is missing**

Run:

```bash
node --test scripts/auto-edit.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `auto-edit.mjs`.

- [ ] **Step 4: Implement argument parsing and the stage executor**

Create the first portion of `scripts/auto-edit.mjs`:

```js
#!/usr/bin/env node
import {readJson, ensureWorkDirs, loadJob, loadJobDefinition, writeJsonAtomic, writeResult} from "./lib/job.mjs";
import {assertIndexMatchesSourceRoot, indexAssets} from "./lib/index-assets.mjs";
import {prepareMedia} from "./lib/prepare-media.mjs";
import {qcRender, renderJob, validateWithRemotion} from "./lib/render-qc.mjs";

const stageNames = ["index", "prepare", "validate", "render", "qc"];
export const failureStatus = {
  index: "index_failed",
  prepare: "prepare_failed",
  validate: "validation_failed",
  render: "render_failed",
  qc: "qc_failed",
};

export const parseCli = (argv) => {
  const [command, ...tokens] = argv;
  if (!command) throw new Error("Usage: auto-edit <index|prepare|validate|render|qc|run> --config <job.json> [--through prepare|--from validate]");
  const values = {command, configPath: null, from: null, through: null};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!value) throw new Error(`Missing value for ${flag}.`);
    if (flag === "--config") values.configPath = value;
    else if (flag === "--from") values.from = value;
    else if (flag === "--through") values.through = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!values.configPath) throw new Error("--config is required.");
  return values;
};

export const stagesFor = ({command, from, through}) => {
  if (stageNames.includes(command)) {
    if (from || through) throw new Error("Stage commands do not accept --from or --through.");
    if (command === "render") return ["validate", "render"];
    if (command === "qc") return ["validate", "qc"];
    return [command];
  }
  if (command !== "run") throw new Error(`Unknown command: ${command}`);
  if (through === "prepare" && from === null) return ["index", "prepare"];
  if (from === "validate" && through === null) return ["validate", "render", "qc"];
  throw new Error("run supports only --through prepare or --from validate.");
};

export const executeStages = async (stages, runStage, onFailure) => {
  for (const stage of stages) {
    try {
      await runStage(stage);
    } catch (error) {
      await onFailure(stage, error);
      throw error;
    }
  }
};
```

- [ ] **Step 5: Implement the actual stage handlers**

Append:

```js
const readIfPresent = async (filePath, fallback) => {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
};

export const runCli = async (argv = process.argv.slice(2)) => {
  const options = parseCli(argv);
  const stages = stagesFor(options);
  const definition = await loadJobDefinition(options.configPath);
  const requiresSource = stages.some((stage) => stage === "index" || stage === "prepare");
  let job;
  try {
    job = requiresSource ? await loadJob(options.configPath) : definition;
  } catch (error) {
    await ensureWorkDirs(definition.paths);
    await writeResult(definition.paths, failureStatus[stages[0]], {error: error.message});
    throw error;
  }
  const {config, paths} = job;
  await ensureWorkDirs(paths);

  const handlers = {
    index: async () => {
      const previousIndex = await readIfPresent(paths.indexPath, null);
      const {index, metrics} = await indexAssets({sourceRoot: paths.sourceRoot, previousIndex});
      await writeJsonAtomic(paths.indexPath, index);
      await writeResult(paths, "indexed", {index: metrics, error: null});
      process.stdout.write(`indexed sources=${metrics.sources} cached=${metrics.cached} probed=${metrics.probed} failed=${metrics.failed}\n`);
    },
    prepare: async () => {
      const index = await readJson(paths.indexPath);
      assertIndexMatchesSourceRoot(index, paths.sourceRoot);
      const {updatedIndex, metrics} = await prepareMedia({index, paths});
      await writeJsonAtomic(paths.indexPath, updatedIndex);
      const recheckedJob = await loadJob(options.configPath);
      if (recheckedJob.paths.sourceRoot !== paths.sourceRoot) throw new Error("sourceRoot changed while prepare was running.");
      if (metrics.prepared + metrics.cached === 0) throw new Error("No source was prepared successfully.");
      await writeResult(paths, "prepared", {prepare: metrics, error: null});
      process.stdout.write(`prepared=${metrics.prepared} cached=${metrics.cached} failed=${metrics.failed}\n`);
    },
    validate: async () => {
      await validateWithRemotion({config, paths});
      process.stdout.write(`validated ${paths.propsPath}\n`);
    },
    render: async () => {
      const render = await renderJob({paths});
      const current = await readIfPresent(paths.resultPath, {status: "prepared"});
      await writeResult(paths, current.status, {render, error: null});
      process.stdout.write(`rendered partial ${paths.partialOutputPath}\n`);
    },
    qc: async () => {
      const qc = await qcRender({paths});
      await writeResult(paths, "complete", {qc, error: null});
      process.stdout.write(`complete ${paths.outputPath}\n`);
    },
  };

  await executeStages(
    stages,
    async (stage) => handlers[stage](),
    async (stage, error) => writeResult(paths, failureStatus[stage], {error: error.message}),
  );
  if (options.command === "run" && options.through === "prepare") {
    await writeResult(paths, "needs_review", {
      error: null,
      nextAction: `Review ${paths.indexPath} and contacts, then create ${paths.timelinePath}.`,
    });
  }
};
```

Append the executable boundary:

```js
import {pathToFileURL} from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 6: Include the root CLI test in the final npm command**

Change the root script to:

```json
"test:auto-edit": "node --test scripts/auto-edit.test.mjs scripts/lib/*.test.mjs"
```

`validate`, `render`, `qc`, and `run --from validate` deliberately use `loadJobDefinition()` and remain executable from local proxies after an SMB disconnect. A malformed config or local script fails before a safe job exists, prints its schema/path error, and does not invent a result path.

- [ ] **Step 7: Run parser, status, module, and type checks**

Run:

```bash
node --test scripts/auto-edit.test.mjs scripts/lib/job.test.mjs
npm run test:auto-edit
npm run typecheck
```

Expected: all tests and typechecks PASS. Task 8 performs the missing-mount integration check after creating the fixture.

- [ ] **Step 8: Commit if Git is available**

```bash
git rev-parse --is-inside-work-tree && git add scripts/auto-edit.mjs scripts/auto-edit.test.mjs scripts/lib/job.mjs scripts/lib/job.test.mjs package.json && git commit -m "feat: orchestrate restartable auto-edit stages"
```

---

### Task 8: Encode the One-Draft Codex Workflow and Smoke Jobs

**Files:**
- Create: `examples/jobs/s16-smoke.json`
- Create: `examples/scripts/shaver-smoke.txt`
- Create: `examples/jobs/4-27-scale.json`
- Create: `examples/scripts/4-27-scale.txt`
- Modify: `skills/auto-edit-product-video/SKILL.md`
- Modify: `skills/auto-edit-product-video/references/timeline-contract.md`
- Modify: `skills/auto-edit-product-video/agents/openai.yaml`

**Interfaces:**
- Consumes: the Task 7 CLI, `index.json`, and labeled contact sheets.
- Produces: one user-reviewed `work/<job-id>/timeline.json`; the validate stage deterministically derives `props.json` from that Timeline and the index.

No permanent Timeline fixture is committed because source IDs intentionally depend on the mounted files' relative path, size, and `mtimeMs`.

- [ ] **Step 1: Add the approved S16 job and neutral script**

Create `examples/jobs/s16-smoke.json`:

```json
{
  "schemaVersion": 1,
  "jobId": "s16-smoke",
  "sourceRoot": "/Volumes/192.168.50.79/S16素材",
  "scriptPath": "examples/scripts/shaver-smoke.txt",
  "product": {
    "sku": "SHAVER-SMOKE",
    "name": "剃须刀素材测试",
    "sellingPoints": ["产品展示", "使用展示"],
    "aliases": ["剃须刀", "刮胡刀"],
    "referenceImages": []
  },
  "target": {
    "width": 1080,
    "height": 1920,
    "fps": 30,
    "minDurationSeconds": 20,
    "maxDurationSeconds": 40
  }
}
```

Create `examples/scripts/shaver-smoke.txt`:

```text
先看产品展示，确认机身与刀头外观。
再看使用展示，展示手持操作过程。
最后回到产品正面，提示查看商品详情。
```

- [ ] **Step 2: Add the neutral 76-file scale job**

Create `examples/jobs/4-27-scale.json`:

```json
{
  "schemaVersion": 1,
  "jobId": "4-27-scale",
  "sourceRoot": "/Volumes/192.168.50.79/4.27拍摄视频",
  "scriptPath": "examples/scripts/4-27-scale.txt",
  "product": {
    "sku": "BATCH-4-27-SCALE",
    "name": "4.27拍摄批次流程测试",
    "sellingPoints": ["素材画面展示", "不同角度展示"],
    "aliases": [],
    "referenceImages": []
  },
  "target": {
    "width": 1080,
    "height": 1920,
    "fps": 30,
    "minDurationSeconds": 20,
    "maxDurationSeconds": 40
  }
}
```

Create `examples/scripts/4-27-scale.txt`:

```text
先展示本批次中清晰的产品画面。
再展示不同角度或操作过程。
最后回到产品画面，提示查看商品详情。
```

Both jobs are workflow tests, not publishable customer claims. Their rendered videos remain silent review drafts unless the user later supplies confirmed catalog claims, audio, and publication approval.

- [ ] **Step 3: Replace the skill with the exact two-pass workflow**

Keep the current YAML frontmatter name and description intent, then make `skills/auto-edit-product-video/SKILL.md` contain these operational rules:

```markdown
---
name: auto-edit-product-video
description: Prepare, select, validate, and render one traceable vertical product-video Timeline from an explicit local/SMB batch and a user script in this Remotion repository. Use when Codex is asked to inspect indexed footage, choose real shots, revise a Timeline, or render an approved review draft.
---

# Auto-edit one product video draft

## Protect the source and the claims

- Read `docs/DEFERRED_CAPABILITIES.md` and the selected job JSON before acting.
- Treat `sourceRoot` as read-only. Write only under the job's local `work/` and `out/` paths.
- Use only the user's script text for subtitles and claims; split or shorten literal passages, but do not invent efficacy, pricing, certification, or comparison claims.
- Never substitute demo placeholders, a different product, or unrelated footage when a trustworthy match is absent.
- Treat the MVP as a silent, non-publishable review draft. Voiceover and music remain `source: null`, `state: not_configured`.

## Pass 1: index and prepare

Run:

```bash
node scripts/auto-edit.mjs run --config <job-json> --through prepare
```

Stop on a nonzero exit. Do not fall back to `ProductMarketingDemo`.

Read the job JSON, its UTF-8 script, `work/<job-id>/index.json`, and every `work/<job-id>/contacts/<source-id>.jpg`.

## Select one Timeline

1. Split the script into hook, body/selling points, proof shots, and CTA without adding claims.
2. Use directory segments and `product.aliases` only for recall. Product/SKU correctness outranks image quality and visual variety.
3. Select real source ranges from contact sheets. Ordinary clips default to 2–4 seconds; the hook should begin within the first 3 seconds.
4. Never repeat the same source range. Never select two different sources with the same non-null `quickFingerprint`.
5. If a script segment has no credible footage, stop and ask for a source choice. Do not use `assetShotId: null`.
6. Write exactly one `work/<job-id>/timeline.json` against `packages/shared/src/index.ts` and `references/timeline-contract.md`.
7. Use 1080×1920, 30fps, 600–1200 contiguous frames. Keep `voiceover` and `music` unconfigured.
8. Keep Timeline status `needs_review`. Present every clip's `AssetShot.id`, source path, source in/out, purpose, and confidence to the user.
9. Preserve low-confidence reasons and selected-shot details in `result.json.reviewNotes`; do not erase existing stage metrics.
10. Only after explicit user approval, change Timeline status to `approved`.

## Pass 2: validate, render, and verify

Run:

```bash
node scripts/auto-edit.mjs run --config <job-json> --from validate
```

The command must fail before rendering if subtitles are not literal script text, a shot/range/proxy is invalid, duplicate fingerprints are selected, Timeline is not approved, or the demo SKU/null shots appear.

If this pass reaches `qc_failed`, keep the diagnostic partial and render manifest. After fixing the QC environment—not the approved Timeline—retry only:

```bash
node scripts/auto-edit.mjs qc --config <job-json>
```

QC must reject the partial if the current validated Props SHA-256 differs from the render manifest. For any Timeline or shot change, preserve the old job artifacts and use a new job ID; never promote the old partial.

Report the final MP4, final-cut contact sheet, `result.json.status`, every used source/range, low-confidence choices, and the fact that the MVP audio track is silent.

## Demo mode

Use `ProductMarketingDemo` only for a user-requested framework smoke test:

```bash
npm run typecheck
npm run studio
npm run render:demo
```

State that demo mode uses programmatic placeholders and is not a real material draft.
```

Use this exact review-note shape so later `writeResult()` merges it unchanged:

```ts
interface ReviewNotes {
  selectedShots: Array<{
    clipId: string;
    assetShotId: string;
    sourcePath: string;
    sourceInSeconds: number;
    sourceOutSeconds: number;
    purpose: "hook" | "body" | "proof" | "cta";
    confidence: number;
  }>;
  lowConfidence: Array<{
    clipId: string;
    reason: string;
  }>;
}
```

Populate every value from the actual index, Timeline, and visual review; never use invented IDs or paths.

- [ ] **Step 4: Update the Timeline operational reference**

Retain its pointer to `packages/shared/src/index.ts` as the authority and make `skills/auto-edit-product-video/references/timeline-contract.md` list all of these invariants:

```markdown
- `schemaVersion === 1`; 1080×1920; 30fps; 600–1200 frames.
- Clip IDs and subtitle IDs are unique.
- Clips are in playback order, start at frame 0, are contiguous, never overlap, and exactly cover `durationInFrames`.
- Every real clip has a non-null `assetShotId` resolving through `RenderJobProps.shots`.
- `index.sourceRoot` equals the selected job's explicit `sourceRoot`; every source and shot path resolves inside that same batch.
- Every source range is inside its `AssetShot` range and is long enough for the Timeline duration.
- `fit` is `cover` or `contain`; `focusX` and `focusY` are `0..1` and default to `0.5`.
- `AssetShot.proxyPath` is relative to the job public-dir, for example `proxies/<source-id>.mp4`.
- Subtitles are literal text from the configured user script.
- `voiceover` and `music` use `source: null` and `state: not_configured`.
- Real rendering requires `status: approved`, rejects `DEMO-SKU-001`, and rejects `assetShotId: null`.
- Props have exactly `{timeline: Timeline, shots: Record<string, AssetShot>}`; `shots` contains referenced shots keyed by `shot.id`.
```

Keep `npm run typecheck` as the schema-consumer check. Replace the old instruction to “add a separately named composition” with the concrete `ProductMarketingReal` two-pass CLI commands.

- [ ] **Step 5: Update the skill UI prompt**

In `skills/auto-edit-product-video/agents/openai.yaml`, keep the display name and short description and replace `default_prompt` with:

```yaml
  default_prompt: "Use $auto-edit-product-video to prepare one traceable real-footage Timeline from an explicit batch and user script, then render only after approval."
```

- [ ] **Step 6: Verify fixtures, documentation, and missing-mount behavior**

Run:

```bash
node -e "for (const file of ['examples/jobs/s16-smoke.json','examples/jobs/4-27-scale.json']) JSON.parse(require('node:fs').readFileSync(file,'utf8')); console.log('job json ok')"
! rg -n "three product video drafts|Produce three|三份|三个候选" skills/auto-edit-product-video
npm run typecheck
node scripts/auto-edit.mjs run --config examples/jobs/s16-smoke.json --through prepare
```

Expected:

- JSON parsing prints `job json ok`.
- `rg` returns no matches.
- Typecheck exits 0.
- While SMB is disconnected, the final command exits nonzero and writes `work/s16-smoke/result.json` with `status: "index_failed"`; it creates no proxy, Timeline, partial, final MP4, or demo fallback.

- [ ] **Step 7: Commit if Git is available**

```bash
git rev-parse --is-inside-work-tree && git add examples skills/auto-edit-product-video && git commit -m "docs: define one-draft auto-edit workflow"
```

---

### Task 9: Run Local Regression, S16 Acceptance, and 76-File Scale Acceptance

**Files:**
- Verify only: all files above plus generated `work/` and `out/` artifacts.
- Do not commit generated proxies, indexes, timelines, contact sheets, result files, partials, or MP4s.

**Interfaces:**
- Consumes: completed Tasks 1–8 and a user-remounted SMB share.
- Produces: evidence for approved Stages 0–5 and the final completion decision.

- [ ] **Step 1: Run Stage 0 regression before mounting-dependent work**

Run:

```bash
npm run test:auto-edit
npm run typecheck
npm run build
npm ls remotion @remotion/cli
ffprobe -v error -show_entries stream=codec_type,codec_name,width,height,avg_frame_rate -show_entries format=duration -of json out/demo-product.mp4
```

Expected: all tests/typechecks/build pass; npm reports Remotion and CLI 4.0.496 from the current lockfile; demo remains H.264/AAC, 1080×1920, 30fps, approximately 24 seconds.

- [ ] **Step 2: Stop until the user remounts the share**

Ask the user to remount `smb://192.168.50.79/D`, then run:

```bash
mount | rg 'smbfs|192\.168\.50\.79'
test -d '/Volumes/192.168.50.79/S16素材'
test -d '/Volumes/192.168.50.79/4.27拍摄视频'
test ! -e 'work/s16-smoke/index.json'
test ! -e 'work/s16-smoke/timeline.json'
test ! -e 'work/s16-smoke/props.json'
test -z "$(find 'work/s16-smoke/public/proxies' -type f -print -quit 2>/dev/null)"
test -z "$(find 'work/s16-smoke/contacts' -type f -print -quit 2>/dev/null)"
test ! -e 'out/s16-smoke.mp4'
test ! -e 'out/s16-smoke.partial.mp4'
test ! -e 'work/s16-smoke/contacts/final-cut.jpg'
test ! -e 'work/4-27-scale/index.json'
test ! -e 'work/4-27-scale/timeline.json'
test ! -e 'work/4-27-scale/props.json'
test -z "$(find 'work/4-27-scale/public/proxies' -type f -print -quit 2>/dev/null)"
test -z "$(find 'work/4-27-scale/contacts' -type f -print -quit 2>/dev/null)"
test ! -e 'out/4-27-scale.mp4'
test ! -e 'out/4-27-scale.partial.mp4'
test ! -e 'work/4-27-scale/contacts/final-cut.jpg'
```

Expected: all commands exit 0. These exact job IDs must have no prior index, Timeline, proxy, contact-sheet, partial, or final artifact, so the first-scan `cached=0` assertions are reproducible. If anything exists, stop and ask the user to preserve/move it or authorize a new job ID; never delete or overwrite it. Do not attempt to mount, authenticate, or change the share on the user's behalf.

- [ ] **Step 3: Capture the S16 read-only baseline**

Run:

```bash
find '/Volumes/192.168.50.79/S16素材' -type f -exec stat -f '%N|%z|%m' {} + | LC_ALL=C sort > /tmp/s16-before.tsv
shasum -a 256 /tmp/s16-before.tsv
```

Expected: one baseline digest is printed. Keep `/tmp/s16-before.tsv` through Stage 4.

- [ ] **Step 4: Execute and verify S16 Stages 1–2**

Run:

```bash
node scripts/auto-edit.mjs index --config examples/jobs/s16-smoke.json
node scripts/auto-edit.mjs index --config examples/jobs/s16-smoke.json
node scripts/auto-edit.mjs run --config examples/jobs/s16-smoke.json --through prepare
node -e "const x=require('./work/s16-smoke/index.json'); if(x.sources.length!==2||x.shots.length!==2) process.exit(1); console.log(x.sources.map(s=>[s.relativePath,s.status,s.proxyPath,s.contactSheetPath]))"
find '/Volumes/192.168.50.79/S16素材' -type f -exec stat -f '%N|%z|%m' {} + | LC_ALL=C sort > /tmp/s16-after-prepare.tsv
cmp /tmp/s16-before.tsv /tmp/s16-after-prepare.tsv
```

Expected:

- First index prints `cached=0 probed=2`; second index prints `cached=2 probed=0`.
- The `run --through prepare` pass reuses the cached index and ends at `needs_review` with two prepared sources, two H.264/yuv420p/30fps silent proxies, and two labeled JPEG contact sheets.
- Node prints exactly two prepared records.
- `cmp` exits 0, proving the source name/size/mtime list did not change.

Open both `work/s16-smoke/contacts/<source-id>.jpg` files and verify distinct visible frames plus readable relative paths and timecodes. A blank or unlabeled sheet fails Stage 2.

- [ ] **Step 5: Use the project skill to create one S16 Timeline and pause for approval**

Invoke `auto-edit-product-video` and follow Task 8 exactly. Before asking for approval, verify with a Node assertion:

```bash
node -e "const t=require('./work/s16-smoke/timeline.json'); if(t.status!=='needs_review'||t.width!==1080||t.height!==1920||t.fps!==30||t.durationInFrames<600||t.durationInFrames>1200||t.clips.some(c=>c.assetShotId===null)) process.exit(1); console.log('timeline ready for review')"
```

Expected: `timeline ready for review`. Present clip/source/range/confidence details to the user and stop. Do not change the status or render until the user explicitly approves this exact Timeline.

- [ ] **Step 6: After approval, execute and verify S16 Stages 3–4**

Change only `timeline.status` from `needs_review` to `approved`, then run:

```bash
node scripts/auto-edit.mjs run --config examples/jobs/s16-smoke.json --from validate
ffprobe -v error -count_frames -show_entries stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,nb_read_frames -show_entries format=duration,size -of json out/s16-smoke.mp4
ffmpeg -nostdin -v error -xerror -i out/s16-smoke.mp4 -f null -
node -e "const r=require('./work/s16-smoke/result.json'); if(r.status!=='complete') process.exit(1); console.log(r.qc)"
find '/Volumes/192.168.50.79/S16素材' -type f -exec stat -f '%N|%z|%m' {} + | LC_ALL=C sort > /tmp/s16-after-render.tsv
cmp /tmp/s16-before.tsv /tmp/s16-after-render.tsv
```

Expected:

- `out/s16-smoke.mp4` is H.264/yuv420p/AAC, 1080×1920, 30fps, exactly the approved Timeline frame count, and 20–40 seconds.
- Full decode exits 0 with no stderr error.
- `work/s16-smoke/contacts/final-cut.jpg` exists, is nonzero, and visibly contains first, last, and every cut-after frame with labels.
- Result status is `complete` and includes render timing, QC metadata, and used shots.
- SMB comparison exits 0.

- [ ] **Step 7: Capture and run the 76-file scale batch**

Run:

```bash
find '/Volumes/192.168.50.79/4.27拍摄视频' -type f -exec stat -f '%N|%z|%m' {} + | LC_ALL=C sort > /tmp/4-27-before.tsv
node scripts/auto-edit.mjs index --config examples/jobs/4-27-scale.json
node scripts/auto-edit.mjs index --config examples/jobs/4-27-scale.json
node scripts/auto-edit.mjs run --config examples/jobs/4-27-scale.json --through prepare
node -e "const x=require('./work/4-27-scale/index.json'); if(x.sources.length!==76||x.shots.length!==76) process.exit(1); const c=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'}); const sorted=[...x.sources].sort((a,b)=>c.compare(a.relativePath,b.relativePath)); if(x.sources.some((s,i)=>s.id!==sorted[i].id)) process.exit(1); console.log('76 sources, natural order ok')"
find '/Volumes/192.168.50.79/4.27拍摄视频' -type f -exec stat -f '%N|%z|%m' {} + | LC_ALL=C sort > /tmp/4-27-after-prepare.tsv
cmp /tmp/4-27-before.tsv /tmp/4-27-after-prepare.tsv
```

Expected:

- First index probes exactly 76 sources; second index prints `cached=76 probed=0`; the final prepare pass leaves all 76 sources prepared and the job at `needs_review`.
- Node prints `76 sources, natural order ok`; names such as `11 (2)` sort before `11 (10)`.
- All 76 proxy/contact pairs exist locally.
- SMB comparison exits 0.

- [ ] **Step 8: Create, approve, render, and verify one scale-batch Timeline**

Invoke `auto-edit-product-video` with `examples/jobs/4-27-scale.json`. Require it to read the neutral script, all 76 indexed records, and their contact sheets; select one set of non-repeated, non-duplicate-fingerprint ranges; write one contiguous 1080×1920/30fps/600–1200-frame `work/4-27-scale/timeline.json`; keep its status `needs_review`; and present every selected ID/path/range/confidence. Pause for explicit approval. After approval, change only the status to `approved` and run:

```bash
node scripts/auto-edit.mjs run --config examples/jobs/4-27-scale.json --from validate
ffprobe -v error -count_frames -show_entries stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,nb_read_frames -show_entries format=duration,size -of json out/4-27-scale.mp4
ffmpeg -nostdin -v error -xerror -i out/4-27-scale.mp4 -f null -
node -e "const r=require('./work/4-27-scale/result.json'); if(r.status!=='complete') process.exit(1); console.log('scale render complete')"
find '/Volumes/192.168.50.79/4.27拍摄视频' -type f -exec stat -f '%N|%z|%m' {} + | LC_ALL=C sort > /tmp/4-27-after-render.tsv
cmp /tmp/4-27-before.tsv /tmp/4-27-after-render.tsv
```

Expected: `out/4-27-scale.mp4` is H.264/yuv420p/AAC, 1080×1920, 30fps, exactly the approved Timeline frame count, and 20–40 seconds; full decode emits no error; the final-cut sheet visibly contains labeled first/last/cut-after frames; result prints `scale render complete`; SMB comparison exits 0.

- [ ] **Step 9: Apply the completion gate**

The implementation is complete only if every condition is true:

```text
all Node tests, TypeScript checks, and Web build pass
demo behavior remains intact
S16 indexes 2/2 and second scan is cached=2, probed=0
4.27 indexes 76/76 and second scan is cached=76, probed=0
all proxies and source contact sheets meet their contracts
both approved Timelines have no null/unresolved/repeated/duplicate-fingerprint shots
both final MP4s meet codec, pixel format, AAC, dimensions, fps, frame count, and duration rules
both final MP4s fully decode and have labeled cut contact sheets
both result files have status complete and traceable used shots
both SMB before/after manifests are byte-identical
```

If any condition is false, leave the relevant approved failure status and diagnostic partial in place, do not claim completion, and do not broaden scope beyond the failing stage.

---

## Execution Checkpoints

1. **After Task 3:** review the trust boundary and index JSON before any FFmpeg work.
2. **After Task 5:** review real Composition metadata rejection and confirm the demo still works.
3. **After Task 7:** review all unit/integration checks and the missing-mount failure before touching SMB.
4. **After S16 prepare:** inspect both labeled contact sheets before Codex authors a Timeline.
5. **At each Timeline:** user approval is mandatory before `--from validate`.
6. **After S16 complete:** proceed to 76 files only if source manifests are unchanged.

## Deliberate MVP Ceilings

- `size + mtimeMs` cache identity can miss content rewritten with both values preserved; add full hashes only after a measured false cache hit.
- Quick fingerprints mark duplicate candidates; they never delete or mutate source files.
- Proxy-based final render prioritizes stability over source-master quality; add source relinking only if proxy output fails an agreed publication-quality review.
- Contact sheets decode multiple frames in one Remotion Still. Keep the single path unless the S16 smoke proves it unstable; do not prebuild a second implementation.
- The workflow is one operator, one local job at a time; add locking or a queue only after actual concurrent use appears.
