import type {BrandTheme, SubtitleCue} from "@auto-video/shared";
import {interpolate, useCurrentFrame} from "remotion";

export const SubtitleLayer = ({
  cues,
  brand,
}: {
  cues: SubtitleCue[];
  brand: BrandTheme;
}) => {
  const frame = useCurrentFrame();
  const cue = cues.find((item) => frame >= item.startFrame && frame < item.endFrame);

  if (!cue) {
    return null;
  }

  const opacity = interpolate(
    frame,
    [cue.startFrame, cue.startFrame + 8, cue.endFrame - 8, cue.endFrame],
    [0, 1, 1, 0],
    {extrapolateLeft: "clamp", extrapolateRight: "clamp"},
  );

  return (
    <div
      style={{
        position: "absolute",
        left: 64,
        right: 64,
        bottom: 245,
        display: "flex",
        justifyContent: "center",
        opacity,
        fontFamily: brand.fontFamily,
      }}
    >
      <div
        style={{
          maxWidth: 900,
          padding: "20px 34px 23px",
          borderRadius: 28,
          backgroundColor: "rgba(5, 10, 15, 0.76)",
          color: brand.text,
          fontSize: 48,
          fontWeight: 750,
          lineHeight: 1.35,
          textAlign: "center",
          boxShadow: "0 18px 65px rgba(0,0,0,0.28)",
        }}
      >
        {cue.text}
      </div>
    </div>
  );
};
