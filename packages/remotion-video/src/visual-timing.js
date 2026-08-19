export const DOUYIN_SAFE_ZONE = Object.freeze({left: 72, right: 200, top: 160, bottom: 530});

const MIN_CHARS = 7;
const MAX_CHARS = 12;
const PUNCTUATION = /[，。！？；：,.!?;:、]/u;
/** @param {string} value */
const chars = (value) => Array.from(value);
/** @param {string} value */
const weight = (value) => Math.max(1, chars(value).filter((character) => !/\s/u.test(character)).length);
/** @param {number} value @param {number} minimum @param {number} maximum */
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

/** @param {string} text */
export const splitCaptionText = (text) => {
  if (typeof text !== "string" || text.length === 0) throw new TypeError("caption text must be non-empty");
  if (chars(text).length <= MAX_CHARS) return [text];
  const chunks = [];
  let current = "";
  for (const character of chars(text)) {
    current += character;
    const length = chars(current).length;
    if (length >= MAX_CHARS || (length >= MIN_CHARS && PUNCTUATION.test(character))) {
      chunks.push(current);
      current = "";
    }
  }
  if (current.length > 0) {
    const previous = chunks.at(-1);
    if (previous && chars(previous + current).length <= MAX_CHARS) chunks[chunks.length - 1] += current;
    else chunks.push(current);
  }
  return chunks;
};

/** @param {import("./production-contract.js").ProductionSentence} sentence @returns {import("./components/subtitle-layer").SubtitleCue[]} */
export const captionCuesForSentence = (sentence) => {
  const finalFrame = sentence.startFrame + sentence.voiceFrames;
  const visual = sentence.visual;
  if (visual === undefined) {
    return [{id: `${sentence.id}-caption-1`, text: sentence.text, startFrame: sentence.startFrame, endFrame: finalFrame, legacy: true, role: null, emphasis: null}];
  }
  const captionEmphasis = visual.emphasis && sentence.text.includes(visual.emphasis) ? visual.emphasis : null;
  const chunks = splitCaptionText(sentence.text);
  while (chunks.length > sentence.voiceFrames) {
    const penultimate = chunks.at(-2);
    const last = chunks.at(-1);
    if (penultimate === undefined || last === undefined) break;
    chunks.splice(-2, 2, penultimate + last);
  }
  const weights = chunks.map(weight);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let cumulativeWeight = 0;
  let cursor = sentence.startFrame;
  const cues = chunks.map((text, index) => {
    cumulativeWeight += weights[index];
    const remainingChunks = chunks.length - index - 1;
    const proposed = sentence.startFrame + Math.round(sentence.voiceFrames * cumulativeWeight / totalWeight);
    const endFrame = index === chunks.length - 1 ? finalFrame : clamp(proposed, cursor + 1, finalFrame - remainingChunks);
    const cue = {
      id: `${sentence.id}-caption-${index + 1}`,
      text,
      startFrame: cursor,
      endFrame,
      legacy: false,
      role: visual.role,
      emphasis: captionEmphasis && text.includes(captionEmphasis) ? captionEmphasis : null,
    };
    cursor = endFrame;
    return cue;
  });
  if (captionEmphasis && !cues.some(({emphasis}) => emphasis === captionEmphasis)) {
    throw new TypeError(`emphasis crosses caption chunks: ${captionEmphasis}`);
  }
  return cues;
};
