export const DESIGN_AUDIO_PATHS = Object.freeze({
  bgm: "audio/design/bgm-deep-techno-ambience.mp3",
  impact: "audio/design/hook-impact.wav",
  motor: "audio/design/electric-razor.wav",
  water: "audio/design/water-splash.wav",
  usb: "audio/design/interface-click.wav",
  cta: "audio/design/cta-click.wav",
});

/** @param {number} db */
export const dbToGain = (db) => 10 ** (db / 20);
/** @param {number} frame @param {{startFrame: number, voiceFrames: number}[]} sentences */
export const musicGainAt = (frame, sentences) => {
  const speaking = sentences.some((sentence) => frame >= sentence.startFrame && frame < sentence.startFrame + sentence.voiceFrames);
  return 0.08 * (speaking ? dbToGain(-5) : 1);
};
/** @param {{startFrame: number, visual?: {sfx?: string}}} sentence */
export const sfxStartFrame = (sentence) => {
  if (!sentence.visual?.sfx) return null;
  return sentence.startFrame + (sentence.visual.sfx === "usb" ? 3 : 0);
};
