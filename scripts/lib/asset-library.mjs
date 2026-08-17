import {createHash} from "node:crypto";
import {stat} from "node:fs/promises";
import path from "node:path";
import {createSourceId, discover, probeVideo, quickFingerprint} from "./index-assets.mjs";

const DEFAULT_THRESHOLDS = {minimumDurationSeconds: 1, minimumShortEdge: 720, minimumFps: 20};

const errorDetail = (stage, error) => ({stage, message: error?.message ?? String(error)});
const array = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const matches = (value, filter) => array(filter).length === 0 || array(filter).map(String).includes(String(value));
const hasAll = (values, filter) => array(filter).every((item) => values.includes(String(item).toLowerCase()));

export const extractTags = (relativePath) => {
  const values = [];
  const add = (value) => {
    const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
    if (normalized && !values.includes(normalized)) values.push(normalized);
  };
  for (const rawSegment of relativePath.split(/[\\/]/)) {
    const segment = rawSegment.replace(/\.(?:mp4|mov|m4v)$/i, "").trim();
    if (!segment) continue;
    add(segment.replace(/[_,，、-]+/g, " "));
    for (const part of segment.split(/[\s_,，、-]+/)) {
      if (!part) continue;
      add(/^s\d+素材$/i.test(part) ? part.slice(0, -2) : part);
    }
    if (/^产品/.test(segment)) add("产品");
  }
  return values;
};

export const qualityFlagsForMetadata = (record, thresholds = {}) => {
  const limits = {...DEFAULT_THRESHOLDS, ...thresholds};
  const flags = [];
  if (record?.error?.stage === "probe") return ["probe_failed"];
  if (Number(record?.durationInSeconds) < limits.minimumDurationSeconds) flags.push("too_short");
  if (Math.min(Number(record?.width), Number(record?.height)) < limits.minimumShortEdge) flags.push("low_resolution");
  if (!Number.isFinite(Number(record?.fps)) || Number(record?.fps) < limits.minimumFps) flags.push("invalid_fps");
  return flags;
};

const sourceSnapshot = async (sourceRoot) => {
  const relativePaths = await discover(sourceRoot);
  const details = await Promise.all(relativePaths.map(async (relativePath) => stat(path.join(sourceRoot, relativePath))));
  return {
    relativePaths,
    snapshot: {
      count: details.length,
      bytes: details.reduce((total, info) => total + info.size, 0),
      maxMtimeMs: details.reduce((latest, info) => Math.max(latest, info.mtimeMs), 0),
    },
  };
};

const isSameRoot = (value, sourceRoot) => typeof value?.sourceRoot === "string" && path.resolve(value.sourceRoot) === path.resolve(sourceRoot);
const reusableAssets = (value, sourceRoot) => isSameRoot(value, sourceRoot) ? value.assets ?? [] : [];
const isReusable = (record, info) => record && record.sizeBytes === info.size && record.mtimeMs === info.mtimeMs &&
  (record.state !== "failed" || record.error?.stage === "frames") &&
  typeof record.quickFingerprint === "string" && record.quickFingerprint.length > 0;

const duplicateGroup = (sizeBytes, fingerprint) => createHash("sha256")
  .update(`${sizeBytes}\0${fingerprint}`)
  .digest("hex");

const cachedRecord = (record, sourcePath, relativePath) => ({
  ...record,
  sourcePath,
  relativePath,
  tags: extractTags(relativePath),
  contactSheetPath: record.contactSheetPath ?? `contacts/${record.id}.jpg`,
  ctaSheetPath: record.ctaSheetPath ?? `cta/${record.id}.jpg`,
  state: record.error?.stage === "frames" ? "fingerprinted" : record.state,
  error: null,
});

const baseRecord = (relativePath, sourcePath, info) => ({
  id: createSourceId(relativePath, info.size, info.mtimeMs),
  sourcePath,
  relativePath,
  sizeBytes: info.size,
  mtimeMs: info.mtimeMs,
  durationInSeconds: 0,
  width: 0,
  height: 0,
  fps: 0,
  codec: "",
  rotation: 0,
  hasAudio: false,
  quickFingerprint: null,
  tags: extractTags(relativePath),
  duplicateGroup: null,
  qualityFlags: [],
  proxyPath: null,
  contactSheetPath: `contacts/${createSourceId(relativePath, info.size, info.mtimeMs)}.jpg`,
  ctaSheetPath: `cta/${createSourceId(relativePath, info.size, info.mtimeMs)}.jpg`,
  state: "discovered",
  error: null,
});

const finaliseGroups = (assets) => {
  const groups = new Map();
  for (const asset of assets) {
    asset.duplicateGroup = null;
    const priorVisualFlags = (asset.qualityFlags ?? []).filter((flag) => [
      "mostly_black", "frozen_tail", "empty_tail_candidate",
    ].includes(flag));
    asset.qualityFlags = [...new Set([...priorVisualFlags, ...qualityFlagsForMetadata(asset)])];
    if (asset.state === "failed" || !asset.quickFingerprint) continue;
    const key = `${asset.sizeBytes}\0${asset.quickFingerprint}`;
    groups.set(key, [...(groups.get(key) ?? []), asset]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const id = duplicateGroup(group[0].sizeBytes, group[0].quickFingerprint);
    for (const asset of group) {
      asset.duplicateGroup = id;
      asset.qualityFlags.push("duplicate_candidate");
    }
  }
};

export const scanAssetLibrary = async ({
  sourceRoot,
  workDir: _workDir,
  previousCatalog = null,
  checkpoint = null,
  probe = probeVideo,
  fingerprint = quickFingerprint,
  now = () => new Date(),
  onCheckpoint = null,
} = {}) => {
  if (!sourceRoot || !path.isAbsolute(sourceRoot)) throw new Error("sourceRoot must be an absolute path.");
  const before = await sourceSnapshot(sourceRoot);
  if (before.relativePaths.length === 0) throw new Error("sourceRoot contains no supported video files.");
  const cachedByPath = new Map([
    ...reusableAssets(previousCatalog, sourceRoot),
    ...reusableAssets(checkpoint, sourceRoot),
  ].map((asset) => [asset.relativePath, asset]));
  const assets = [];
  let cached = 0;
  let probed = 0;
  let fingerprinted = 0;
  const publishCheckpoint = async () => {
    if (!onCheckpoint) return;
    await onCheckpoint({
      schemaVersion: 1,
      sourceRoot,
      updatedAt: now().toISOString(),
      sourceSnapshots: {before: before.snapshot, after: null},
      assets: assets.map((asset) => ({...asset})),
    });
  };

  for (const relativePath of before.relativePaths) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const info = await stat(sourcePath);
    const old = cachedByPath.get(relativePath);
    if (isReusable(old, info)) {
      cached += 1;
      assets.push(cachedRecord(old, sourcePath, relativePath));
      await publishCheckpoint();
      continue;
    }
    const asset = baseRecord(relativePath, sourcePath, info);
    try {
      Object.assign(asset, await probe(sourcePath));
      asset.state = "probed";
      probed += 1;
    } catch (error) {
      probed += 1;
      asset.state = "failed";
      asset.error = errorDetail("probe", error);
      asset.qualityFlags = qualityFlagsForMetadata(asset);
      assets.push(asset);
      await publishCheckpoint();
      continue;
    }
    try {
      asset.quickFingerprint = await fingerprint(sourcePath, info.size);
      asset.state = "fingerprinted";
      fingerprinted += 1;
    } catch (error) {
      asset.state = "failed";
      asset.error = errorDetail("fingerprint", error);
    }
    asset.qualityFlags = qualityFlagsForMetadata(asset);
    assets.push(asset);
    await publishCheckpoint();
  }

  finaliseGroups(assets);
  const after = await sourceSnapshot(sourceRoot);
  const warnings = JSON.stringify(before.snapshot) === JSON.stringify(after.snapshot) ? [] : ["Source contents changed during scan."];
  const priorPaths = new Set([...reusableAssets(previousCatalog, sourceRoot), ...reusableAssets(checkpoint, sourceRoot)].map((asset) => asset.relativePath));
  const missing = [...priorPaths]
    .filter((relativePath) => !before.relativePaths.includes(relativePath))
    .map((relativePath) => cachedByPath.get(relativePath));
  const scannedAt = now().toISOString();
  const catalog = {schemaVersion: 1, sourceRoot, scannedAt, sourceSnapshot: after.snapshot, assets};
  const nextCheckpoint = {schemaVersion: 1, sourceRoot, updatedAt: scannedAt, sourceSnapshots: {before: before.snapshot, after: after.snapshot}, assets};
  return {
    catalog,
    checkpoint: nextCheckpoint,
    metrics: {discovered: assets.length, cached, probed, fingerprinted, failed: assets.filter((asset) => asset.state === "failed").length},
    missing,
    warnings,
    sourceSnapshots: {before: before.snapshot, after: after.snapshot},
  };
};

export const searchAssets = (catalog, filters = {}) => {
  const tags = array(filters.tag ?? filters.tags).map((value) => String(value).toLowerCase());
  const flags = array(filters.flag ?? filters.flags).map((value) => String(value).toLowerCase());
  const excludedFlags = array(filters.excludeFlag ?? filters.excludeFlags).map((value) => String(value).toLowerCase());
  const keyword = String(filters.keyword ?? filters.query ?? "").toLowerCase();
  const minDuration = filters.minDuration ?? filters.minDurationSeconds;
  const maxDuration = filters.maxDuration ?? filters.maxDurationSeconds;
  return (catalog?.assets ?? []).filter((asset) => {
    const assetTags = (asset.tags ?? []).map((tag) => String(tag).toLowerCase());
    const assetFlags = (asset.qualityFlags ?? []).map((flag) => String(flag).toLowerCase());
    const orientation = Math.abs(Number(asset.rotation)) % 180 === 90
      ? Number(asset.width) > Number(asset.height) ? "portrait" : "landscape"
      : Number(asset.height) > Number(asset.width) ? "portrait" : Number(asset.width) > Number(asset.height) ? "landscape" : "square";
    return (!keyword || `${asset.relativePath} ${assetTags.join(" ")}`.toLowerCase().includes(keyword)) &&
      hasAll(assetTags, tags) && matches(asset.state, filters.state) && hasAll(assetFlags, flags) &&
      excludedFlags.every((flag) => !assetFlags.includes(flag)) && matches(orientation, filters.orientation) &&
      matches(String(asset.codec).toLowerCase(), array(filters.codec).map((value) => String(value).toLowerCase())) &&
      (minDuration == null || Number(asset.durationInSeconds) >= Number(minDuration)) &&
      (maxDuration == null || Number(asset.durationInSeconds) <= Number(maxDuration));
  });
};
