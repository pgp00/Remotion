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

/** @param {string} text @param {string | null} [protectedText] */
export const splitCaptionText = (text, protectedText = null) => {
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

  if (protectedText && text.includes(protectedText)) {
    const protectedStart = chars(text.slice(0, text.indexOf(protectedText))).length;
    const protectedEnd = protectedStart + chars(protectedText).length;
    let offset = 0;
    let first = -1;
    let last = -1;
    chunks.forEach((chunk, index) => {
      const end = offset + chars(chunk).length;
      if (protectedStart < end && first === -1) first = index;
      if (protectedEnd <= end && last === -1) last = index;
      offset = end;
    });
    if (first !== -1 && last !== -1 && first !== last) {
      const allChars = chars(text);
      /** @type {Map<number, string[] | null>} */
      const memo = new Map();
      /** @param {number} position @returns {string[] | null} */
      const partition = (position) => {
        if (position === allChars.length) return [];
        const cached = memo.get(position);
        if (cached !== undefined) return cached;
        for (let length = MIN_CHARS; length <= MAX_CHARS; length += 1) {
          const end = position + length;
          if (end > allChars.length || (position < protectedEnd && end > protectedStart && end < protectedEnd)) continue;
          const rest = partition(end);
          if (rest !== null) {
            const result = [allChars.slice(position, end).join(""), ...rest];
            memo.set(position, result);
            return result;
          }
        }
        memo.set(position, null);
        return null;
      };
      const partitioned = chars(protectedText).length <= MAX_CHARS ? partition(0) : null;
      if (partitioned !== null) chunks.splice(0, chunks.length, ...partitioned);
    }
  }

  const trailingCandidate = chunks.at(-1);
  if (chunks.length > 1 && trailingCandidate !== undefined && chars(trailingCandidate).length < MIN_CHARS) {
    const penultimate = chunks.at(-2);
    const trailing = trailingCandidate;
    if (penultimate === undefined || trailing === undefined) return chunks;
    const move = Math.min(chars(penultimate).length - 1, MIN_CHARS - chars(trailing).length);
    if (move > 0) {
      const protectedStart = protectedText !== null && text.includes(protectedText)
        ? chars(text.slice(0, text.indexOf(protectedText))).length
        : -1;
      const protectedEnd = protectedStart !== -1 && protectedText !== null
        ? protectedStart + chars(protectedText).length
        : -1;
      const penultimateEnd = chunks.slice(0, -1).reduce((sum, chunk) => sum + chars(chunk).length, 0);
      if (protectedEnd === -1 || protectedEnd <= penultimateEnd - move || protectedStart >= penultimateEnd) {
        const penultimateChars = chars(penultimate);
        chunks.splice(-2, 2, penultimateChars.slice(0, -move).join(""), penultimateChars.slice(-move).join("") + trailing);
      }
    }
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
  const chunks = splitCaptionText(sentence.text, captionEmphasis);
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
