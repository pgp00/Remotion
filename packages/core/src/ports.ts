import type {AssetShot, CapabilityState, Product, Timeline} from "@auto-video/shared";

export class CapabilityNotConfiguredError extends Error {
  public readonly state: CapabilityState = "not_configured";

  constructor(public readonly capability: string, message: string) {
    super(message);
    this.name = "CapabilityNotConfiguredError";
  }
}

export interface AssetSearchInput {
  product: Product;
  sellingPoint: string;
  limit: number;
}

export interface AssetSearchPort {
  search(input: AssetSearchInput): Promise<AssetShot[]>;
}

export interface TtsResult {
  audioPath: string;
  durationInSeconds: number;
}

export interface TtsPort {
  synthesize(text: string): Promise<TtsResult>;
}

export interface TimelineRepository {
  save(timeline: Timeline): Promise<void>;
  get(id: string): Promise<Timeline | null>;
}

export const unconfiguredAssetSearch: AssetSearchPort = {
  async search() {
    throw new CapabilityNotConfiguredError(
      "asset-index",
      "素材索引尚未配置。请先完成 NAS 扫描和镜头分析。",
    );
  },
};

export const unconfiguredTts: TtsPort = {
  async synthesize() {
    throw new CapabilityNotConfiguredError(
      "tts",
      "云端 TTS 尚未配置。请提供服务商和 API 凭证。",
    );
  },
};
