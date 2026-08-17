import {execFile as execFileCallback} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdir, lstat, open, rename, rm} from "node:fs/promises";
import path from "node:path";
import {promisify} from "node:util";

const execFile = promisify(execFileCallback);

export const VISUAL_THRESHOLDS = Object.freeze({
  blackLuma: 20,
  frozenFrameDifference: 2,
  tailLumaChange: 50,
  tailFrameDifference: 40,
});

const formatTimecode = (seconds) => {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const secs = Math.floor((milliseconds % 60000) / 1000);
  return [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":") + `.${String(milliseconds % 1000).padStart(3, "0")}`;
};

const samplesAt = (seconds) => seconds.map((value) => {
  const rounded = Math.round(value * 1000) / 1000;
  return {seconds: rounded, timecode: formatTimecode(rounded)};
});

export const sourceContactSamples = (durationInSeconds) => {
  if (!Number.isFinite(durationInSeconds) || durationInSeconds <= 0) throw new Error("durationInSeconds must be positive.");
  if (durationInSeconds <= 8) return samplesAt([durationInSeconds / 2]);
  if (durationInSeconds <= 30) return samplesAt([0.2, 0.5, 0.8].map((ratio) => durationInSeconds * ratio));
  const lastSafeSecond = Math.max(0, durationInSeconds - 0.25);
  return samplesAt(Array.from({length: Math.min(8, Math.floor(durationInSeconds / 10) + 1)}, (_, index) => Math.min(index * 10, lastSafeSecond)));
};

export const ctaSamples = (durationInSeconds) => {
  if (!Number.isFinite(durationInSeconds) || durationInSeconds <= 0) throw new Error("durationInSeconds must be positive.");
  return durationInSeconds < 4
    ? samplesAt([0.1, 0.4, 0.7, 0.95].map((ratio) => durationInSeconds * ratio))
    : samplesAt([4, 3, 2, 0.25].map((offset) => Math.max(0, durationInSeconds - offset)));
};

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

const thumbnailFilter = "scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2:black";
const execOptions = {maxBuffer: 16 * 1024 * 1024};

const sheetArgs = ({sourcePath, seconds, outputPath}) => [
  "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
  "-ss", seconds.toFixed(3), "-i", sourcePath,
  "-map", "0:v:0", "-frames:v", "1", "-vf", thumbnailFilter,
  "-q:v", "3", outputPath,
];

const gridLayout = (count) => Array.from({length: count}, (_, index) => `${(index % 4) * 480}_${Math.floor(index / 4) * 270}`).join("|");

const escapeDrawtext = (value) => String(value)
  .replace(/\\/g, "\\\\")
  .replace(/'/g, "\\'")
  .replace(/[:;,=%\[\]]/g, "\\$&")
  .replace(/[\r\n]+/g, " ");

const composeArgs = ({framePaths, labels, outputPath, comment}) => [
  "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
  ...framePaths.flatMap((framePath) => ["-i", framePath]),
  "-filter_complex",
  `${framePaths.map((_, index) => `[${index}:v]drawtext=fontcolor=white:fontsize=20:box=1:boxcolor=black@0.70:boxborderw=8:x=12:y=h-th-12:text='${escapeDrawtext(labels[index] ?? "")}'[v${index}]`).join(";")};${framePaths.map((_, index) => `[v${index}]`).join("")}xstack=inputs=${framePaths.length}:layout=${gridLayout(framePaths.length)}:fill=black[out]`,
  "-map", "[out]",
  "-frames:v", "1", "-q:v", "3", "-metadata", `comment=${comment}`, outputPath,
];

const renderWithRemotion = async ({framePaths, labels, outputPath, stagingDir, workspaceRoot, execFileImpl}) => {
  const publicDir = path.dirname(stagingDir);
  const imageProps = framePaths.map((framePath, index) => ({
    path: path.relative(publicDir, framePath).split(path.sep).join("/"),
    label: labels[index] ?? "",
  }));
  const remotionCommand = path.join(workspaceRoot, "node_modules", ".bin", "remotion");
  const remotionCwd = path.join(workspaceRoot, "packages", "remotion-video");
  await execFileImpl(remotionCommand, [
    "still", "src/index.ts", "MediaImageContactSheet", outputPath,
    "--props", JSON.stringify({images: imageProps}),
    "--public-dir", publicDir,
    "--image-format", "jpeg", "--jpeg-quality", "90", "--overwrite=true",
  ], {cwd: remotionCwd, maxBuffer: 16 * 1024 * 1024});
};

export const renderSourceSheet = async ({sourcePath, relativePath, samples, outputPath, stagingDir, workspaceRoot = process.cwd(), execFileImpl = execFile}) => {
  if (typeof sourcePath !== "string" || sourcePath.length === 0) throw new Error("sourcePath must be non-empty.");
  if (typeof relativePath !== "string" || relativePath.length === 0) throw new Error("relativePath must be non-empty.");
  if (!Array.isArray(samples) || samples.length === 0 || samples.some(({seconds}) => !Number.isFinite(seconds) || seconds < 0)) throw new Error("samples must contain non-negative seconds.");
  if (await isJpeg(outputPath)) return outputPath;

  await Promise.all([mkdir(stagingDir, {recursive: true}), mkdir(path.dirname(outputPath), {recursive: true})]);
  const batchDir = path.join(stagingDir, randomUUID());
  await mkdir(batchDir);
  const framePaths = samples.map((_, index) => path.join(batchDir, `${String(index).padStart(2, "0")}.jpg`));
  try {
    for (let index = 0; index < samples.length; index += 1) {
      await execFileImpl("ffmpeg", sheetArgs({sourcePath, seconds: samples[index].seconds, outputPath: framePaths[index]}), execOptions);
      if (!(await isJpeg(framePaths[index]))) throw new Error(`ffmpeg produced an invalid frame for ${relativePath}.`);
    }
    const extension = path.extname(outputPath) || ".jpg";
    const partial = path.join(path.dirname(outputPath), `${path.basename(outputPath, extension)}.${randomUUID()}.partial${extension}`);
    const labels = samples.map(({timecode}) => `${relativePath} | ${timecode}`);
    const compose = composeArgs({
      framePaths,
      labels,
      outputPath: partial,
      comment: `${relativePath}\n${samples.map(({timecode}) => timecode).join(", ")}`,
    });
    try {
      await execFileImpl("ffmpeg", compose, execOptions);
    } catch (error) {
      const message = String(error?.stderr ?? error?.message ?? error);
      if (!/drawtext|No such filter/i.test(message)) throw error;
      await renderWithRemotion({framePaths, labels, outputPath: partial, stagingDir, workspaceRoot, execFileImpl});
    }
    if (!(await isJpeg(partial))) throw new Error(`ffmpeg produced an invalid contact sheet for ${relativePath}.`);
    await rename(partial, outputPath);
    return outputPath;
  } finally {
    await rm(batchDir, {recursive: true, force: true});
  }
};

const grayscalePixels = async ({sourcePath, seconds, execFileImpl}) => {
  const {stdout = Buffer.alloc(0)} = await execFileImpl("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "info", "-ss", seconds.toFixed(3), "-i", sourcePath,
    "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=32:18:flags=area,format=gray", "-f", "rawvideo", "pipe:1",
  ], {...execOptions, encoding: "buffer"});
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
};

export const grayscaleStatsFromFfmpeg = async ({sourcePath, samples, execFileImpl = execFile}) => {
  const stats = [];
  let prior = null;
  for (const {seconds} of samples) {
    const pixels = await grayscalePixels({sourcePath, seconds, execFileImpl});
    const meanLuma = pixels.length === 0 ? null : pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
    const frameDifference = !prior || prior.length !== pixels.length || pixels.length === 0
      ? null
      : pixels.reduce((sum, value, index) => sum + Math.abs(value - prior[index]), 0) / pixels.length;
    stats.push({meanLuma, frameDifference});
    prior = pixels;
  }
  return stats;
};

export const qualityFlagsForFrameStats = ({contact = [], cta = []}, thresholds = VISUAL_THRESHOLDS) => {
  const flags = [];
  const luma = (stat) => Number(stat?.meanLuma);
  const difference = (stat) => Number(stat?.frameDifference);
  if (contact.length > 0 && contact.filter((stat) => Number.isFinite(luma(stat)) && luma(stat) < thresholds.blackLuma).length > contact.length / 2) flags.push("mostly_black");
  const tailDifferences = cta.map(difference).filter(Number.isFinite);
  if (tailDifferences.length >= 3 && tailDifferences.every((value) => value <= thresholds.frozenFrameDifference)) flags.push("frozen_tail");
  const prior = cta.at(-2);
  const last = cta.at(-1);
  if (
    (Number.isFinite(luma(prior)) && Number.isFinite(luma(last)) && Math.abs(luma(prior) - luma(last)) >= thresholds.tailLumaChange) ||
    tailDifferences.some((value) => value >= thresholds.tailFrameDifference)
  ) flags.push("empty_tail_candidate");
  return flags;
};

export const renderAssetSheets = async ({record, paths, execFileImpl = execFile, grayscaleStatsImpl = grayscaleStatsFromFfmpeg}) => {
  if (!record?.id || !record.sourcePath || !record.relativePath || !Number.isFinite(record.durationInSeconds) || record.durationInSeconds <= 0) throw new Error("record requires id, sourcePath, relativePath, and positive durationInSeconds.");
  if (path.basename(record.id) !== record.id || !/^[A-Za-z0-9_-]+$/.test(record.id)) throw new Error("record.id must be a safe filename.");
  if (!paths?.workDir) throw new Error("paths.workDir is required.");
  const contactsDir = paths.contactsDir ?? path.join(paths.workDir, "contacts");
  const ctaDir = paths.ctaDir ?? path.join(paths.workDir, "cta");
  const stagingDir = paths.stagingDir ?? path.join(paths.workDir, ".staging");
  const contactSheetPath = `contacts/${record.id}.jpg`;
  const ctaSheetPath = `cta/${record.id}.jpg`;
  const contactOutput = path.join(contactsDir, `${record.id}.jpg`);
  const ctaOutput = path.join(ctaDir, `${record.id}.jpg`);
  const contactSamples = sourceContactSamples(record.durationInSeconds);
  const tailSamples = ctaSamples(record.durationInSeconds);
  const [contactReady, ctaReady] = await Promise.all([isJpeg(contactOutput), isJpeg(ctaOutput)]);
  const workspaceRoot = paths.workspaceRoot ?? process.cwd();
  await renderSourceSheet({sourcePath: record.sourcePath, relativePath: record.relativePath, samples: contactSamples, outputPath: contactOutput, stagingDir, workspaceRoot, execFileImpl});
  await renderSourceSheet({sourcePath: record.sourcePath, relativePath: record.relativePath, samples: tailSamples, outputPath: ctaOutput, stagingDir, workspaceRoot, execFileImpl});
  const qualityFlags = new Set((record.qualityFlags ?? []).filter((flag) => ["mostly_black", "frozen_tail", "empty_tail_candidate"].includes(flag)));
  if (!contactReady) {
    qualityFlags.delete("mostly_black");
    for (const flag of qualityFlagsForFrameStats({contact: await grayscaleStatsImpl({sourcePath: record.sourcePath, samples: contactSamples, execFileImpl})})) qualityFlags.add(flag);
  }
  if (!ctaReady) {
    qualityFlags.delete("frozen_tail");
    qualityFlags.delete("empty_tail_candidate");
    for (const flag of qualityFlagsForFrameStats({cta: await grayscaleStatsImpl({sourcePath: record.sourcePath, samples: tailSamples, execFileImpl})})) qualityFlags.add(flag);
  }
  return {contactSheetPath, ctaSheetPath, qualityFlags: [...qualityFlags]};
};
