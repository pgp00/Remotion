import {spring, useCurrentFrame} from "remotion";
import type {ProductionProps} from "../production-contract.js";
import {DOUYIN_SAFE_ZONE} from "../visual-timing.js";
import {visualTheme} from "./visual-theme";

type Sentence = ProductionProps["sentences"][number];
const base = {position: "absolute" as const, fontFamily: visualTheme.fontFamily, color: visualTheme.text, textShadow: "0 4px 18px rgba(0,0,0,0.72)"};
const proofMarkerMargin = 68;

export const OverlayLayer = ({sentence, fps}: {sentence: Sentence; fps: number}) => {
  const frame = useCurrentFrame();
  if (!sentence.visual?.label) return null;
  const enter = spring({frame, fps, durationInFrames: 8, config: {damping: 200}});
  const motion = {opacity: enter, transform: `translateY(${(1 - enter) * 20}px) scale(${0.96 + enter * 0.04})`};
  const emphasis = sentence.visual.emphasis;
  const emphasisIndex = emphasis && sentence.visual.label.includes(emphasis) ? sentence.visual.label.indexOf(emphasis) : -1;
  const label = emphasisIndex === -1 ? sentence.visual.label : <>
    {sentence.visual.label.slice(0, emphasisIndex)}
    <span style={{color: sentence.visual.role === "hook" ? visualTheme.problem : visualTheme.result}}>{emphasis}</span>
    {sentence.visual.label.slice(emphasisIndex + emphasis!.length)}
  </>;

  if (sentence.visual.role === "hook") return <div style={{...base, ...motion, left: 72, right: 200, top: 180, fontSize: 96, fontWeight: 900, lineHeight: 1.05, whiteSpace: "pre-wrap"}}>{label}</div>;
  if (sentence.visual.role === "proof") {
    const markerX = Math.min(1080 - DOUYIN_SAFE_ZONE.right - proofMarkerMargin, Math.max(DOUYIN_SAFE_ZONE.left + proofMarkerMargin, sentence.shot.focusX * 1080));
    const markerY = Math.min(1920 - DOUYIN_SAFE_ZONE.bottom - proofMarkerMargin, Math.max(DOUYIN_SAFE_ZONE.top + proofMarkerMargin, sentence.shot.focusY * 1920));
    const labelTop = Math.min(1220, Math.max(DOUYIN_SAFE_ZONE.top, markerY + 72));
    return <div style={{...motion, position: "absolute", inset: 0}}>
      <div style={{...base, left: markerX - 62, top: markerY - 62, width: 116, height: 116, borderRadius: "50%", border: `4px solid ${visualTheme.result}`, boxShadow: "0 0 0 6px rgba(0,0,0,0.28)"}} />
      <div style={{...base, left: DOUYIN_SAFE_ZONE.left, right: DOUYIN_SAFE_ZONE.right, top: labelTop, maxWidth: 808, whiteSpace: "normal", overflowWrap: "anywhere", boxSizing: "border-box", padding: "8px 14px", borderRadius: 999, background: "rgba(0,0,0,0.68)", fontSize: 38, fontWeight: 800}}>{label}</div>
    </div>;
  }
  if (sentence.visual.role === "feature") return <div style={{...base, ...motion, left: DOUYIN_SAFE_ZONE.left, right: DOUYIN_SAFE_ZONE.right, top: 220, maxWidth: 808, whiteSpace: "normal", overflowWrap: "anywhere", boxSizing: "border-box", padding: "12px 22px", borderRadius: 999, background: "rgba(0,0,0,0.66)", border: "1px solid rgba(255,255,255,0.38)", fontSize: 46, fontWeight: 850}}>{label}</div>;
  return <div style={{...base, ...motion, left: 72, right: 200, bottom: 760, padding: "22px 28px", borderRadius: 24, background: "rgba(215,28,48,0.92)", fontSize: 58, fontWeight: 900, textAlign: "center"}}>{label}</div>;
};
