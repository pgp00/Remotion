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
  "--color-space=bt709",
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
