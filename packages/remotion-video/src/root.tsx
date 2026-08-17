import {demoTimeline} from "@auto-video/core";
import {Composition, Still} from "remotion";
import {
  calculateContactSheetMetadata,
  calculateImageContactSheetMetadata,
  MediaContactSheet,
  MediaImageContactSheet,
} from "./contact-sheet";
import {
  calculateProductMarketingRealMetadata,
  ProductMarketingReal,
} from "./product-marketing-real";
import {ProductMarketingVideo} from "./product-marketing-video";

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="ProductMarketingDemo"
        component={ProductMarketingVideo}
        width={demoTimeline.width}
        height={demoTimeline.height}
        fps={demoTimeline.fps}
        durationInFrames={demoTimeline.durationInFrames}
        defaultProps={{timeline: demoTimeline}}
      />
      <Still
        id="MediaContactSheet"
        component={MediaContactSheet}
        defaultProps={{mediaPath: "", samples: []}}
        calculateMetadata={calculateContactSheetMetadata}
      />
      <Still
        id="MediaImageContactSheet"
        component={MediaImageContactSheet}
        defaultProps={{images: []}}
        calculateMetadata={calculateImageContactSheetMetadata}
      />
      <Composition
        id="ProductMarketingReal"
        component={ProductMarketingReal}
        width={demoTimeline.width}
        height={demoTimeline.height}
        fps={demoTimeline.fps}
        durationInFrames={demoTimeline.durationInFrames}
        defaultProps={{timeline: demoTimeline, shots: {}}}
        calculateMetadata={calculateProductMarketingRealMetadata}
      />
    </>
  );
};
