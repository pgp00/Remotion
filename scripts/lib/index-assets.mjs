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

export const discover = async (sourceRoot) => {
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
        status: "failed", error: error.message ?? String(error),
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
