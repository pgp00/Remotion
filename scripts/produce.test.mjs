import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {lstat, mkdtemp, mkdir, readFile, realpath, rename, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";

import {parseCli, runProduction} from "./produce.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const wav = () => {
  const samples = 2205;
  const data = Buffer.alloc(samples * 2);
  const output = Buffer.alloc(44 + data.length);
  output.write("RIFF", 0); output.writeUInt32LE(output.length - 8, 4); output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(22050, 24); output.writeUInt32LE(44100, 28); output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34); output.write("data", 36); output.writeUInt32LE(data.length, 40); data.copy(output, 44);
  return output;
};

const makeWorkspace = async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "produce-test-")));
  await mkdir(path.join(root, "scripts"), {recursive: true});
  await mkdir(path.join(root, "packages/remotion-video/src"), {recursive: true});
  await mkdir(path.join(root, "work/indextts25/index-tts/.venv/bin"), {recursive: true});
  await mkdir(path.join(root, "work/indextts25/index-tts/checkpoints"), {recursive: true});
  await mkdir(path.join(root, "node_modules/.bin"), {recursive: true});
  await mkdir(path.join(root, "smb"), {recursive: true});
  const files = {
    sourceRoot: path.join(root, "smb"),
    source: path.join(root, "smb/source.mp4"),
    voice: path.join(root, "voice.wav"),
    python: path.join(root, "work/indextts25/index-tts/.venv/bin/python"),
    model: path.join(root, "work/indextts25/index-tts/checkpoints"),
    plan: path.join(root, "plan.json"),
    catalog: path.join(root, "catalog.json"),
    outDir: path.join(root, "out/production"),
  };
  await writeFile(files.source, "source");
  await writeFile(files.voice, wav());
  await writeFile(files.python, "python");
  await writeFile(path.join(files.model, "config.yaml"), "model: test\n");
  await writeFile(path.join(root, "scripts/indextts25-batch.py"), "worker");
  await writeFile(path.join(root, "node_modules/.bin/remotion"), "remotion");
  const sentences = [
    {id: "one", text: "第一句。", ttsText: "第一句。", shot: {sourceId: "source-1", sourceInSeconds: 0, sourceOutSeconds: 2, fit: "cover", focusX: 0.5, focusY: 0.5}},
    {id: "two", text: "第二句。", ttsText: "第二句。", shot: {sourceId: "source-1", sourceInSeconds: 2, sourceOutSeconds: 4, fit: "contain", focusX: 0.4, focusY: 0.6}},
  ];
  await writeFile(files.catalog, JSON.stringify({schemaVersion: 1, sourceRoot: files.sourceRoot, assets: [{id: "source-1", sourcePath: files.source, durationInSeconds: 6}]}));
  await writeFile(files.plan, JSON.stringify({schemaVersion: 1, id: "video-01", title: "测试", sourceText: "第一句。第二句。", catalogPath: files.catalog, voice: {promptPath: files.voice, durationFactor: 1}, sentences}));
  return {root, files};
};

const fakeCommands = (root, files, {maxVolume = "-12.0"} = {}) => {
  const calls = [];
  const execFileImpl = async (command, args) => {
    calls.push([command, args]);
    if (command === "ffmpeg" && args.includes("volumedetect")) return {stdout: "", stderr: `max_volume: ${maxVolume} dB\n`};
    if (command === "ffmpeg" && args.at(-1)?.endsWith(".partial.mp4")) {
      await writeFile(args.at(-1), "proxy");
      return {stdout: "", stderr: ""};
    }
    if (command === "ffprobe") {
      const target = args.at(-1);
      if (target.endsWith(".wav")) return {stdout: JSON.stringify({format: {duration: "1"}, streams: [{codec_type: "audio", channels: 1}]})};
      if (target.includes("/public/proxies/")) return {stdout: JSON.stringify({format: {duration: "6"}, streams: [{codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: 1080, height: 1920, avg_frame_rate: "30/1"}]})};
      const props = JSON.parse(await readFile(path.join(root, "work/production/video-01/props.json"), "utf8"));
      return {stdout: JSON.stringify({format: {duration: String(props.durationInFrames / 30), size: "99"}, streams: [{codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: 1080, height: 1920, avg_frame_rate: "30/1", nb_read_frames: String(props.durationInFrames)}, {codec_type: "audio", codec_name: "aac", channels: 1}]})};
    }
    if (command === files.python) {
      const batch = (await readFile(args[args.indexOf("--batch-file") + 1], "utf8")).trim().split("\n").map(JSON.parse);
      const outputDir = args[args.indexOf("--output-dir") + 1];
      const manifestPath = args[args.indexOf("--manifest") + 1];
      const items = [];
      for (const [index, task] of batch.entries()) {
        const contentKey = sha256(task.text);
        const outputPath = path.join(outputDir, `sentence-${contentKey}.wav`);
        await writeFile(outputPath, wav());
        items.push({line: index + 1, text: task.text, durationFactor: task.duration_factor, contentKey, outputPath, sha256: sha256(wav()), status: "generated"});
      }
      await writeFile(manifestPath, JSON.stringify({schemaVersion: 1, engine: "IndexTTS-2.5", engineVersion: "v2.5.0", voiceSha256: sha256(wav()), items}));
      return {stdout: "ok", stderr: ""};
    }
    if (args[0] === "render") {
      await writeFile(args[3], "rendered");
      return {stdout: "", stderr: ""};
    }
    if (args[0] === "still") {
      await writeFile(args[3], Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      return {stdout: "", stderr: ""};
    }
    return {stdout: "", stderr: ""};
  };
  return {calls, execFileImpl};
};

test("parseCli keeps one local entry and installed defaults", () => {
  const parsed = parseCli(["--plan", "work/plan.json"], {cwd: "/repo"});
  assert.deepEqual(parsed, {
    planPath: "/repo/work/plan.json",
    modelDir: "/repo/work/indextts25/index-tts/checkpoints",
    pythonPath: "/repo/work/indextts25/index-tts/.venv/bin/python",
    outDir: "/repo/out/production",
    workspaceRoot: "/repo",
  });
  assert.throws(() => parseCli(["--plan", "https://example.com/p.json"], {cwd: "/repo"}), /local/);
  assert.throws(() => parseCli(["--plan", "a", "--voice", "b"], {cwd: "/repo"}), /Unknown/);
});

test("runProduction accepts a local venv Python symlink", async () => {
  const {root, files} = await makeWorkspace();
  const pythonTarget = path.join(path.dirname(files.python), "python3.11");
  await rename(files.python, pythonTarget);
  await symlink(pythonTarget, files.python);
  const {execFileImpl} = fakeCommands(root, files);
  const resolvedExec = async (command, args, options) => execFileImpl(command === pythonTarget ? files.python : command, args, options);
  const result = await runProduction({planPath: files.plan, modelDir: files.model, pythonPath: files.python, outDir: files.outDir, workspaceRoot: root}, {execFileImpl: resolvedExec});
  assert.equal(result.outputPath, path.join(files.outDir, "video-01.mp4"));
});

test("runProduction accepts the npm Remotion CLI symlink", async () => {
  const {root, files} = await makeWorkspace();
  const remotion = path.join(root, "node_modules/.bin/remotion");
  const target = path.join(root, "node_modules/@remotion/cli/remotion-cli.js");
  await mkdir(path.dirname(target), {recursive: true});
  await rename(remotion, target);
  await symlink("../@remotion/cli/remotion-cli.js", remotion);
  const {execFileImpl} = fakeCommands(root, files);
  const result = await runProduction({planPath: files.plan, modelDir: files.model, pythonPath: files.python, outDir: files.outDir, workspaceRoot: root}, {execFileImpl});
  assert.equal(result.outputPath, path.join(files.outDir, "video-01.mp4"));
});

test("runProduction executes one local TTS and one Remotion final render", async () => {
  const {root, files} = await makeWorkspace();
  const {calls, execFileImpl} = fakeCommands(root, files);

  const result = await runProduction({planPath: files.plan, modelDir: files.model, pythonPath: files.python, outDir: files.outDir, workspaceRoot: root}, {execFileImpl});
  assert.equal(result.outputPath, path.join(files.outDir, "video-01.mp4"));
  assert.equal(result.designAudio, null);
  assert.equal(result.sentences.length, 2);
  assert.deepEqual(result.sentences.map(({pauseFrames}) => pauseFrames), [5, 0]);
  assert.equal(calls.filter(([command]) => command === files.python).length, 1);
  assert.equal(calls.filter(([, args]) => args[0] === "render").length, 1);
  assert.equal(calls.filter(([command, args]) => command === "ffmpeg" && args.at(-1)?.endsWith(".partial.mp4")).length, 1);
  const render = calls.find(([, args]) => args[0] === "render")[1];
  for (const flag of ["ProductMarketingProduction", "--codec=h264", "--pixel-format=yuv420p", "--audio-codec=aac", "--overwrite=false"]) assert.ok(render.includes(flag), flag);
  const manifest = JSON.parse(await readFile(path.join(root, "work/production/video-01/manifest.json"), "utf8"));
  assert.equal(manifest.output.sha256, sha256("rendered"));
  assert.deepEqual(manifest.sentences.map(({text}) => text), ["第一句。", "第二句。"]);
});

test("visual jobs stage only required verified design audio and record licenses", async () => {
  const {root, files} = await makeWorkspace();
  const planValue = JSON.parse(await readFile(files.plan, "utf8"));
  planValue.sentences[0].visual = {role: "hook", label: "先看这一刀", sfx: "impact"};
  await writeFile(files.plan, JSON.stringify(planValue));
  const audioRoot = path.join(root, "assets/audio/s5max");
  await mkdir(audioRoot, {recursive: true});
  await writeFile(path.join(audioRoot, "bgm.mp3"), "bgm");
  await writeFile(path.join(audioRoot, "impact.wav"), "impact");
  await writeFile(path.join(audioRoot, "sources.json"), JSON.stringify({schemaVersion: 1, licenseCheckedAt: "2026-08-19", assets: [
    {key: "bgm", fileName: "bgm.mp3", sha256: sha256("bgm"), sourceUrl: "https://example.test/bgm", license: "test"},
    {key: "impact", fileName: "impact.wav", sha256: sha256("impact"), sourceUrl: "https://example.test/impact", license: "test"},
  ]}));
  const {execFileImpl} = fakeCommands(root, files);
  const result = await runProduction({planPath: files.plan, modelDir: files.model, pythonPath: files.python, outDir: files.outDir, workspaceRoot: root}, {execFileImpl});
  assert.equal(await readFile(path.join(root, "work/production/video-01/public/audio/design/bgm.mp3"), "utf8"), "bgm");
  assert.deepEqual(result.designAudio.assets.map(({key}) => key), ["bgm", "impact"]);
});

test("visual jobs reject a design audio hash mismatch before rendering", async () => {
  const {root, files} = await makeWorkspace();
  const planValue = JSON.parse(await readFile(files.plan, "utf8"));
  planValue.sentences[0].visual = {role: "hook", label: "先看", sfx: "impact"};
  await writeFile(files.plan, JSON.stringify(planValue));
  const audioRoot = path.join(root, "assets/audio/s5max");
  await mkdir(audioRoot, {recursive: true});
  await writeFile(path.join(audioRoot, "bgm.mp3"), "tampered");
  await writeFile(path.join(audioRoot, "impact.wav"), "impact");
  await writeFile(path.join(audioRoot, "sources.json"), JSON.stringify({schemaVersion: 1, licenseCheckedAt: "2026-08-19", assets: [
    {key: "bgm", fileName: "bgm.mp3", sha256: sha256("expected"), sourceUrl: "https://example.test/bgm", license: "test"},
    {key: "impact", fileName: "impact.wav", sha256: sha256("impact"), sourceUrl: "https://example.test/impact", license: "test"},
  ]}));
  await assert.rejects(runProduction({planPath: files.plan, modelDir: files.model, pythonPath: files.python, outDir: files.outDir, workspaceRoot: root}), /design audio hash/);
});

test("runProduction rejects catalog mismatch and never overwrites a final", async () => {
  const {root, files} = await makeWorkspace();
  const plan = JSON.parse(await readFile(files.plan, "utf8"));
  plan.sentences[0].shot.sourceId = "missing";
  await writeFile(files.plan, JSON.stringify(plan));
  await assert.rejects(runProduction({planPath: files.plan, modelDir: files.model, pythonPath: files.python, outDir: files.outDir, workspaceRoot: root}), /missing/);
  plan.sentences[0].shot.sourceId = "source-1";
  await writeFile(files.plan, JSON.stringify(plan));
  await mkdir(files.outDir, {recursive: true});
  await writeFile(path.join(files.outDir, "video-01.mp4"), "keep");
  await assert.rejects(runProduction({planPath: files.plan, modelDir: files.model, pythonPath: files.python, outDir: files.outDir, workspaceRoot: root}), /exists/);
  assert.equal(await readFile(path.join(files.outDir, "video-01.mp4"), "utf8"), "keep");
});

test("QC failure keeps the partial diagnostic and never publishes a final", async () => {
  const {root, files} = await makeWorkspace();
  const {execFileImpl} = fakeCommands(root, files, {maxVolume: "-inf"});
  await assert.rejects(runProduction({planPath: files.plan, modelDir: files.model, pythonPath: files.python, outDir: files.outDir, workspaceRoot: root}, {execFileImpl}), /non-silent/);
  assert.equal(await readFile(path.join(files.outDir, "video-01.partial.mp4"), "utf8"), "rendered");
  await assert.rejects(readFile(path.join(files.outDir, "video-01.mp4")), {code: "ENOENT"});
});

test("manifest publication failure rolls final back to partial and preserves pending", async () => {
  const {root, files} = await makeWorkspace();
  const fake = fakeCommands(root, files);
  const manifestPath = path.join(root, "work/production/video-01/manifest.json");
  const execFileImpl = async (command, args) => {
    const result = await fake.execFileImpl(command, args);
    if (args[0] === "still") await mkdir(manifestPath);
    return result;
  };
  await assert.rejects(
    runProduction({planPath: files.plan, modelDir: files.model, pythonPath: files.python, outDir: files.outDir, workspaceRoot: root}, {execFileImpl}),
  );
  await assert.rejects(readFile(path.join(files.outDir, "video-01.mp4")), {code: "ENOENT"});
  assert.equal(await readFile(path.join(files.outDir, "video-01.partial.mp4"), "utf8"), "rendered");
  assert.equal(JSON.parse(await readFile(path.join(root, "work/production/video-01/manifest.partial.json"), "utf8")).id, "video-01");
  assert.equal((await lstat(manifestPath)).isDirectory(), true);
});

test("catalog sources must be local regular files", async () => {
  const {root, files} = await makeWorkspace();
  const catalog = JSON.parse(await readFile(files.catalog, "utf8"));
  catalog.assets[0].sourcePath = "https://example.com/source.mp4";
  await writeFile(files.catalog, JSON.stringify(catalog));
  await assert.rejects(runProduction({planPath: files.plan, modelDir: files.model, pythonPath: files.python, outDir: files.outDir, workspaceRoot: root}), /local/);
  const linkPath = path.join(root, "source-link.mp4");
  await symlink(files.source, linkPath);
  catalog.assets[0].sourcePath = linkPath;
  await writeFile(files.catalog, JSON.stringify(catalog));
  await assert.rejects(runProduction({planPath: files.plan, modelDir: files.model, pythonPath: files.python, outDir: files.outDir, workspaceRoot: root}), /non-symlink/);
});

test("catalog sources must stay under its declared sourceRoot", async () => {
  const {root, files} = await makeWorkspace();
  const catalog = JSON.parse(await readFile(files.catalog, "utf8"));
  const outside = path.join(root, "outside.mp4");
  await writeFile(outside, "outside");
  catalog.assets[0].sourcePath = outside;
  await writeFile(files.catalog, JSON.stringify(catalog));
  await assert.rejects(
    runProduction({planPath: files.plan, modelDir: files.model, pythonPath: files.python, outDir: files.outDir, workspaceRoot: root}),
    /sourceRoot/,
  );
});

test("selected catalog sourceId must be one safe filename component", async () => {
  const {root, files} = await makeWorkspace();
  const plan = JSON.parse(await readFile(files.plan, "utf8"));
  const catalog = JSON.parse(await readFile(files.catalog, "utf8"));
  for (const sentence of plan.sentences) sentence.shot.sourceId = "../escaped";
  catalog.assets[0].id = "../escaped";
  await writeFile(files.plan, JSON.stringify(plan));
  await writeFile(files.catalog, JSON.stringify(catalog));
  const {execFileImpl} = fakeCommands(root, files);
  await assert.rejects(
    runProduction({planPath: files.plan, modelDir: files.model, pythonPath: files.python, outDir: files.outDir, workspaceRoot: root}, {execFileImpl}),
    /sourceId.*filename-safe/,
  );
  await assert.rejects(readFile(path.join(root, "work/production/video-01/public/escaped.mp4")), {code: "ENOENT"});
  await assert.rejects(lstat(path.join(root, "work/production/video-01/public")), {code: "ENOENT"});
});

test("derived directories never traverse a symlink parent", async () => {
  const {root, files} = await makeWorkspace();
  const target = path.join(root, "redirected-output");
  await mkdir(target);
  await symlink(target, path.join(root, "out"));
  await assert.rejects(
    runProduction({planPath: files.plan, modelDir: files.model, pythonPath: files.python, outDir: files.outDir, workspaceRoot: root}),
    /Unsafe derived directory/,
  );
  await assert.rejects(realpath(path.join(target, "production")), {code: "ENOENT"});
});
