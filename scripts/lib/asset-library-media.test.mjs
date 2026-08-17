import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ctaSamples,
  grayscaleStatsFromFfmpeg,
  isJpeg,
  qualityFlagsForFrameStats,
  renderAssetSheets,
  renderSourceSheet,
  sourceContactSamples,
} from "./asset-library-media.mjs";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

test("source contact and CTA samples follow the approved duration bands", () => {
  assert.deepEqual(sourceContactSamples(8), [{seconds: 4, timecode: "00:00:04.000"}]);
  assert.deepEqual(sourceContactSamples(9).map(({seconds}) => seconds), [1.8, 4.5, 7.2]);
  assert.deepEqual(sourceContactSamples(31).map(({seconds}) => seconds), [0, 10, 20, 30]);
  assert.ok(sourceContactSamples(40).at(-1).seconds < 40);
  assert.equal(sourceContactSamples(100).length, 8);
  assert.deepEqual(ctaSamples(4).map(({seconds}) => seconds), [0, 1, 2, 3.75]);
  assert.deepEqual(ctaSamples(3).map(({seconds}) => seconds), [0.3, 1.2, 2.1, 2.85]);
});

test("renderSourceSheet extracts SMB source frames to local staging and publishes a JPEG atomically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "asset-library-media-"));
  const sourcePath = "/Volumes/fake-smb/产品/source.mp4";
  const outputPath = path.join(root, "contacts", "asset.jpg");
  const stagingDir = path.join(root, ".staging");
  const calls = [];
  const execFileImpl = async (command, args) => {
    calls.push({command, args});
    const output = command === "ffmpeg" ? args.at(-1) : args[3];
    await mkdir(path.dirname(output), {recursive: true});
    await writeFile(output, jpeg);
    return {stdout: "", stderr: ""};
  };

  await renderSourceSheet({
    sourcePath,
    relativePath: "产品/source.mp4",
    samples: sourceContactSamples(9),
    outputPath,
    stagingDir,
    execFileImpl,
  });

  assert.equal(await isJpeg(outputPath), true);
  assert.ok(calls.every(({command}) => command === "ffmpeg"));
  const sourceCalls = calls.filter(({args}) => args.includes(sourcePath));
  assert.equal(sourceCalls.length, 3);
  assert.ok(sourceCalls.every(({args}) => args[args.indexOf("-i") + 1] === sourcePath));
  assert.ok(calls.flatMap(({args}) => args).every((value) => !String(value).includes("proxies/")));
  assert.ok(calls.slice(0, -1).every(({args}) => args.at(-1).startsWith(stagingDir)));
  assert.deepEqual(await readdir(stagingDir), []);
  const composition = calls.at(-1).args;
  assert.equal(composition[composition.indexOf("-metadata") + 1], "comment=产品/source.mp4\n00:00:01.800, 00:00:04.500, 00:00:07.200");
  const filter = composition[composition.indexOf("-filter_complex") + 1];
  assert.match(filter, /drawtext/);
  assert.match(filter, /产品\/source\.mp4/);
  assert.match((await readFile(outputPath)).toString("hex"), /^ffd8/);
});

test("renderSourceSheet replaces an invalid cached JPEG instead of treating it as ready", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "asset-library-media-"));
  const outputPath = path.join(root, "contacts", "asset.jpg");
  await mkdir(path.dirname(outputPath), {recursive: true});
  await writeFile(outputPath, "not a jpeg");
  let calls = 0;
  await renderSourceSheet({
    sourcePath: "/Volumes/fake-smb/source.mp4",
    relativePath: "source.mp4",
    samples: [{seconds: 1, timecode: "00:00:01.000"}],
    outputPath,
    stagingDir: path.join(root, ".staging"),
    execFileImpl: async (_command, args) => {
      calls += 1;
      await mkdir(path.dirname(args.at(-1)), {recursive: true});
      await writeFile(args.at(-1), jpeg);
      return {stdout: "", stderr: ""};
    },
  });
  assert.equal(calls, 2);
  assert.equal(await isJpeg(outputPath), true);
});

test("renderSourceSheet falls back to the labeled Remotion image sheet when drawtext is unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "asset-library-media-fallback-"));
  const outputPath = path.join(root, "contacts", "asset.jpg");
  const calls = [];
  const execFileImpl = async (command, args) => {
    calls.push({command, args});
    if (command === "ffmpeg" && args.includes("-filter_complex")) {
      const error = new Error("No such filter: 'drawtext'");
      error.stderr = "No such filter: 'drawtext'";
      throw error;
    }
    const output = command === "ffmpeg" ? args.at(-1) : args[3];
    await mkdir(path.dirname(output), {recursive: true});
    await writeFile(output, jpeg);
    return {stdout: "", stderr: ""};
  };
  await renderSourceSheet({
    sourcePath: "/Volumes/fake-smb/source.mp4",
    relativePath: "source.mp4",
    samples: [{seconds: 1, timecode: "00:00:01.000"}],
    outputPath,
    stagingDir: path.join(root, ".staging"),
    workspaceRoot: "/workspace/repo",
    execFileImpl,
  });
  const remotion = calls.find(({args}) => args.includes("MediaImageContactSheet"));
  assert.ok(remotion);
  const props = JSON.parse(remotion.args[remotion.args.indexOf("--props") + 1]);
  assert.equal(props.images[0].label, "source.mp4 | 00:00:01.000");
  assert.equal(await isJpeg(outputPath), true);
});

test("frame statistics only mark visual review hints", () => {
  assert.deepEqual(qualityFlagsForFrameStats({
    contact: [{meanLuma: 1}, {meanLuma: 2}, {meanLuma: 90}],
    cta: [{meanLuma: 100, frameDifference: 0}, {meanLuma: 100, frameDifference: 0}, {meanLuma: 100, frameDifference: 0}, {meanLuma: 100, frameDifference: 0}],
  }), ["mostly_black", "frozen_tail"]);
  assert.deepEqual(qualityFlagsForFrameStats({
    contact: [{meanLuma: 100}],
    cta: [{meanLuma: 100, frameDifference: 1}, {meanLuma: 100, frameDifference: 1}, {meanLuma: 100, frameDifference: 1}, {meanLuma: 10, frameDifference: 90}],
  }), ["empty_tail_candidate"]);
});

test("grayscale statistics calculate frame differences across requested samples", async () => {
  const pixels = [Buffer.from([0, 0, 0, 0]), Buffer.from([10, 10, 10, 10]), Buffer.from([20, 20, 20, 20])];
  let index = 0;
  const stats = await grayscaleStatsFromFfmpeg({
    sourcePath: "/Volumes/fake-smb/source.mp4",
    samples: [{seconds: 1}, {seconds: 2}, {seconds: 3}],
    execFileImpl: async () => ({stdout: pixels[index++], stderr: Buffer.alloc(0)}),
  });
  assert.deepEqual(stats, [
    {meanLuma: 0, frameDifference: null},
    {meanLuma: 10, frameDifference: 10},
    {meanLuma: 20, frameDifference: 10},
  ]);
});

test("renderAssetSheets returns local relative paths and injectable visual flags", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "asset-library-media-"));
  const paths = {
    workDir: root,
    contactsDir: path.join(root, "contacts"),
    ctaDir: path.join(root, "cta"),
    stagingDir: path.join(root, ".staging"),
  };
  const calls = [];
  const result = await renderAssetSheets({
    record: {id: "asset-1", sourcePath: "/Volumes/fake-smb/source.mp4", relativePath: "产品/source.mp4", durationInSeconds: 10},
    paths,
    execFileImpl: async (command, args) => {
      calls.push({command, args});
      await mkdir(path.dirname(args.at(-1)), {recursive: true});
      await writeFile(args.at(-1), jpeg);
      return {stdout: "", stderr: ""};
    },
    grayscaleStatsImpl: async ({samples}) => samples.map(() => ({meanLuma: 100, frameDifference: 0})),
  });
  assert.deepEqual(result, {contactSheetPath: "contacts/asset-1.jpg", ctaSheetPath: "cta/asset-1.jpg", qualityFlags: ["frozen_tail"]});
  assert.equal(await isJpeg(path.join(paths.contactsDir, "asset-1.jpg")), true);
  assert.equal(await isJpeg(path.join(paths.ctaDir, "asset-1.jpg")), true);
  assert.ok(calls.flatMap(({args}) => args).every((value) => !String(value).includes("proxies/")));
});

test("renderAssetSheets only remeasures the missing derivative stage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "asset-library-media-"));
  const paths = {workDir: root, contactsDir: path.join(root, "contacts"), ctaDir: path.join(root, "cta"), stagingDir: path.join(root, ".staging")};
  await mkdir(paths.contactsDir, {recursive: true});
  await writeFile(path.join(paths.contactsDir, "asset-2.jpg"), jpeg);
  const measured = [];
  const result = await renderAssetSheets({
    record: {id: "asset-2", sourcePath: "/Volumes/fake-smb/source.mp4", relativePath: "source.mp4", durationInSeconds: 10, qualityFlags: ["mostly_black"]},
    paths,
    execFileImpl: async (_command, args) => {
      await mkdir(path.dirname(args.at(-1)), {recursive: true});
      await writeFile(args.at(-1), jpeg);
      return {stdout: "", stderr: ""};
    },
    grayscaleStatsImpl: async ({samples}) => {
      measured.push(samples.length);
      return samples.map(() => ({meanLuma: 100, frameDifference: 0}));
    },
  });
  assert.deepEqual(measured, [4]);
  assert.deepEqual(result.qualityFlags, ["mostly_black", "frozen_tail"]);
});

test("renderAssetSheets rejects an asset ID that could escape local output directories", async () => {
  await assert.rejects(renderAssetSheets({
    record: {id: "../outside", sourcePath: "/Volumes/fake-smb/source.mp4", relativePath: "source.mp4", durationInSeconds: 10},
    paths: {workDir: "/tmp/asset-library"},
  }), /safe filename/);
});
