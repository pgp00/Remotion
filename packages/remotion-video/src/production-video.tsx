import {AbsoluteFill, Audio, Freeze, Sequence, staticFile} from "remotion";
import type {ProductionProps} from "./production-contract.js";
import {SubtitleLayer, type BrandTheme, type SubtitleCue} from "./components/subtitle-layer";
import {OverlayLayer} from "./components/overlay-layer";
import {ShotLayer} from "./components/shot-layer";
import {visualTheme} from "./components/visual-theme";
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
    <AbsoluteFill style={{backgroundColor: visualTheme.background, overflow: "hidden"}}>
      {props.sentences.map((sentence) => (
        <Sequence
          key={sentence.id}
          from={sentence.startFrame}
          durationInFrames={sentence.voiceFrames + sentence.pauseFrames}
        >
          <Freeze frame={sentence.voiceFrames - 1} active={(frame) => frame >= sentence.voiceFrames}>
            <ShotLayer sentence={sentence} fps={props.fps} />
          </Freeze>
          <OverlayLayer sentence={sentence} fps={props.fps} />
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
