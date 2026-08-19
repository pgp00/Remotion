import {useCurrentFrame} from "remotion";
import {subtitleOpacityAt} from "../production-contract.js";

export type SubtitleCue = {
  id: string;
  text: string;
  startFrame: number;
  endFrame: number;
  legacy: boolean;
  role: "hook" | "proof" | "feature" | "cta" | null;
  emphasis: string | null;
};

export type BrandTheme = {
  primary: string;
  text: string;
  fontFamily: string;
};

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

  const opacity = subtitleOpacityAt(frame, cue.startFrame, cue.endFrame);

  if (cue.legacy) {
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
  }

  const emphasisIndex = cue.emphasis ? cue.text.indexOf(cue.emphasis) : -1;
  const accent = cue.role === "hook" ? "#FFD84D" : "#57E389";
  const content = emphasisIndex === -1 ? cue.text : <>
    {cue.text.slice(0, emphasisIndex)}
    <span style={{color: accent, display: "inline-block", transform: `scale(${1 + 0.06 * opacity})`}}>{cue.emphasis}</span>
    {cue.text.slice(emphasisIndex + cue.emphasis!.length)}
  </>;

  return (
    <div
      style={{
        position: "absolute",
        left: 72,
        right: 200,
        bottom: 530,
        display: "flex",
        justifyContent: "center",
        opacity,
        fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif',
      }}
    >
      <div
        style={{
          maxWidth: 808,
          padding: "14px 22px 16px",
          borderRadius: 18,
          background: "linear-gradient(90deg, rgba(0,0,0,0.72), rgba(0,0,0,0.28))",
          color: brand.text,
          fontSize: 60,
          fontWeight: 800,
          lineHeight: 1.18,
          textAlign: "center",
          textShadow: "0 3px 14px rgba(0,0,0,0.65)",
        }}
      >
        {content}
      </div>
    </div>
  );
};
