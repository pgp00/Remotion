import {AbsoluteFill, Freeze, interpolate, OffthreadVideo, staticFile, useCurrentFrame} from "remotion";
import type {ProductionProps} from "../production-contract.js";
import {mediaTrimFrames} from "../media-trim";

type Sentence = ProductionProps["sentences"][number];
const ranges = {hook: [1.08, 1.03], proof: [1.1, 1.04], feature: [1.02, 1.08], cta: [1.03, 1]} as const;

export const ShotLayer = ({sentence, fps}: {sentence: Sentence; fps: number}) => {
  const frame = useCurrentFrame();
  const range = sentence.visual ? ranges[sentence.visual.role] : [1, 1];
  const scale = interpolate(frame, [0, Math.max(1, sentence.voiceFrames - 1)], range, {extrapolateLeft: "clamp", extrapolateRight: "clamp"});

  return <AbsoluteFill style={{overflow: "hidden"}}>
    <Freeze frame={0} active={(current) => sentence.visual?.role === "hook" && current < 8}>
      <OffthreadVideo
        src={staticFile(sentence.shot.proxyPath)}
        {...mediaTrimFrames({...sentence.shot, fps})}
        muted
        style={{width: "100%", height: "100%", objectFit: sentence.shot.fit, objectPosition: `${sentence.shot.focusX * 100}% ${sentence.shot.focusY * 100}%`, transform: `scale(${scale})`}}
      />
    </Freeze>
    {sentence.visual && <AbsoluteFill style={{background: sentence.visual.role === "hook" ? "linear-gradient(180deg, rgba(0,0,0,0.46), transparent 48%, rgba(0,0,0,0.18))" : "linear-gradient(180deg, rgba(0,0,0,0.12), transparent 40%)"}} />}
  </AbsoluteFill>;
};
