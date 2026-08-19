import {Audio, Sequence, staticFile} from "remotion";
import type {ProductionProps} from "../production-contract.js";
import {DESIGN_AUDIO_PATHS, musicGainAt, sfxStartFrame} from "../audio-design.js";

const sfxVolume = {impact: 0.2, motor: 0.18, water: 0.2, usb: 0.22, cta: 0.22} as const;

export const SoundBed = ({sentences, durationInFrames}: Pick<ProductionProps, "sentences" | "durationInFrames">) => <>
  <Audio src={staticFile(DESIGN_AUDIO_PATHS.bgm)} trimAfter={durationInFrames} volume={(frame) => musicGainAt(frame, sentences)} />
  {sentences.flatMap((sentence) => {
    const key = sentence.visual?.sfx;
    const from = sfxStartFrame(sentence);
    if (!key || from === null) return [];
    const duration = Math.max(1, sentence.voiceFrames - (from - sentence.startFrame));
    return [<Sequence key={`${sentence.id}-${key}`} from={from} durationInFrames={duration}>
      <Audio src={staticFile(DESIGN_AUDIO_PATHS[key])} trimAfter={duration} volume={sfxVolume[key]} />
    </Sequence>];
  })}
</>;
