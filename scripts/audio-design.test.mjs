import assert from "node:assert/strict";
import test from "node:test";
import {dbToGain, musicGainAt, sfxStartFrame} from "../packages/remotion-video/src/audio-design.js";

const sentences = [{startFrame: 10, voiceFrames: 30}, {startFrame: 45, voiceFrames: 20}];

test("BGM is 0.08 outside speech and ducks by exactly 5 dB during speech", () => {
  assert.equal(musicGainAt(0, sentences), 0.08);
  assert.ok(Math.abs(musicGainAt(10, sentences) - 0.08 * dbToGain(-5)) < 1e-12);
  assert.equal(musicGainAt(40, sentences), 0.08);
});

test("SFX timing is deterministic", () => {
  assert.equal(sfxStartFrame({startFrame: 20, visual: {sfx: "impact"}}), 20);
  assert.equal(sfxStartFrame({startFrame: 20, visual: {sfx: "usb"}}), 23);
  assert.equal(sfxStartFrame({startFrame: 20}), null);
});
