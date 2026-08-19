import {Composition, Still} from "remotion";
import {
  calculateContactSheetMetadata,
  calculateImageContactSheetMetadata,
  MediaContactSheet,
  MediaImageContactSheet,
} from "./contact-sheet";
import {calculateProductionMetadata, ProductionVideo, type ProductionProps} from "./production-video";

const productionDefaults = {
  schemaVersion: 1,
  id: "production",
  title: "Production",
  sourceText: "Production",
  width: 1080,
  height: 1920,
  fps: 30,
  durationInFrames: 1,
  sentences: [{
    id: "sentence-01",
    text: "Production",
    ttsText: "Production",
    wavPath: "audio/production.wav",
    wavDurationSeconds: 1 / 30,
    wavSha256: "default",
    startFrame: 0,
    voiceFrames: 1,
    pauseFrames: 0,
    shot: {sourceId: "default", sourceInSeconds: 0, sourceOutSeconds: 1 / 30, fit: "cover", focusX: 0.5, focusY: 0.5, proxyPath: "proxies/production.mp4"},
  }],
} as ProductionProps;

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="ProductMarketingProduction"
        component={ProductionVideo}
        width={productionDefaults.width}
        height={productionDefaults.height}
        fps={productionDefaults.fps}
        durationInFrames={productionDefaults.durationInFrames}
        defaultProps={productionDefaults}
        calculateMetadata={calculateProductionMetadata}
      />
      <Still
        id="MediaContactSheet"
        component={MediaContactSheet}
        defaultProps={{mediaPath: "", samples: [], safeZone: null}}
        calculateMetadata={calculateContactSheetMetadata}
      />
      <Still
        id="MediaImageContactSheet"
        component={MediaImageContactSheet}
        defaultProps={{images: []}}
        calculateMetadata={calculateImageContactSheetMetadata}
      />
    </>
  );
};
