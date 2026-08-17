export type CapabilityState = "ready" | "not_configured" | "unavailable";

export type DraftStatus = "draft" | "needs_review" | "approved" | "rendered";

export interface Product {
  sku: string;
  name: string;
  sellingPoints: string[];
  aliases: string[];
  referenceImages: string[];
}

export interface AssetShot {
  id: string;
  sourceId: string;
  sourcePath: string;
  proxyPath?: string;
  sourceInSeconds: number;
  sourceOutSeconds: number;
  productSkus: string[];
  tags: string[];
  qualityScore: number;
  confidence: number;
  reviewState: "unreviewed" | "confirmed" | "rejected";
}

export interface AssetSource {
  id: string;
  sourcePath: string;
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
  durationInSeconds: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  rotation: number;
  hasAudio: boolean;
  quickFingerprint: string | null;
  proxyPath: string | null;
  contactSheetPath: string | null;
  status: "indexed" | "prepared" | "skipped" | "failed";
  error: string | null;
}

export interface AssetIndex {
  schemaVersion: 1;
  sourceRoot: string;
  scannedAt: string;
  sources: AssetSource[];
  shots: AssetShot[];
}

export interface RenderJobProps extends Record<string, unknown> {
  timeline: Timeline;
  shots: Record<string, AssetShot>;
}

export interface SubtitleCue {
  id: string;
  startFrame: number;
  endFrame: number;
  text: string;
}

export interface AudioTrack {
  id: string;
  kind: "voiceover" | "music";
  source: string | null;
  volume: number;
  state: CapabilityState;
}

export interface TimelineClip {
  id: string;
  assetShotId: string | null;
  startFrame: number;
  durationInFrames: number;
  sourceInSeconds: number;
  sourceOutSeconds: number;
  label: string;
  sellingPoint: string;
  fit?: "cover" | "contain";
  focusX?: number;
  focusY?: number;
  placeholder: {
    from: string;
    to: string;
  };
}

export interface BrandTheme {
  name: string;
  primary: string;
  accent: string;
  text: string;
  mutedText: string;
  fontFamily: string;
}

export interface Timeline {
  schemaVersion: 1;
  id: string;
  title: string;
  productSku: string;
  status: DraftStatus;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  brand: BrandTheme;
  clips: TimelineClip[];
  subtitles: SubtitleCue[];
  voiceover: AudioTrack;
  music: AudioTrack;
  cta: string;
}

export interface EditProject {
  id: string;
  product: Product;
  scriptPath: string;
  variants: Timeline[];
  status: DraftStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityDescriptor {
  id: "nas" | "catalog" | "asset-index" | "tts" | "music" | "render-queue";
  label: string;
  state: CapabilityState;
  detail: string;
}
