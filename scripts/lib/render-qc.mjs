import {parseFrameRate} from "./index-assets.mjs";

export const renderArgs = (paths, compositionId = "ProductMarketingProduction") => [
  "render", "src/index.ts", compositionId, paths.partialOutputPath,
  "--props", paths.propsPath,
  "--public-dir", paths.publicDir,
  "--codec=h264",
  "--pixel-format=yuv420p",
  "--color-space=bt709",
  "--audio-codec=aac",
  "--enforce-audio-track",
  "--overwrite=false",
];

export const forceMonoAac = ({type, args}) => {
  if (type !== "stitcher") return args;
  const audioCopy = args.findIndex((arg, index) => arg === "copy" && args[index - 1] === "-c:a");
  return audioCopy === -1 ? args : [...args.slice(0, audioCopy), "aac", "-ac", "1", ...args.slice(audioCopy + 1)];
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
  if (Number(audio.channels) !== 1) throw new Error("QC requires mono AAC audio.");
  const frameCount = Number(video.nb_read_frames);
  if (!Number.isInteger(frameCount) || frameCount !== timeline.durationInFrames) throw new Error(`QC frame count ${frameCount} does not match Timeline ${timeline.durationInFrames}.`);
  const durationInSeconds = frameCount / fps;
  const containerDurationInSeconds = Number(value?.format?.duration);
  if (
    !Number.isFinite(containerDurationInSeconds) || containerDurationInSeconds <= 0 ||
    Math.abs(containerDurationInSeconds - durationInSeconds) > 0.25
  ) throw new Error("QC container duration must match the video within AAC padding tolerance.");
  const sizeBytes = Number(value?.format?.size);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) throw new Error("QC output must be non-empty.");
  return {videoCodec: video.codec_name, pixelFormat: video.pix_fmt, width: 1080, height: 1920, fps, audioCodec: audio.codec_name, frameCount, durationInSeconds, containerDurationInSeconds, sizeBytes};
};

export const assertAudibleVolume = (stderr) => {
  const match = String(stderr).match(/max_volume:\s*(-?inf|-?\d+(?:\.\d+)?)\s*dB/iu);
  if (!match || match[1].toLowerCase() === "-inf" || Number(match[1]) <= -60) {
    throw new Error("QC requires a non-silent voice track.");
  }
  return Number(match[1]);
};

const volumeValue = (stderr, key) => {
  const match = String(stderr).match(new RegExp(`${key}:\\s*(-?inf|-?\\d+(?:\\.\\d+)?)\\s*dB`, "iu"));
  if (!match || match[1].toLowerCase() === "-inf") throw new Error(`QC requires finite ${key}.`);
  return Number(match[1]);
};

export const analyzeVolume = (stderr) => ({
  meanVolumeDb: volumeValue(stderr, "mean_volume"),
  maxVolumeDb: volumeValue(stderr, "max_volume"),
});

export const assertMixHeadroom = ({maxVolumeDb}) => {
  if (maxVolumeDb > -1) throw new Error(`Enhanced mix requires at least 1 dB headroom; max_volume was ${maxVolumeDb} dB.`);
};

export const assertSystemFont = (input, family) => {
  const value = typeof input === "string" ? JSON.parse(input) : input;
  const found = Array.isArray(value?.SPFontsDataType) && value.SPFontsDataType.some((font) =>
    font?.enabled === "yes" && Array.isArray(font.typefaces) && font.typefaces.some((face) =>
      face?.family === family && face.enabled === "yes" && face.valid === "yes",
    ),
  );
  if (!found) throw new Error(`Required enabled system font is unavailable: ${family}`);
  return family;
};
