#!/usr/bin/env node
import {execFile as execFileCallback} from "node:child_process";
import {constants as fsConstants} from "node:fs";
import {createHash, randomUUID} from "node:crypto";
import {access, copyFile, link, lstat, mkdir, readFile, realpath, rename, writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {promisify} from "node:util";

import {buildProductionProps, validateProductionPlan} from "../packages/remotion-video/src/production-contract.js";
import {assertDescendant, readJson, writeJsonAtomic} from "./lib/job.mjs";
import {assertProxyProbeJson, isJpeg, proxyArgs} from "./lib/prepare-media.mjs";
import {assertAudibleVolume, assertQcMetadata, renderArgs} from "./lib/render-qc.mjs";

const execFile = promisify(execFileCallback);
const URL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const JOB_RE = /^[A-Za-z0-9_-]+$/u;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sha256File = async (filePath) => sha256(await readFile(filePath));
const remotionCwd = (root) => path.join(root, "packages/remotion-video");
const remotionCommand = (root) => path.join(root, "node_modules/.bin/remotion");

const localPath = (root, value, label) => {
  if (typeof value !== "string" || value.length === 0 || URL_RE.test(value) || value.startsWith("//")) throw new Error(`${label} must be a local path.`);
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value);
};

const exists = async (filePath) => {
  try { await lstat(filePath); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
};

const regularFile = async (filePath, label) => {
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular non-symlink file: ${filePath}`);
  await access(filePath, fsConstants.R_OK);
  return realpath(filePath);
};

const readableDirectory = async (directoryPath, label) => {
  const info = await lstat(directoryPath);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a local non-symlink directory.`);
  await access(directoryPath, fsConstants.R_OK);
  return realpath(directoryPath);
};

const directory = async (workspaceRoot, directoryPath) => {
  assertDescendant(workspaceRoot, directoryPath, "derived directory");
  let current = workspaceRoot;
  for (const part of path.relative(workspaceRoot, directoryPath).split(path.sep)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe derived directory: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
  assertDescendant(await realpath(workspaceRoot), await realpath(directoryPath), "derived directory");
};

const writeTextAtomic = async (filePath, value) => {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, {encoding: "utf8", flag: "wx"});
  await rename(temporary, filePath);
};

const probeProxy = async (filePath, execFileImpl) => {
  const {stdout} = await execFileImpl("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt,width,height,avg_frame_rate:format=duration", "-of", "json", filePath,
  ], {maxBuffer: 4 * 1024 * 1024});
  return assertProxyProbeJson(stdout);
};

const probeWav = async (filePath, execFileImpl) => {
  const {stdout} = await execFileImpl("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,channels,sample_rate:format=duration", "-of", "json", filePath,
  ], {maxBuffer: 4 * 1024 * 1024});
  const value = JSON.parse(stdout);
  const durationInSeconds = Number(value?.format?.duration ?? value?.streams?.[0]?.duration);
  if (!Number.isFinite(durationInSeconds) || durationInSeconds <= 0 || !value?.streams?.some((stream) => stream.codec_type === "audio")) throw new Error(`Invalid sentence WAV: ${filePath}`);
  return durationInSeconds;
};

const stageFile = async (source, destination, expectedSha256) => {
  if (await exists(destination)) {
    const info = await lstat(destination);
    if (info.isSymbolicLink() || !info.isFile() || await sha256File(destination) !== expectedSha256) throw new Error(`Existing staged file is invalid: ${destination}`);
    return;
  }
  try {
    await link(source, destination);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  }
};

export const parseCli = (argv, {cwd = process.cwd()} = {}) => {
  const workspaceRoot = path.resolve(cwd);
  const options = {
    planPath: null,
    modelDir: path.join(workspaceRoot, "work/indextts25/index-tts/checkpoints"),
    pythonPath: path.join(workspaceRoot, "work/indextts25/index-tts/.venv/bin/python"),
    outDir: path.join(workspaceRoot, "out/production"),
    workspaceRoot,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${flag ?? "option"}.`);
    if (flag === "--plan") options.planPath = localPath(workspaceRoot, value, "--plan");
    else if (flag === "--model-dir") options.modelDir = localPath(workspaceRoot, value, "--model-dir");
    else if (flag === "--python") options.pythonPath = localPath(workspaceRoot, value, "--python");
    else if (flag === "--out-dir") options.outDir = localPath(workspaceRoot, value, "--out-dir");
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!options.planPath) throw new Error("--plan is required.");
  return options;
};

const resolveInputs = async (options) => {
  const workspaceRoot = await realpath(path.resolve(options.workspaceRoot));
  const planPath = await regularFile(localPath(workspaceRoot, options.planPath, "plan"), "plan");
  assertDescendant(workspaceRoot, planPath, "plan");
  const plan = validateProductionPlan(await readJson(planPath));
  if (!JOB_RE.test(plan.id)) throw new Error("plan id must be filename-safe.");
  const catalogPath = await regularFile(localPath(workspaceRoot, plan.catalogPath, "catalogPath"), "catalog");
  assertDescendant(workspaceRoot, catalogPath, "catalog");
  const catalog = await readJson(catalogPath);
  const sourceRoot = await readableDirectory(localPath(workspaceRoot, catalog?.sourceRoot, "catalog sourceRoot"), "catalog sourceRoot");
  const assets = new Map((catalog?.assets ?? []).map((asset) => [asset.id, asset]));
  if (!Array.isArray(catalog?.assets) || assets.size !== catalog.assets.length) throw new Error("Catalog assets must have unique IDs.");
  const selected = new Map();
  for (const sentence of plan.sentences) {
    if (!JOB_RE.test(sentence.shot.sourceId)) throw new Error(`sourceId must be filename-safe: ${sentence.shot.sourceId}`);
    const asset = assets.get(sentence.shot.sourceId);
    if (!asset) throw new Error(`Catalog is missing source ${sentence.shot.sourceId}.`);
    if (!Number.isFinite(Number(asset.durationInSeconds)) || sentence.shot.sourceOutSeconds > Number(asset.durationInSeconds)) throw new Error(`Selected range exceeds catalog source ${asset.id}.`);
    const sourcePath = localPath(workspaceRoot, asset.sourcePath, `source ${asset.id}`);
    const resolvedSource = await regularFile(sourcePath, `source ${asset.id}`);
    assertDescendant(sourceRoot, resolvedSource, `source ${asset.id} under catalog sourceRoot`);
    selected.set(asset.id, {...asset, sourcePath: resolvedSource});
  }
  const voicePath = await regularFile(localPath(workspaceRoot, plan.voice.promptPath, "voice.promptPath"), "voice prompt");
  const pythonPath = await regularFile(await realpath(localPath(workspaceRoot, options.pythonPath, "python")), "IndexTTS Python");
  const modelDir = localPath(workspaceRoot, options.modelDir, "modelDir");
  const modelInfo = await lstat(modelDir);
  if (modelInfo.isSymbolicLink() || !modelInfo.isDirectory()) throw new Error("modelDir must be a local non-symlink directory.");
  await regularFile(path.join(modelDir, "config.yaml"), "model config");
  return {workspaceRoot, planPath, plan, catalogPath, selected, voicePath, pythonPath, modelDir};
};

const pathsFor = (workspaceRoot, outDir, id) => {
  const workDir = path.join(workspaceRoot, "work/production", id);
  const publicDir = path.join(workDir, "public");
  return {
    workspaceRoot, workDir, publicDir,
    proxiesDir: path.join(publicDir, "proxies"),
    audioDir: path.join(publicDir, "audio"),
    designAudioDir: path.join(publicDir, "audio/design"),
    contactsDir: path.join(workDir, "contacts"),
    ttsCacheDir: path.join(workspaceRoot, "work/indextts25/cache"),
    batchPath: path.join(workDir, "sentences.jsonl"),
    ttsManifestPath: path.join(workDir, "tts-manifest.json"),
    propsPath: path.join(workDir, "props.json"),
    manifestPath: path.join(workDir, "manifest.json"),
    pendingManifestPath: path.join(workDir, "manifest.partial.json"),
    outputPath: path.join(outDir, `${id}.mp4`),
    partialOutputPath: path.join(outDir, `${id}.partial.mp4`),
    finalCutContactPath: path.join(workDir, "contacts/final-cut.jpg"),
  };
};

export const runProduction = async (options, {execFileImpl = execFile} = {}) => {
  const input = await resolveInputs(options);
  const originalRoot = path.resolve(options.workspaceRoot);
  const requestedOutDir = localPath(originalRoot, options.outDir, "outDir");
  const outRelative = path.relative(originalRoot, requestedOutDir);
  if (outRelative === "" || outRelative === ".." || outRelative.startsWith(`..${path.sep}`) || path.isAbsolute(outRelative)) throw new Error("outDir must be inside the workspace.");
  const outDir = path.join(input.workspaceRoot, outRelative);
  const paths = pathsFor(input.workspaceRoot, outDir, input.plan.id);
  for (const value of [path.join(input.workspaceRoot, "work"), path.join(input.workspaceRoot, "work/production"), paths.workDir, paths.publicDir, paths.proxiesDir, paths.audioDir, paths.contactsDir, paths.ttsCacheDir, outDir]) await directory(input.workspaceRoot, value);
  if (await exists(paths.outputPath)) throw new Error(`Final output already exists: ${paths.outputPath}`);
  if (await exists(paths.partialOutputPath)) throw new Error(`Partial output already exists: ${paths.partialOutputPath}`);
  if (await exists(paths.manifestPath)) throw new Error(`Production manifest already exists: ${paths.manifestPath}`);
  if (await exists(paths.pendingManifestPath)) throw new Error(`Partial production manifest already exists: ${paths.pendingManifestPath}`);
  if (await exists(paths.finalCutContactPath)) throw new Error(`Final contact sheet already exists: ${paths.finalCutContactPath}`);

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

  const proxies = {};
  for (const [sourceId, asset] of input.selected) {
    const proxyPath = path.join(paths.proxiesDir, `${sourceId}.mp4`);
    if (!(await exists(proxyPath))) {
      const temporary = path.join(paths.proxiesDir, `${sourceId}.${randomUUID()}.partial.mp4`);
      await execFileImpl("ffmpeg", proxyArgs(asset.sourcePath, temporary), {maxBuffer: 16 * 1024 * 1024});
      await probeProxy(temporary, execFileImpl);
      await rename(temporary, proxyPath);
    } else {
      const resolvedProxy = await regularFile(proxyPath, `proxy ${sourceId}`);
      assertDescendant(await realpath(paths.publicDir), resolvedProxy, `proxy ${sourceId}`);
      await probeProxy(resolvedProxy, execFileImpl);
    }
    proxies[sourceId] = {proxyPath: `proxies/${sourceId}.mp4`};
  }

  const jsonl = input.plan.sentences.map((sentence) => JSON.stringify({text: sentence.ttsText, duration_factor: input.plan.voice.durationFactor})).join("\n") + "\n";
  await writeTextAtomic(paths.batchPath, jsonl);
  const worker = path.join(input.workspaceRoot, "scripts/indextts25-batch.py");
  await regularFile(worker, "IndexTTS worker");
  await execFileImpl(input.pythonPath, [
    worker, "--batch-file", paths.batchPath, "--voice", input.voicePath, "--model-dir", input.modelDir,
    "--output-dir", paths.ttsCacheDir, "--expected-count", String(input.plan.sentences.length),
    "--output-prefix", "sentence", "--manifest", paths.ttsManifestPath,
  ], {cwd: input.workspaceRoot, maxBuffer: 32 * 1024 * 1024});
  const ttsManifest = await readJson(paths.ttsManifestPath);
  const voiceSha256 = await sha256File(input.voicePath);
  if (ttsManifest?.engine !== "IndexTTS-2.5" || ttsManifest?.engineVersion !== "v2.5.0" || ttsManifest?.voiceSha256 !== voiceSha256 || ttsManifest?.items?.length !== input.plan.sentences.length) throw new Error("IndexTTS manifest does not match the production plan.");
  const realCache = await realpath(paths.ttsCacheDir);
  const audio = {};
  for (const [index, sentence] of input.plan.sentences.entries()) {
    const item = ttsManifest.items[index];
    if (item.line !== index + 1 || item.text !== sentence.ttsText.trim()) throw new Error(`IndexTTS manifest mapping failed for ${sentence.id}.`);
    if (!/^[a-f0-9]{64}$/u.test(item.contentKey) || !/^[a-f0-9]{64}$/u.test(item.sha256)) throw new Error(`IndexTTS manifest hashes are invalid for ${sentence.id}.`);
    const outputPath = await regularFile(localPath(input.workspaceRoot, item.outputPath, `WAV ${sentence.id}`), `WAV ${sentence.id}`);
    assertDescendant(realCache, outputPath, `WAV ${sentence.id}`);
    const wavSha256 = await sha256File(outputPath);
    if (wavSha256 !== item.sha256) throw new Error(`IndexTTS WAV hash mismatch for ${sentence.id}.`);
    const stagedPath = path.join(paths.audioDir, `${item.contentKey}.wav`);
    await stageFile(outputPath, stagedPath, wavSha256);
    audio[sentence.id] = {wavPath: `audio/${item.contentKey}.wav`, durationInSeconds: await probeWav(stagedPath, execFileImpl), sha256: wavSha256};
  }

  const props = buildProductionProps({plan: input.plan, audio, proxies});
  await writeJsonAtomic(paths.propsPath, props);
  const remotion = await regularFile(await realpath(remotionCommand(input.workspaceRoot)), "Remotion CLI");
  await execFileImpl(remotion, ["compositions", "src/index.ts", "--props", paths.propsPath, "--public-dir", paths.publicDir], {cwd: remotionCwd(input.workspaceRoot), maxBuffer: 16 * 1024 * 1024});
  const propsSha256 = await sha256File(paths.propsPath);
  const args = renderArgs(paths, "ProductMarketingProduction");
  await execFileImpl(remotion, args, {cwd: remotionCwd(input.workspaceRoot), maxBuffer: 32 * 1024 * 1024});
  const partial = await lstat(paths.partialOutputPath);
  if (partial.isSymbolicLink() || !partial.isFile() || partial.size === 0) throw new Error("Remotion produced an empty or unsafe partial output.");
  if (await sha256File(paths.propsPath) !== propsSha256) throw new Error("Props changed while Remotion was rendering.");

  const {stdout: probeOutput} = await execFileImpl("ffprobe", [
    "-v", "error", "-count_frames", "-show_entries", "stream=index,codec_type,codec_name,channels,width,height,pix_fmt,avg_frame_rate,nb_read_frames:format=duration,size", "-of", "json", paths.partialOutputPath,
  ], {maxBuffer: 8 * 1024 * 1024});
  const qc = assertQcMetadata(probeOutput, props);
  const volume = await execFileImpl("ffmpeg", ["-nostdin", "-hide_banner", "-i", paths.partialOutputPath, "-af", "volumedetect", "-f", "null", "-"], {maxBuffer: 16 * 1024 * 1024});
  qc.maxVolumeDb = assertAudibleVolume(volume.stderr);
  await execFileImpl("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-i", paths.partialOutputPath, "-f", "null", "-"], {maxBuffer: 16 * 1024 * 1024});

  if (!(await isJpeg(paths.finalCutContactPath))) {
    const temporary = path.join(paths.contactsDir, `final-cut.${randomUUID()}.partial.jpg`);
    const samples = [{frame: 0, label: "START"}, ...props.sentences.slice(1).map((sentence) => ({frame: sentence.startFrame + 1, label: `CUT · ${sentence.id}`})), {frame: props.durationInFrames - 1, label: "END"}];
    await execFileImpl(remotion, ["still", "src/index.ts", "MediaContactSheet", temporary, "--props", JSON.stringify({mediaPath: path.basename(paths.partialOutputPath), samples}), "--public-dir", outDir, "--image-format", "jpeg", "--jpeg-quality", "90", "--overwrite=false"], {cwd: remotionCwd(input.workspaceRoot), maxBuffer: 16 * 1024 * 1024});
    if (!(await isJpeg(temporary))) throw new Error("Remotion produced an invalid final-cut contact sheet.");
    await rename(temporary, paths.finalCutContactPath);
  }
  const outputSha256 = await sha256File(paths.partialOutputPath);
  const manifest = {
    schemaVersion: 1, id: input.plan.id, title: input.plan.title, sourceText: input.plan.sourceText,
    planPath: input.planPath, catalogPath: input.catalogPath,
    tts: {engine: ttsManifest.engine, engineVersion: ttsManifest.engineVersion, modelDir: input.modelDir, voicePath: input.voicePath, voiceSha256, durationFactor: input.plan.voice.durationFactor},
    remotion: {composition: "ProductMarketingProduction", command: [remotion, ...args], propsPath: paths.propsPath, propsSha256},
    designAudio,
    sentences: props.sentences.map((sentence) => ({...sentence, sourcePath: input.selected.get(sentence.shot.sourceId).sourcePath})),
    outputPath: paths.outputPath,
    output: {path: paths.outputPath, sha256: outputSha256, finalCutContactPath: paths.finalCutContactPath, qc},
  };
  await writeJsonAtomic(paths.pendingManifestPath, manifest);
  if (await exists(paths.outputPath)) throw new Error(`Final output appeared during QC: ${paths.outputPath}`);
  await rename(paths.partialOutputPath, paths.outputPath);
  try {
    await rename(paths.pendingManifestPath, paths.manifestPath);
  } catch (error) {
    await rename(paths.outputPath, paths.partialOutputPath);
    throw error;
  }
  return manifest;
};

export const runCli = async (argv = process.argv.slice(2)) => runProduction(parseCli(argv));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((result) => process.stdout.write(`${result.outputPath}\n`)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
