import assert from "node:assert/strict";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertProxyProbeJson,
  contactSheetSamples,
  prepareMedia,
  proxyArgs,
} from "./prepare-media.mjs";

test("contactSheetSamples follows the approved duration bands", () => {
  assert.deepEqual(contactSheetSamples(8), [{frame: 120, timecode: "00:00:04.000"}]);
  assert.deepEqual(contactSheetSamples(9), [
    {frame: 54, timecode: "00:00:01.800"},
    {frame: 135, timecode: "00:00:04.500"},
    {frame: 216, timecode: "00:00:07.200"},
  ]);
  assert.deepEqual(contactSheetSamples(31).map(({frame}) => frame), [0, 300, 600, 900]);
  assert.equal(contactSheetSamples(100).length, 8);
  assert.ok(contactSheetSamples(100).every(({frame}) => Number.isInteger(frame) && frame >= 0));
});

test("proxyArgs writes H264 yuv420p CFR30 without audio", () => {
  const args = proxyArgs("/Volumes/share/素材 1.mp4", "/repo/work/job/public/proxies/id.partial.mp4");
  assert.equal(args[args.indexOf("-i") + 1], "/Volumes/share/素材 1.mp4");
  for (const value of ["libx264", "18", "yuv420p", "cfr", "-an"]) assert.ok(args.includes(value), value);
  assert.match(args[args.indexOf("-vf") + 1], /fps=30/);
  assert.equal(args.at(-1), "/repo/work/job/public/proxies/id.partial.mp4");
});

test("proxy metadata rejects the wrong format", () => {
  const valid = {
    format: {duration: "10"},
    streams: [{codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: 1080, height: 1920, avg_frame_rate: "30/1"}],
  };
  assert.equal(assertProxyProbeJson(valid).fps, 30);
  assert.throws(() => assertProxyProbeJson({...valid, streams: [{...valid.streams[0], codec_name: "hevc"}]}), /H.264/);
  assert.throws(() => assertProxyProbeJson({...valid, streams: [...valid.streams, {codec_type: "audio", codec_name: "aac"}]}), /audio/);
});

test("prepareMedia resumes cached work and isolates a source failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "auto-edit-prepare-"));
  const publicDir = path.join(root, "public");
  const paths = {
    workspaceRoot: root,
    workDir: root,
    publicDir,
    proxiesDir: path.join(publicDir, "proxies"),
    contactsDir: path.join(root, "contacts"),
  };
  await mkdir(paths.proxiesDir, {recursive: true});
  await mkdir(paths.contactsDir, {recursive: true});
  const sourcePath = path.join(root, "source.mp4");
  await writeFile(sourcePath, "source");
  const index = {
    schemaVersion: 1,
    sourceRoot: root,
    scannedAt: "2026-08-06T00:00:00.000Z",
    sources: [
      {id: "ok", sourcePath, relativePath: "产品/1.mp4", sizeBytes: 6, mtimeMs: 1, durationInSeconds: 9, width: 1080, height: 1920, fps: 30, codec: "h264", rotation: 0, hasAudio: true, quickFingerprint: null, proxyPath: null, contactSheetPath: null, status: "indexed", error: null},
      {id: "bad", sourcePath: `${sourcePath}-bad`, relativePath: "产品/2.mp4", sizeBytes: 6, mtimeMs: 1, durationInSeconds: 9, width: 1080, height: 1920, fps: 30, codec: "h264", rotation: 0, hasAudio: true, quickFingerprint: null, proxyPath: null, contactSheetPath: null, status: "indexed", error: null},
    ],
    shots: [
      {id: "ok", sourceId: "ok", sourcePath, sourceInSeconds: 0, sourceOutSeconds: 9, productSkus: [], tags: ["产品"], qualityScore: 0, confidence: 0, reviewState: "unreviewed"},
      {id: "bad", sourceId: "bad", sourcePath: `${sourcePath}-bad`, sourceInSeconds: 0, sourceOutSeconds: 9, productSkus: [], tags: ["产品"], qualityScore: 0, confidence: 0, reviewState: "unreviewed"},
    ],
  };
  const calls = [];
  const execFileImpl = async (command, args) => {
    calls.push({command, args});
    if (args.includes(`${sourcePath}-bad`)) throw new Error("decode failed");
    if (command === "ffprobe") return {stdout: JSON.stringify({format: {duration: "9"}, streams: [{codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: 1080, height: 1920, avg_frame_rate: "30/1"}]})};
    const output = command === "ffmpeg" ? args.at(-1) : args[3];
    await writeFile(output, command === "ffmpeg" ? "derived" : Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    return {stdout: "", stderr: ""};
  };
  const result = await prepareMedia({index, paths, execFileImpl});
  assert.deepEqual(result.metrics, {prepared: 1, cached: 0, failed: 1});
  assert.equal(result.updatedIndex.sources[0].proxyPath, "proxies/ok.mp4");
  assert.equal(result.updatedIndex.sources[0].contactSheetPath, "contacts/ok.jpg");
  assert.equal(result.updatedIndex.shots[0].proxyPath, "proxies/ok.mp4");
  assert.equal(result.updatedIndex.sources[1].status, "failed");
  assert.equal(result.updatedIndex.sources[1].proxyPath, null);
  assert.equal(result.updatedIndex.shots[1].proxyPath, undefined);
  const stillCall = calls.find(({args}) => args[0] === "still");
  const stillProps = JSON.parse(stillCall.args[stillCall.args.indexOf("--props") + 1]);
  assert.equal(stillProps.mediaPath, "proxies/ok.mp4");
  assert.ok(stillProps.samples.every(({label}) => label.includes("产品/1.mp4")));

  calls.length = 0;
  const resumed = await prepareMedia({index: result.updatedIndex, paths, execFileImpl});
  assert.deepEqual(resumed.metrics, {prepared: 0, cached: 1, failed: 1});
  assert.equal(calls.some(({command, args}) => command === "ffmpeg" && args.includes(sourcePath)), false);
  assert.equal(calls.some(({args}) => args[0] === "still"), false);
});
