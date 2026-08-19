import assert from "node:assert/strict";
import test from "node:test";
import {analyzeVolume, assertAudibleVolume, assertMixHeadroom, assertQcMetadata, assertSystemFont, forceMonoAac, renderArgs} from "./render-qc.mjs";

const timeline = {durationInFrames: 600};
const valid = {
  format: {duration: "20.04", size: "123456"},
  streams: [
    {codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: 1080, height: 1920, avg_frame_rate: "30/1", nb_read_frames: "600"},
    {codec_type: "audio", codec_name: "aac", channels: 1},
  ],
};

test("render args target the production composition without overwrite", () => {
  const args = renderArgs({partialOutputPath: "/out/x.partial.mp4", propsPath: "/work/props.json", publicDir: "/work/public"});
  assert.equal(args[2], "ProductMarketingProduction");
  for (const flag of ["--codec=h264", "--pixel-format=yuv420p", "--audio-codec=aac", "--enforce-audio-track", "--overwrite=false"]) assert.ok(args.includes(flag));
});

test("Remotion stitcher transcodes its stereo mix to mono AAC", () => {
  const args = ["-i", "video", "-c:a", "copy", "-c:v", "libx264", "out.mp4"];
  assert.deepEqual(forceMonoAac({type: "stitcher", args}), ["-i", "video", "-c:a", "aac", "-ac", "1", "-c:v", "libx264", "out.mp4"]);
  assert.equal(forceMonoAac({type: "pre-stitcher", args}), args);
});

test("QC accepts only the required video and mono audio metadata", () => {
  assert.equal(assertQcMetadata(valid, timeline).durationInSeconds, 20);
  for (const mutate of [
    (value) => { value.streams[0].codec_name = "hevc"; },
    (value) => { value.streams[0].pix_fmt = "yuvj420p"; },
    (value) => { value.streams[0].width = 1920; },
    (value) => { value.streams[0].avg_frame_rate = "30000/1001"; },
    (value) => { value.streams[1].channels = 2; },
    (value) => { value.streams[0].nb_read_frames = "599"; },
    (value) => { value.format.duration = "21"; },
  ]) {
    const changed = structuredClone(valid);
    mutate(changed);
    assert.throws(() => assertQcMetadata(changed, timeline));
  }
});

test("QC rejects inaudible tracks", () => {
  assert.equal(assertAudibleVolume("max_volume: -12.3 dB"), -12.3);
  assert.throws(() => assertAudibleVolume("max_volume: -inf dB"), /non-silent/);
  assert.throws(() => assertAudibleVolume("max_volume: -60.0 dB"), /non-silent/);
});

test("enhanced volume analysis records mean and rejects insufficient headroom", () => {
  const analysis = analyzeVolume("mean_volume: -15.0 dB\nmax_volume: -1.0 dB\n");
  assert.deepEqual(analysis, {meanVolumeDb: -15, maxVolumeDb: -1});
  assert.doesNotThrow(() => assertMixHeadroom(analysis));
  assert.throws(() => assertMixHeadroom({meanVolumeDb: -15, maxVolumeDb: -0.9}), /headroom/);
});

test("enhanced font preflight requires enabled valid PingFang SC", () => {
  const inventory = {SPFontsDataType: [{enabled: "yes", typefaces: [{family: "PingFang SC", enabled: "yes", valid: "yes"}]}]};
  assert.equal(assertSystemFont(inventory, "PingFang SC"), "PingFang SC");
  assert.throws(() => assertSystemFont({SPFontsDataType: []}, "PingFang SC"), /PingFang SC/);
});
