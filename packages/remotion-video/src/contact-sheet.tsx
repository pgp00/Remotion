import type {CalculateMetadataFunction} from "remotion";
import {AbsoluteFill, Img, OffthreadVideo, staticFile} from "remotion";

export interface MediaContactSheetProps extends Record<string, unknown> {
  mediaPath: string;
  samples: Array<{frame: number; label: string}>;
  safeZone?: {left: number; right: number; top: number; bottom: number} | null;
}

const errorsFor = ({mediaPath, samples, safeZone}: MediaContactSheetProps) => {
  const errors: string[] = [];
  if (
    typeof mediaPath !== "string" || mediaPath.length === 0 || mediaPath.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(mediaPath) || mediaPath.includes("\\") || mediaPath.split("/").includes("..")
  ) errors.push("mediaPath must be a non-empty public-dir relative path.");
  if (!Array.isArray(samples) || samples.length === 0 || samples.length > 64) errors.push("samples must contain 1-64 frames.");
  for (const sample of Array.isArray(samples) ? samples : []) {
    if (!Number.isInteger(sample.frame) || sample.frame < 0) errors.push("sample.frame must be a non-negative integer.");
    if (typeof sample.label !== "string" || sample.label.length === 0) errors.push("sample.label must be non-empty.");
  }
  if (safeZone !== null && safeZone !== undefined) {
    if (typeof safeZone !== "object") errors.push("safeZone must be an object or null.");
    else {
      const values = [safeZone.left, safeZone.right, safeZone.top, safeZone.bottom];
      if (!values.every((value) => Number.isFinite(value) && value >= 0)) errors.push("safeZone values must be finite and non-negative.");
      else if (safeZone.left + safeZone.right >= 1080 || safeZone.top + safeZone.bottom >= 1920) errors.push("safeZone must leave a positive video area.");
    }
  }
  return errors;
};

export const calculateContactSheetMetadata: CalculateMetadataFunction<MediaContactSheetProps> = ({props, isRendering}) => {
  const errors = errorsFor(props);
  const sampleCount = Array.isArray(props.samples) ? props.samples.length : 0;
  // Remotion's `compositions --props` applies one props object to every composition.
  // Defer Still-specific validation until an actual Still render.
  const isDefaultProps = props.mediaPath === "" && sampleCount === 0;
  const isForeignCompositionProps = props.mediaPath === undefined && props.samples === undefined;
  if (isRendering && !isDefaultProps && !isForeignCompositionProps && errors.length > 0) throw new Error(errors.join("\n"));
  return {
    width: 1920,
    height: Math.max(540, Math.ceil(Math.max(1, sampleCount) / 4) * 540),
  };
};

export const MediaContactSheet = ({mediaPath, samples, safeZone}: MediaContactSheetProps) => {
  if (samples.length === 0) {
    return <AbsoluteFill style={{backgroundColor: "#111", color: "white", alignItems: "center", justifyContent: "center", fontSize: 42}}>Provide contact-sheet props</AbsoluteFill>;
  }
  return (
    <AbsoluteFill style={{backgroundColor: "#050505", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gridAutoRows: 540, fontFamily: "PingFang SC, sans-serif"}}>
      {samples.map((sample) => (
        <div key={`${sample.frame}-${sample.label}`} style={{position: "relative", overflow: "hidden", border: "4px solid #111"}}>
          <div style={{position: "absolute", top: 0, bottom: 0, left: "50%", aspectRatio: "9 / 16", transform: "translateX(-50%)"}}>
            <OffthreadVideo
              src={staticFile(mediaPath)}
              trimBefore={sample.frame}
              muted
              style={{width: "100%", height: "100%", objectFit: "contain"}}
            />
            {safeZone && <div style={{position: "absolute", inset: 0, pointerEvents: "none"}}>
              <div style={{position: "absolute", left: `${safeZone.left / 10.8}%`, right: `${safeZone.right / 10.8}%`, top: `${safeZone.top / 19.2}%`, bottom: `${safeZone.bottom / 19.2}%`, border: "3px solid #FFD84D", boxShadow: "0 0 0 1px rgba(0,0,0,0.8)"}} />
            </div>}
          </div>
          <div style={{position: "absolute", left: 0, right: 0, bottom: 0, padding: "14px 16px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "rgba(0,0,0,0.78)", color: "white", fontSize: 22, lineHeight: 1.25}}>
            {sample.label}
          </div>
        </div>
      ))}
    </AbsoluteFill>
  );
};

export interface MediaImageContactSheetProps extends Record<string, unknown> {
  images: Array<{path: string; label: string}>;
}

const imageErrorsFor = (images: MediaImageContactSheetProps["images"]) => {
  const errors: string[] = [];
  if (!Array.isArray(images) || images.length === 0 || images.length > 64) errors.push("images must contain 1-64 entries.");
  for (const image of Array.isArray(images) ? images : []) {
    if (typeof image.path !== "string" || image.path.length === 0 || image.path.startsWith("/") || image.path.split("/").includes("..")) errors.push("image.path must be public-dir relative.");
    if (typeof image.label !== "string" || image.label.length === 0) errors.push("image.label must be non-empty.");
  }
  return errors;
};

export const calculateImageContactSheetMetadata: CalculateMetadataFunction<MediaImageContactSheetProps> = ({props, isRendering}) => {
  const images = Array.isArray(props.images) ? props.images : [];
  if (isRendering && images.length > 0) {
    const errors = imageErrorsFor(images);
    if (errors.length > 0) throw new Error(errors.join("\n"));
  }
  return {width: 1920, height: Math.max(540, Math.ceil(Math.max(1, images.length) / 4) * 540)};
};

export const MediaImageContactSheet = ({images}: MediaImageContactSheetProps) => {
  if (!Array.isArray(images) || images.length === 0) {
    return <AbsoluteFill style={{backgroundColor: "#111", color: "white", alignItems: "center", justifyContent: "center", fontSize: 42}}>Provide image contact-sheet props</AbsoluteFill>;
  }
  return (
    <AbsoluteFill style={{backgroundColor: "#050505", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gridAutoRows: 540, fontFamily: "PingFang SC, sans-serif"}}>
      {images.map((image) => (
        <div key={`${image.path}-${image.label}`} style={{position: "relative", overflow: "hidden", border: "4px solid #111"}}>
          <Img src={staticFile(image.path)} style={{width: "100%", height: "100%", objectFit: "contain"}} />
          <div style={{position: "absolute", left: 0, right: 0, bottom: 0, padding: "14px 16px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "rgba(0,0,0,0.78)", color: "white", fontSize: 22, lineHeight: 1.25}}>
            {image.label}
          </div>
        </div>
      ))}
    </AbsoluteFill>
  );
};
