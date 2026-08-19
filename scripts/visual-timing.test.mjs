import assert from "node:assert/strict";
import test from "node:test";
import {captionCuesForSentence, DOUYIN_SAFE_ZONE, splitCaptionText} from "../packages/remotion-video/src/visual-timing.js";

test("legacy sentences keep one full-sentence cue", () => {
  const cues = captionCuesForSentence({id: "s1", text: "完整旧字幕。", startFrame: 10, voiceFrames: 20});
  assert.deepEqual(cues, [{id: "s1-caption-1", text: "完整旧字幕。", startFrame: 10, endFrame: 30, legacy: true, role: null, emphasis: null}]);
});

test("enhanced captions preserve text and exactly cover voice frames", () => {
  const sentence = {
    id: "s1",
    text: "关键是Type-C充电，出差不用额外带线，省心。",
    startFrame: 20,
    voiceFrames: 67,
    visual: {role: "feature", emphasis: "Type-C"},
  };
  const cues = captionCuesForSentence(sentence);
  assert.equal(cues.map(({text}) => text).join(""), sentence.text);
  assert.equal(cues[0].startFrame, 20);
  assert.equal(cues.at(-1).endFrame, 87);
  assert.ok(cues.every((cue, index) => cue.endFrame > cue.startFrame && (index === 0 || cues[index - 1].endFrame === cue.startFrame)));
  assert.equal(cues.filter(({emphasis}) => emphasis === "Type-C").length, 1);
});

test("enhanced captions keep emphasis crossing the twelve-character boundary in one cue", () => {
  const sentence = {
    id: "boundary",
    text: "1234567890ABCDEFGHIJ",
    startFrame: 10,
    voiceFrames: 20,
    visual: {role: "feature", emphasis: "0ABC"},
  };
  const cues = captionCuesForSentence(sentence);
  assert.equal(cues.map(({text}) => text).join(""), sentence.text);
  assert.equal(cues.at(-1).endFrame, 30);
  assert.deepEqual(cues.filter(({emphasis}) => emphasis === "0ABC").map(({text}) => text), ["1234567890ABCDEFGHIJ"]);
});

test("enhanced captions rebalance a short trailing chunk toward seven characters", () => {
  assert.deepEqual(splitCaptionText("1234567890ABC"), ["123456", "7890ABC"]);
});

test("one-frame enhanced speech remains one valid cue", () => {
  const cues = captionCuesForSentence({id: "s1", text: "好", startFrame: 5, voiceFrames: 1, visual: {role: "hook"}});
  assert.equal(cues.length, 1);
  assert.deepEqual([cues[0].startFrame, cues[0].endFrame], [5, 6]);
});

test("label-only emphasis is left to the overlay", () => {
  const cues = captionCuesForSentence({id: "s1", text: "普通字幕", startFrame: 0, voiceFrames: 10, visual: {role: "feature", label: "刀头结构", emphasis: "刀头"}});
  assert.equal(cues[0].emphasis, null);
});

test("caption chunks and Douyin safe zone stay bounded", () => {
  assert.ok(splitCaptionText("这是超过十二个汉字并且带有标点的一整句字幕。").every((chunk) => Array.from(chunk).length <= 12));
  assert.deepEqual(DOUYIN_SAFE_ZONE, {left: 72, right: 200, top: 160, bottom: 530});
});
