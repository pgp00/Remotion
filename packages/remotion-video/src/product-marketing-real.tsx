import {demoProduct, validateRenderJob} from "@auto-video/core";
import type {RenderJobProps} from "@auto-video/shared";
import type {CalculateMetadataFunction} from "remotion";
import {AbsoluteFill, OffthreadVideo, Sequence, staticFile} from "remotion";
import {ProductMarketingChrome, ProductMarketingVideo} from "./product-marketing-video";
import {mediaTrimFrames} from "./media-trim";

const assertValid = (props: RenderJobProps) => {
  const result = validateRenderJob(props);
  if (!result.valid) throw new Error(result.errors.join("\n"));
};

export const calculateProductMarketingRealMetadata: CalculateMetadataFunction<RenderJobProps> = ({props, isRendering}) => {
  if (isRendering || props.timeline.productSku !== demoProduct.sku) assertValid(props);
  return {
    width: props.timeline.width,
    height: props.timeline.height,
    fps: props.timeline.fps,
    durationInFrames: props.timeline.durationInFrames,
  };
};

export const ProductMarketingReal = (props: RenderJobProps) => {
  const {timeline, shots} = props;
  if (timeline.productSku === demoProduct.sku) return <ProductMarketingVideo timeline={timeline} />;
  assertValid(props);
  return (
    <AbsoluteFill style={{backgroundColor: "#08100d", overflow: "hidden"}}>
      {timeline.clips.map((clip) => {
        const shot = shots[clip.assetShotId as string];
        if (!shot?.proxyPath) throw new Error(`Clip ${clip.id} has no readable proxy mapping.`);
        const focusX = (clip.focusX ?? 0.5) * 100;
        const focusY = (clip.focusY ?? 0.5) * 100;
        return (
          <Sequence key={clip.id} from={clip.startFrame} durationInFrames={clip.durationInFrames} premountFor={15}>
            <OffthreadVideo
              src={staticFile(shot.proxyPath)}
              {...mediaTrimFrames({sourceInSeconds: clip.sourceInSeconds, sourceOutSeconds: clip.sourceOutSeconds, fps: timeline.fps})}
              muted
              style={{width: "100%", height: "100%", objectFit: clip.fit ?? "cover", objectPosition: `${focusX}% ${focusY}%`}}
            />
          </Sequence>
        );
      })}
      <ProductMarketingChrome timeline={timeline} />
    </AbsoluteFill>
  );
};
