import {AbsoluteFill, Audio, Freeze, OffthreadVideo, Sequence, staticFile} from "remotion";
import type {ProductionProps} from "./production-contract.js";
import {SubtitleLayer, type BrandTheme, type SubtitleCue} from "./components/subtitle-layer";
import {mediaTrimFrames} from "./media-trim";
import {validateProductionProps} from "./production-contract.js";
import {captionCuesForSentence} from "./visual-timing.js";

export type {ProductionProps} from "./production-contract.js";

const brand: BrandTheme = {
  primary: "#08100d",
  text: "#ffffff",
  fontFamily: "Arial, sans-serif",
};

export const ProductionVideo = (props: ProductionProps) => {
  const cues: SubtitleCue[] = props.sentences.flatMap(captionCuesForSentence);

  return (
    <AbsoluteFill style={{backgroundColor: brand.primary, overflow: "hidden"}}>
      {props.sentences.map((sentence) => (
        <Sequence
          key={sentence.id}
          from={sentence.startFrame}
          durationInFrames={sentence.voiceFrames + sentence.pauseFrames}
        >
          <Freeze frame={sentence.voiceFrames - 1} active={(frame) => frame >= sentence.voiceFrames}>
            <OffthreadVideo
              src={staticFile(sentence.shot.proxyPath)}
              {...mediaTrimFrames({...sentence.shot, fps: props.fps})}
              muted
              style={{
                width: "100%",
                height: "100%",
                objectFit: sentence.shot.fit,
                objectPosition: `${sentence.shot.focusX * 100}% ${sentence.shot.focusY * 100}%`,
              }}
            />
          </Freeze>
          <Audio src={staticFile(sentence.wavPath)} trimAfter={sentence.voiceFrames} />
        </Sequence>
      ))}
      <SubtitleLayer cues={cues} brand={brand} />
    </AbsoluteFill>
  );
};

export const calculateProductionMetadata = ({props}: {props: ProductionProps}) => {
  const validated = validateProductionProps(props);
  return {
    width: validated.width,
    height: validated.height,
    fps: validated.fps,
    durationInFrames: validated.durationInFrames,
  };
};
