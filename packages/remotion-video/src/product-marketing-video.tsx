import type {Timeline} from "@auto-video/shared";
import {AbsoluteFill, Sequence} from "remotion";
import {PlaceholderScene} from "./components/placeholder-scene";
import {SubtitleLayer} from "./components/subtitle-layer";

export const ProductMarketingChrome = ({timeline}: {timeline: Timeline}) => (
  <SubtitleLayer cues={timeline.subtitles} brand={timeline.brand} />
);

export const ProductMarketingVideo = ({timeline}: {timeline: Timeline}) => {
  return (
    <AbsoluteFill style={{backgroundColor: "#08100d", overflow: "hidden"}}>
      {timeline.clips.map((clip, index) => (
        <Sequence
          key={clip.id}
          from={clip.startFrame}
          durationInFrames={clip.durationInFrames}
          premountFor={15}
        >
          <PlaceholderScene clip={clip} index={index} brand={timeline.brand} />
        </Sequence>
      ))}
      <ProductMarketingChrome timeline={timeline} />
    </AbsoluteFill>
  );
};
