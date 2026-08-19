const FPS = 30;
const PLAN_FIELDS = ["schemaVersion", "id", "title", "sourceText", "catalogPath", "voice", "sentences"];
const SENTENCE_FIELDS = ["id", "text", "ttsText", "visual", "shot"];
const SHOT_FIELDS = ["sourceId", "sourceInSeconds", "sourceOutSeconds", "fit", "focusX", "focusY"];
const PROPS_FIELDS = ["schemaVersion", "id", "title", "sourceText", "width", "height", "fps", "durationInFrames", "sentences"];
const DERIVED_SENTENCE_FIELDS = ["id", "text", "ttsText", "wavPath", "wavDurationSeconds", "wavSha256", "startFrame", "voiceFrames", "pauseFrames", "visual", "shot"];
const DERIVED_SHOT_FIELDS = [...SHOT_FIELDS, "proxyPath"];
const VISUAL_FIELDS = ["role", "emphasis", "label", "sfx"];
const VISUAL_ROLES = new Set(["hook", "proof", "feature", "cta"]);
const VISUAL_SFX = new Set(["impact", "motor", "water", "usb", "cta"]);

/**
 * @typedef {object} ProductionShot
 * @property {string} sourceId
 * @property {string} proxyPath
 * @property {number} sourceInSeconds
 * @property {number} sourceOutSeconds
 * @property {"cover" | "contain"} fit
 * @property {number} focusX
 * @property {number} focusY
 */

/**
 * @typedef {object} ProductionSentence
 * @property {string} id
 * @property {string} text
 * @property {string} ttsText
 * @property {string} wavPath
 * @property {number} wavDurationSeconds
 * @property {string} wavSha256
 * @property {number} startFrame
 * @property {number} voiceFrames
 * @property {number} pauseFrames
 * @property {VisualIntent} [visual]
 * @property {ProductionShot} shot
 */

/**
 * @typedef {object} ProductionProps
 * @property {number} schemaVersion
 * @property {string} id
 * @property {string} title
 * @property {string} sourceText
 * @property {number} width
 * @property {number} height
 * @property {number} fps
 * @property {number} durationInFrames
 * @property {ProductionSentence[]} sentences
 */

/**
 * @typedef {object} VisualIntent
 * @property {"hook" | "proof" | "feature" | "cta"} role
 * @property {string} [emphasis]
 * @property {string} [label]
 * @property {"impact" | "motor" | "water" | "usb" | "cta"} [sfx]
 */

/** @param {string} message @returns {never} */
const fail = (message) => {
  throw new TypeError(message);
};

/** @param {*} value @param {string} name @returns {Record<string, any>} */
const object = (value, name) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
};

/** @param {*} value @param {string[]} fields @param {string} name */
const strict = (value, fields, name) => {
  object(value, name);
  for (const key of Object.keys(value)) if (!fields.includes(key)) fail(`${name} has unknown field ${key}`);
};

/** @param {*} value @param {string} name */
const text = (value, name) => {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} must be non-empty`);
};

/** @param {*} value @param {string} name */
const finite = (value, name) => {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${name} must be finite`);
};

/** @param {*} value @param {string} name */
const localPath = (value, name) => {
  text(value, name);
  if (/^[a-z][a-z\d+.-]*:/iu.test(value) || value.startsWith("//")) fail(`${name} must be a local path`);
};

/** @param {*} value @param {string} name */
const publicPath = (value, name) => {
  text(value, name);
  if (value.startsWith("/") || value.includes("\\") || /^[a-z][a-z\d+.-]*:/iu.test(value)) fail(`${name} must be public-dir relative POSIX path`);
  const parts = /** @type {string} */ (value).split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..") || parts[0] === "public") fail(`${name} must be public-dir relative POSIX path`);
};

/** @param {string} value */
const normalizeCopy = (value) => value.replace(/\s+/gu, "");

/** @param {*} visual @param {string} sentenceText @param {string} name */
const validateVisual = (visual, sentenceText, name) => {
  if (visual === undefined) return;
  strict(visual, VISUAL_FIELDS, name);
  if (!VISUAL_ROLES.has(visual.role)) fail(`${name}.role is invalid`);
  if (visual.label !== undefined) {
    text(visual.label, `${name}.label`);
    if (Array.from(visual.label).length > 18) fail(`${name}.label must be at most 18 Unicode characters`);
  }
  if (visual.emphasis !== undefined) {
    text(visual.emphasis, `${name}.emphasis`);
    if (!sentenceText.includes(visual.emphasis) && !visual.label?.includes(visual.emphasis)) {
      fail(`${name}.emphasis must occur in text or label`);
    }
  }
  if (visual.sfx !== undefined && !VISUAL_SFX.has(visual.sfx)) fail(`${name}.sfx is invalid`);
};

/** @param {Record<string, any>} shot @param {string} name @param {boolean} [derived] */
const validateShot = (shot, name, derived = false) => {
  strict(shot, derived ? DERIVED_SHOT_FIELDS : SHOT_FIELDS, name);
  text(shot.sourceId, `${name}.sourceId`);
  finite(shot.sourceInSeconds, `${name}.sourceInSeconds`);
  finite(shot.sourceOutSeconds, `${name}.sourceOutSeconds`);
  if (shot.sourceInSeconds < 0 || shot.sourceOutSeconds <= shot.sourceInSeconds) fail(`${name} source range is invalid`);
  if (shot.fit !== "cover" && shot.fit !== "contain") fail(`${name}.fit must be cover or contain`);
  finite(shot.focusX, `${name}.focusX`);
  finite(shot.focusY, `${name}.focusY`);
  if (shot.focusX < 0 || shot.focusX > 1 || shot.focusY < 0 || shot.focusY > 1) fail(`${name} focus must be between 0 and 1`);
  if (derived) publicPath(shot.proxyPath, `${name}.proxyPath`);
};

/** @param {*} value @returns {Record<string, any>} */
export const validateProductionPlan = (value) => {
  strict(value, PLAN_FIELDS, "plan");
  if (value.schemaVersion !== 1) fail("schemaVersion must be 1");
  text(value.id, "id");
  text(value.title, "title");
  text(value.sourceText, "sourceText");
  localPath(value.catalogPath, "catalogPath");
  strict(value.voice, ["promptPath", "durationFactor"], "voice");
  localPath(value.voice.promptPath, "promptPath");
  finite(value.voice.durationFactor, "durationFactor");
  if (value.voice.durationFactor < 0.5 || value.voice.durationFactor > 2) fail("durationFactor must be between 0.5 and 2");
  if (!Array.isArray(value.sentences) || value.sentences.length === 0) fail("sentences must be non-empty");
  const ids = new Set();
  for (const [index, sentence] of value.sentences.entries()) {
    const name = `sentences[${index}]`;
    strict(sentence, SENTENCE_FIELDS, name);
    text(sentence.id, `${name}.id`);
    if (ids.has(sentence.id)) fail("sentence IDs must be unique");
    ids.add(sentence.id);
    text(sentence.text, `${name}.text`);
    text(sentence.ttsText, `${name}.ttsText`);
    validateVisual(sentence.visual, sentence.text, `${name}.visual`);
    validateShot(sentence.shot, `${name}.shot`);
  }
  if (normalizeCopy(value.sentences.map((/** @type {Record<string, any>} */ sentence) => sentence.text).join("")) !== normalizeCopy(value.sourceText)) fail("sourceText must equal all sentence text");
  return value;
};

/** @param {{plan: Record<string, any>, audio: Record<string, any>, proxies: Record<string, any>}} input @returns {ProductionProps} */
export const buildProductionProps = ({plan, audio, proxies}) => {
  validateProductionPlan(plan);
  object(audio, "audio");
  object(proxies, "proxies");
  let startFrame = 0;
  const sentences = plan.sentences.map((/** @type {Record<string, any>} */ sentence, /** @type {number} */ index) => {
    const item = object(audio[sentence.id], `audio.${sentence.id}`);
    strict(item, ["wavPath", "durationInSeconds", "sha256"], `audio.${sentence.id}`);
    publicPath(item.wavPath, "wavPath");
    finite(item.durationInSeconds, "durationInSeconds");
    if (item.durationInSeconds <= 0) fail("durationInSeconds must be positive");
    text(item.sha256, "sha256");
    const proxy = object(proxies[sentence.shot.sourceId], `proxies.${sentence.shot.sourceId}`);
    strict(proxy, ["proxyPath"], `proxies.${sentence.shot.sourceId}`);
    publicPath(proxy.proxyPath, "proxyPath");
    const voiceFrames = Math.max(1, Math.ceil(item.durationInSeconds * FPS));
    if (Math.round(sentence.shot.sourceOutSeconds * FPS) - Math.round(sentence.shot.sourceInSeconds * FPS) < voiceFrames) fail(`source trim for ${sentence.id} is shorter than voice`);
    const pauseFrames = index === plan.sentences.length - 1 ? 0 : 5;
    const derived = {
      id: sentence.id,
      text: sentence.text,
      ttsText: sentence.ttsText,
      wavPath: item.wavPath,
      wavDurationSeconds: item.durationInSeconds,
      wavSha256: item.sha256,
      startFrame,
      voiceFrames,
      pauseFrames,
      ...(sentence.visual === undefined ? {} : {visual: {...sentence.visual}}),
      shot: {...sentence.shot, proxyPath: proxy.proxyPath},
    };
    startFrame += voiceFrames + pauseFrames;
    return derived;
  });
  return validateProductionProps({schemaVersion: 1, id: plan.id, title: plan.title, sourceText: plan.sourceText, width: 1080, height: 1920, fps: FPS, durationInFrames: startFrame, sentences});
};

/** @param {*} value @returns {ProductionProps} */
export const validateProductionProps = (value) => {
  strict(value, PROPS_FIELDS, "props");
  if (value.schemaVersion !== 1 || value.width !== 1080 || value.height !== 1920 || value.fps !== FPS) fail("props format is invalid");
  text(value.id, "id");
  text(value.title, "title");
  text(value.sourceText, "sourceText");
  if (!Array.isArray(value.sentences) || value.sentences.length === 0) fail("sentences must be non-empty");
  let nextFrame = 0;
  const ids = new Set();
  for (const [index, sentence] of value.sentences.entries()) {
    const name = `sentences[${index}]`;
    strict(sentence, DERIVED_SENTENCE_FIELDS, name);
    text(sentence.id, `${name}.id`);
    if (ids.has(sentence.id)) fail("sentence IDs must be unique");
    ids.add(sentence.id);
    text(sentence.text, `${name}.text`);
    text(sentence.ttsText, `${name}.ttsText`);
    validateVisual(sentence.visual, sentence.text, `${name}.visual`);
    publicPath(sentence.wavPath, `${name}.wavPath`);
    finite(sentence.wavDurationSeconds, `${name}.wavDurationSeconds`);
    if (sentence.wavDurationSeconds <= 0 || sentence.voiceFrames !== Math.max(1, Math.ceil(sentence.wavDurationSeconds * FPS))) fail(`${name} voice duration is invalid`);
    text(sentence.wavSha256, `${name}.wavSha256`);
    if (sentence.startFrame !== nextFrame) fail(`${name}.startFrame is not contiguous`);
    if (sentence.pauseFrames !== (index === value.sentences.length - 1 ? 0 : 5)) fail(`${name}.pauseFrames is invalid`);
    validateShot(sentence.shot, `${name}.shot`, true);
    if (Math.round(sentence.shot.sourceOutSeconds * FPS) - Math.round(sentence.shot.sourceInSeconds * FPS) < sentence.voiceFrames) fail(`${name} source trim is shorter than voice`);
    nextFrame += sentence.voiceFrames + sentence.pauseFrames;
  }
  if (value.durationInFrames !== nextFrame) fail("durationInFrames does not match sentences");
  if (normalizeCopy(value.sentences.map((/** @type {Record<string, any>} */ sentence) => sentence.text).join("")) !== normalizeCopy(value.sourceText)) fail("sourceText must equal all sentence text");
  return /** @type {ProductionProps} */ (value);
};

/** @param {number} frame @param {number} startFrame @param {number} endFrame @returns {number} */
export const subtitleOpacityAt = (frame, startFrame, endFrame) => {
  const duration = endFrame - startFrame;
  if (duration <= 0 || frame < startFrame || frame >= endFrame) return 0;
  if (duration === 1) return 1;
  const fadeFrames = Math.min(8, Math.floor(duration / 2));
  return Math.min(1, (frame - startFrame + 1) / fadeFrames, (endFrame - frame) / fadeFrames);
};
