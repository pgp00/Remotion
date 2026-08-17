import {execFile as execFileCallback} from "node:child_process";
import {randomUUID} from "node:crypto";
import {lstat, open, rename} from "node:fs/promises";
import path from "node:path";
import {promisify} from "node:util";
import {parseFrameRate} from "./index-assets.mjs";

const execFile = promisify(execFileCallback);
const PROXY_FILTER = "scale=w=min(1920\\,iw):h=min(1920\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,format=yuv420p";

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
  "-pix_fmt", "yuv420p", "-color_range", "tv", "-fps_mode", "cfr", "-an",
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
      source.error = error.message ?? String(error);
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
