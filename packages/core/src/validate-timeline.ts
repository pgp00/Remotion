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
