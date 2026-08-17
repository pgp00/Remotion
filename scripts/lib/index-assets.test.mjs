import assert from "node:assert/strict";
import {mkdtemp, mkdir, stat, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertIndexMatchesSourceRoot,
  createSourceId,
  indexAssets,
  isAcceptedMedia,
  naturalSort,
  parseFrameRate,
  parseProbeJson,
  quickFingerprint,
} from "./index-assets.mjs";

test("filters supported media and excluded path segments", () => {
  assert.equal(isAcceptedMedia("1.MP4"), true);
  assert.equal(isAcceptedMedia("folder/clip.mov"), true);
  assert.equal(isAcceptedMedia("folder/clip.m4v"), true);
  for (const name of [
    ".DS_Store", "._1.mp4", "Thumbs.db", "shortcut.lnk",
    ".accelerate/1.mp4", "$RECYCLE.BIN/1.mp4", "System Volume Information/1.mp4",
  ]) assert.equal(isAcceptedMedia(name), false, name);
});

test("naturalSort is numeric and stable for Chinese paths", () => {
  assert.deepEqual(naturalSort(["11 (10).mp4", "2.mp4", "11 (2).mp4", "1.mp4"]), [
    "1.mp4", "2.mp4", "11 (2).mp4", "11 (10).mp4",
  ]);
});

test("parses frame rates and ffprobe metadata", () => {
  assert.ok(Math.abs(parseFrameRate("30000/1001") - 29.97002997) < 0.000001);
  assert.equal(parseFrameRate("30/1"), 30);
  assert.equal(parseFrameRate("0/0"), 0);
  const probe = parseProbeJson({
    format: {duration: "4.25", format_name: "mov,mp4,m4a,3gp,3g2,mj2"},
    streams: [
      {codec_type: "video", codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30/1", pix_fmt: "yuv420p", tags: {rotate: "90"}},
      {codec_type: "audio", codec_name: "aac", sample_rate: "48000"},
    ],
  });
  assert.deepEqual(
    {duration: probe.durationInSeconds, width: probe.width, height: probe.height, fps: probe.fps, codec: probe.codec, rotation: probe.rotation, hasAudio: probe.hasAudio},
    {duration: 4.25, width: 1080, height: 1920, fps: 30, codec: "h264", rotation: 90, hasAudio: true},
  );
  assert.equal(probe.container, "mov,mp4,m4a,3gp,3g2,mj2");
  assert.equal(parseProbeJson({format: {duration: "1"}, streams: [{codec_type: "video", codec_name: "hevc", width: 1920, height: 1080, avg_frame_rate: "60/1", side_data_list: [{rotation: -90}]}]}).rotation, -90);
  assert.equal(parseProbeJson({format: {duration: "1"}, streams: [{codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1"}]}).hasAudio, false);
  assert.throws(() => parseProbeJson("{"));
  assert.throws(() => parseProbeJson({streams: []}), /video stream/);
});

test("source IDs are deterministic and fingerprints distinguish equal-size files", async () => {
  assert.equal(createSourceId("a.mp4", 4, 100), createSourceId("a.mp4", 4, 100));
  assert.equal(createSourceId("a.mp4", 4, 100).length, 64);
  assert.notEqual(createSourceId("a.mp4", 4, 100), createSourceId("a.mp4", 4, 101));
  const root = await mkdtemp(path.join(tmpdir(), "auto-edit-fingerprint-"));
  const a = path.join(root, "a.mp4");
  const b = path.join(root, "b.mp4");
  await writeFile(a, "aaaa");
  await writeFile(b, "bbbb");
  assert.notEqual(await quickFingerprint(a, 4), await quickFingerprint(b, 4));
});

test("indexAssets rejects an internal symbolic-link escape", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "auto-edit-index-symlink-"));
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.mp4`);
  await writeFile(outside, "outside");
  await symlink(outside, path.join(root, "escape.mp4"));
  await assert.rejects(indexAssets({sourceRoot: root, probe: async () => ({})}), /Symbolic links/);
});

test("assertIndexMatchesSourceRoot binds every source and shot to one explicit batch", () => {
  const root = "/Volumes/share/batch";
  const sourcePath = path.join(root, "nested/1.mp4");
  const index = {
    sourceRoot: root,
    sources: [{id: "source-1", relativePath: "nested/1.mp4", sourcePath}],
    shots: [{id: "source-1", sourceId: "source-1", sourcePath}],
  };
  assert.doesNotThrow(() => assertIndexMatchesSourceRoot(index, root));
  assert.throws(() => assertIndexMatchesSourceRoot(index, "/Volumes/share/other"), /sourceRoot/);
  assert.throws(() => assertIndexMatchesSourceRoot({
    ...index,
    sources: [{...index.sources[0], relativePath: "../escape.mp4", sourcePath: "/Volumes/share/escape.mp4"}],
  }, root), /outside sourceRoot/);
  assert.throws(() => assertIndexMatchesSourceRoot({
    ...index,
    shots: [{...index.shots[0], sourcePath: "/Volumes/share/other/1.mp4"}],
  }, root), /shot source/);
});

test("indexAssets caches unchanged probes and preserves a failed source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "auto-edit-index-"));
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "1.mp4"), "same");
  await writeFile(path.join(root, "nested/2.mp4"), "same");
  await writeFile(path.join(root, "3.mov"), "fail");
  const calls = [];
  const probe = async (sourcePath) => {
    calls.push(sourcePath);
    if (sourcePath.endsWith("3.mov")) throw new Error("probe failed");
    return {durationInSeconds: 10, width: 1080, height: 1920, fps: 30, codec: "h264", rotation: 0, hasAudio: true};
  };
  const first = await indexAssets({sourceRoot: root, probe, now: () => new Date("2026-08-06T00:00:00.000Z")});
  assert.deepEqual(first.metrics, {sources: 3, cached: 0, probed: 3, failed: 1});
  assert.equal(first.index.shots.length, 2);
  assert.equal(first.index.sources.filter((source) => source.quickFingerprint !== null).length, 2);
  assert.match(first.index.sources.find((source) => source.relativePath === "3.mov").error, /probe failed/);
  calls.length = 0;
  const second = await indexAssets({sourceRoot: root, previousIndex: first.index, probe});
  assert.deepEqual(second.metrics, {sources: 3, cached: 2, probed: 1, failed: 1});
  assert.deepEqual(calls.map((value) => path.basename(value)), ["3.mov"]);
  for (const source of second.index.sources.filter((item) => item.status !== "failed")) {
    const info = await stat(source.sourcePath);
    assert.equal(source.sizeBytes, info.size);
  }

  const otherRoot = await mkdtemp(path.join(tmpdir(), "auto-edit-index-other-root-"));
  await writeFile(path.join(otherRoot, "1.mp4"), "same");
  calls.length = 0;
  const other = await indexAssets({sourceRoot: otherRoot, previousIndex: first.index, probe});
  assert.deepEqual(other.metrics, {sources: 1, cached: 0, probed: 1, failed: 0});
  assert.equal(calls.length, 1);
});

test("indexAssets fails the stage when every probe fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "auto-edit-index-all-failed-"));
  await writeFile(path.join(root, "1.mp4"), "broken");
  await assert.rejects(
    indexAssets({sourceRoot: root, probe: async () => { throw new Error("bad media"); }}),
    /No source video passed ffprobe/,
  );
});
