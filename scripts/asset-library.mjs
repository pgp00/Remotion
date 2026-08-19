#!/usr/bin/env node
import {randomUUID} from "node:crypto";
import {access, mkdir, readFile, realpath, rename, stat, writeFile} from "node:fs/promises";
import {constants as fsConstants} from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {discover} from "./lib/index-assets.mjs";
import {scanAssetLibrary, searchAssets} from "./lib/asset-library.mjs";
import {renderAssetSheets} from "./lib/asset-library-media.mjs";

const usage = "Usage: asset-library scan --source-root <absolute-path> [--work-dir <path>] [--resume <run-id>] [--media-concurrency <positive-int>] | asset-library search [keyword] [--catalog <path>] [--tag <tag>] [--state <state>] [--flag <flag>] [--exclude-flag <flag>] [--orientation portrait|landscape|square] [--codec <codec>] [--min-duration <seconds>] [--max-duration <seconds>] [--json]";
const visualFlags = new Set(["mostly_black", "frozen_tail", "empty_tail_candidate"]);

const addValue = (options, key, value) => {
  options[key] ??= [];
  options[key].push(value);
};

const number = (flag, value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative number.`);
  return parsed;
};

const positiveInteger = (flag, value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer.`);
  return parsed;
};

export const parseCli = (argv) => {
  const [command, ...tokens] = argv;
  if (command === "scan") {
    const options = {command, sourceRoot: null, workDir: null, resume: null, mediaConcurrency: 1};
    for (let index = 0; index < tokens.length; index += 2) {
      const flag = tokens[index];
      const value = tokens[index + 1];
      if (!value || !flag.startsWith("--")) throw new Error(`Missing value for ${flag ?? "option"}.`);
      if (flag === "--source-root") options.sourceRoot = value;
      else if (flag === "--work-dir") options.workDir = value;
      else if (flag === "--resume") options.resume = value;
      else if (flag === "--media-concurrency") options.mediaConcurrency = positiveInteger(flag, value);
      else throw new Error(`Unknown option: ${flag}`);
    }
    if (!options.sourceRoot) throw new Error("--source-root is required.");
    if (!path.isAbsolute(options.sourceRoot)) throw new Error("--source-root must be an absolute path.");
    if (options.resume && path.basename(options.resume) !== options.resume) throw new Error("--resume must be a safe run ID.");
    return options;
  }
  if (command === "search") {
    const options = {command, keyword: "", catalogPath: null, tag: [], state: [], flag: [], excludeFlag: [], orientation: [], codec: [], minDuration: null, maxDuration: null, json: false};
    let index = 0;
    if (tokens[0] && !tokens[0].startsWith("--")) options.keyword = tokens[index++];
    while (index < tokens.length) {
      const flag = tokens[index++];
      if (flag === "--json") {
        options.json = true;
        continue;
      }
      const value = tokens[index++];
      if (!value) throw new Error(`Missing value for ${flag}.`);
      if (flag === "--catalog") options.catalogPath = value;
      else if (["--tag", "--state", "--flag", "--exclude-flag", "--orientation", "--codec"].includes(flag)) addValue(options, flag.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase()), value);
      else if (flag === "--min-duration") options.minDuration = number(flag, value);
      else if (flag === "--max-duration") options.maxDuration = number(flag, value);
      else throw new Error(`Unknown option: ${flag}`);
    }
    if (options.minDuration != null && options.maxDuration != null && options.minDuration > options.maxDuration) throw new Error("--min-duration may not exceed --max-duration.");
    return options;
  }
  throw new Error(usage);
};

const readJsonIfPresent = async (filePath, fallback = null) => {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
};

const writeJsonAtomic = async (filePath, value) => {
  await mkdir(path.dirname(filePath), {recursive: true});
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {encoding: "utf8", flag: "wx"});
  JSON.parse(await readFile(temporary, "utf8"));
  await rename(temporary, filePath);
};

const sourceSnapshot = async (sourceRoot) => {
  await access(sourceRoot, fsConstants.R_OK);
  if (!(await stat(sourceRoot)).isDirectory()) throw new Error("sourceRoot must be a readable directory.");
  const relativePaths = await discover(sourceRoot);
  const details = await Promise.all(relativePaths.map((relativePath) => stat(path.join(sourceRoot, relativePath))));
  return {count: details.length, bytes: details.reduce((total, item) => total + item.size, 0), maxMtimeMs: details.reduce((latest, item) => Math.max(latest, item.mtimeMs), 0)};
};

const libraryPaths = (workDir) => ({
  workDir,
  workspaceRoot: process.cwd(),
  catalogPath: path.join(workDir, "catalog.json"),
  manifestPath: path.join(workDir, "manifest.json"),
  checkpointPath: path.join(workDir, "checkpoint.json"),
  runsDir: path.join(workDir, "runs"),
  contactsDir: path.join(workDir, "contacts"),
  ctaDir: path.join(workDir, "cta"),
  stagingDir: path.join(workDir, ".staging"),
});

const ensureLibraryDirs = async (paths) => {
  await Promise.all([paths.workDir, paths.runsDir, paths.contactsDir, paths.ctaDir, paths.stagingDir].map((directory) => mkdir(directory, {recursive: true})));
};

const sameSnapshot = (left, right) => left?.count === right?.count && left?.bytes === right?.bytes && left?.maxMtimeMs === right?.maxMtimeMs;
const runIdFor = (resume) => resume || `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const isWithin = (parent, child) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

const resolvedPathIfPresent = async (filePath) => {
  try {
    return await realpath(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(filePath);
    const resolvedParent = parent === filePath ? parent : await resolvedPathIfPresent(parent);
    return path.join(resolvedParent, path.basename(filePath));
  }
};

export const runScan = async ({
  sourceRoot,
  workDir = path.resolve("work/asset-library"),
  resume = null,
  mediaConcurrency = 1,
  scanImpl = scanAssetLibrary,
  renderSheetsImpl = renderAssetSheets,
  snapshotImpl = sourceSnapshot,
  writeJsonImpl = writeJsonAtomic,
  now = () => new Date(),
} = {}) => {
  if (!sourceRoot || !path.isAbsolute(sourceRoot)) throw new Error("sourceRoot must be an absolute path.");
  if (!Number.isInteger(mediaConcurrency) || mediaConcurrency < 1) throw new Error("mediaConcurrency must be a positive integer.");
  const paths = libraryPaths(path.resolve(workDir));
  const [resolvedSourceRoot, resolvedWorkDir] = await Promise.all([
    resolvedPathIfPresent(sourceRoot),
    resolvedPathIfPresent(paths.workDir),
  ]);
  if (isWithin(sourceRoot, paths.workDir) || isWithin(resolvedSourceRoot, resolvedWorkDir)) {
    throw new Error("workDir must be outside sourceRoot; SMB is read-only.");
  }
  await ensureLibraryDirs(paths);
  const runId = runIdFor(resume);
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error("resume must be a safe run ID.");
  const runPath = path.join(paths.runsDir, `${runId}.json`);
  const existingRun = await readJsonIfPresent(runPath, {});
  const writeRun = async (status, detail = {}) => writeJsonImpl(runPath, {
    ...existingRun, ...detail, schemaVersion: 1, runId, sourceRoot, status, updatedAt: now().toISOString(),
  });
  let checkpointState = null;
  let checkpointChanges = 0;
  let checkpointWrites = Promise.resolve();
  const persistCheckpoint = (force = false) => {
    if (!checkpointState) return checkpointWrites;
    checkpointChanges += 1;
    if (!force && checkpointChanges < 25) return checkpointWrites;
    checkpointChanges = 0;
    const snapshot = structuredClone(checkpointState);
    checkpointWrites = checkpointWrites.then(() => writeJsonImpl(paths.checkpointPath, snapshot));
    return checkpointWrites;
  };
  try {
    await writeRun("running", {startedAt: existingRun.startedAt ?? now().toISOString(), error: null});
    const previousCatalog = await readJsonIfPresent(paths.catalogPath);
    const previousManifest = await readJsonIfPresent(paths.manifestPath, {});
    const checkpoint = await readJsonIfPresent(paths.checkpointPath);
    checkpointState = checkpoint;
    const result = await scanImpl({
      sourceRoot,
      workDir: paths.workDir,
      previousCatalog,
      checkpoint,
      onCheckpoint: async (value) => {
        checkpointState = value;
        await persistCheckpoint();
      },
    });
    const catalog = result.catalog;
    checkpointState = result.checkpoint ?? checkpointState;
    if (!Array.isArray(catalog.assets) || catalog.assets.length === 0) throw new Error("No supported video records were produced; refusing to publish an empty catalog.");
    await persistCheckpoint(true);
    await writeRun("rendering_sheets", {metrics: result.metrics, missing: result.missing, warnings: result.warnings, error: null});
    const renderable = catalog.assets.filter((asset) => asset.state !== "failed" && Number.isFinite(asset.durationInSeconds) && asset.durationInSeconds > 0);
    const workers = Math.min(mediaConcurrency, Math.max(1, renderable.length));
    const renderOne = async (asset) => {
      try {
        const sheets = await renderSheetsImpl({record: asset, paths});
        asset.contactSheetPath = sheets.contactSheetPath;
        asset.ctaSheetPath = sheets.ctaSheetPath;
        asset.qualityFlags = [...new Set([...(asset.qualityFlags ?? []).filter((flag) => !visualFlags.has(flag)), ...(sheets.qualityFlags ?? [])])];
        asset.state = "complete";
        asset.error = null;
      } catch (error) {
        asset.state = "failed";
        asset.error = {stage: "frames", message: error?.message ?? String(error)};
      }
      const checkpointAsset = checkpointState?.assets?.find((item) => item.id === asset.id);
      if (checkpointAsset) Object.assign(checkpointAsset, asset);
      await persistCheckpoint();
    };
    await Promise.all(Array.from({length: workers}, async (_, worker) => {
      for (let index = worker; index < renderable.length; index += workers) await renderOne(renderable[index]);
    }));
    await persistCheckpoint(true);
    const finalSnapshot = await snapshotImpl(sourceRoot);
    if (!sameSnapshot(result.sourceSnapshots?.after, finalSnapshot)) throw new Error("Source contents changed or became unreadable before catalog publish.");
    await writeJsonImpl(paths.catalogPath, catalog);
    const missingPaths = new Set((result.missing ?? []).map((asset) => asset.relativePath));
    const missingCounts = {...(previousManifest.missingCounts ?? {})};
    for (const relativePath of Object.keys(missingCounts)) {
      if (!missingPaths.has(relativePath)) delete missingCounts[relativePath];
    }
    for (const relativePath of missingPaths) missingCounts[relativePath] = Number(missingCounts[relativePath] ?? 0) + 1;
    const missingCleanupCandidates = Object.entries(missingCounts)
      .filter(([, scans]) => scans >= 2)
      .map(([relativePath, scans]) => ({relativePath, missingScans: scans}));
    const manifest = {schemaVersion: 1, sourceRoot, runId, completedAt: now().toISOString(), sourceSnapshot: finalSnapshot, metrics: {...result.metrics, complete: catalog.assets.filter((asset) => asset.state === "complete").length, failed: catalog.assets.filter((asset) => asset.state === "failed").length}, missing: result.missing ?? [], missingCounts, missingCleanupCandidates, warnings: result.warnings ?? []};
    await writeJsonImpl(paths.manifestPath, manifest);
    await writeRun("complete", {
      metrics: manifest.metrics,
      missing: manifest.missing,
      missingCounts: manifest.missingCounts,
      missingCleanupCandidates: manifest.missingCleanupCandidates,
      warnings: manifest.warnings,
      error: null,
      completedAt: manifest.completedAt,
    });
    return {runId, catalog, manifest};
  } catch (error) {
    await persistCheckpoint(true);
    await writeRun("failed", {error: error?.message ?? String(error)});
    throw error;
  }
};

const formatRows = (assets) => ["state\tduration\tcodec\tpath", ...assets.map((asset) => `${asset.state}\t${Number(asset.durationInSeconds || 0).toFixed(2)}\t${asset.codec ?? ""}\t${asset.relativePath}`)].join("\n") + "\n";

export const runSearch = async ({catalogPath = path.resolve("work/asset-library/catalog.json"), json = false, ...filters} = {}, write = (text) => process.stdout.write(text)) => {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const assets = searchAssets(catalog, filters);
  write(json ? `${JSON.stringify(assets, null, 2)}\n` : formatRows(assets));
  return assets;
};

export const runCli = async (argv = process.argv.slice(2)) => {
  const options = parseCli(argv);
  if (options.command === "scan") {
    const result = await runScan(options);
    process.stdout.write(`complete run=${result.runId} assets=${result.catalog.assets.length}\n`);
    return result;
  }
  return runSearch(options);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
