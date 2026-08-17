import type {BrandTheme, TimelineClip} from "@auto-video/shared";
import {interpolate, spring, useCurrentFrame, useVideoConfig} from "remotion";

export const PlaceholderScene = ({
  clip,
  index,
  brand,
}: {
  clip: TimelineClip;
  index: number;
  brand: BrandTheme;
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const entrance = spring({
    frame,
    fps,
    config: {damping: 18, mass: 0.8, stiffness: 120},
  });
  const fade = interpolate(
    frame,
    [0, 10, clip.durationInFrames - 12, clip.durationInFrames],
    [0, 1, 1, 0],
    {extrapolateLeft: "clamp", extrapolateRight: "clamp"},
  );
  const scale = interpolate(frame, [0, clip.durationInFrames], [1.08, 1.01], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        inset: -20,
        opacity: fade,
        transform: `scale(${scale})`,
        background: `radial-gradient(circle at 72% 22%, rgba(255,255,255,0.18), transparent 28%), linear-gradient(155deg, ${clip.placeholder.from}, ${clip.placeholder.to})`,
        color: brand.text,
        fontFamily: brand.fontFamily,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          width: 630,
          height: 630,
          borderRadius: 999,
          right: -145,
          top: 265,
          border: "2px solid rgba(255,255,255,0.18)",
          boxShadow: "inset 0 0 0 80px rgba(255,255,255,0.025)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 72,
          top: 460,
          right: 72,
          transform: `translateY(${(1 - entrance) * 80}px)`,
        }}
      >
        <div
          style={{
            color: brand.primary,
            fontSize: 24,
            fontWeight: 800,
            letterSpacing: 5,
            marginBottom: 28,
          }}
        >
          SHOT {String(index + 1).padStart(2, "0")} · PLACEHOLDER
        </div>
        <div style={{fontSize: 92, fontWeight: 850, lineHeight: 1.08, maxWidth: 860}}>
          {clip.label}
        </div>
        <div
          style={{
            marginTop: 34,
            display: "inline-flex",
            padding: "14px 24px 16px",
            borderRadius: 999,
            backgroundColor: "rgba(255,255,255,0.12)",
            border: "1px solid rgba(255,255,255,0.22)",
            fontSize: 31,
            color: brand.text,
          }}
        >
          {clip.sellingPoint}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 72,
          right: 72,
          bottom: 115,
          height: 2,
          backgroundColor: "rgba(255,255,255,0.2)",
        }}
      >
        <div
          style={{
            width: `${((frame + 1) / clip.durationInFrames) * 100}%`,
            height: "100%",
            backgroundColor: brand.primary,
          }}
        />
      </div>
    </div>
  );
};
