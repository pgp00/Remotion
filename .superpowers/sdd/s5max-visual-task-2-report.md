# Task 2 — Deterministic Phrase Captions

Implemented deterministic caption cues for enhanced sentences while retaining the legacy single full-sentence cue and existing Arial layout whenever `visual` is absent.

Changes:

- Added `visual-timing.js`: bounded Unicode chunking, proportional contiguous frame allocation, emphasis handling, and the Douyin safe-zone constant.
- Added timing regression tests covering legacy, enhanced, one-frame, label-only emphasis, and bounds behavior.
- Routed `ProductionVideo` through `flatMap(captionCuesForSentence)`.
- Added an exact legacy JSX branch and the specified enhanced caption styling.
- Updated the production contract source assertion.

Verification:

- RED confirmed: `node --test scripts/visual-timing.test.mjs` failed with `ERR_MODULE_NOT_FOUND` before implementation.
- Focused: `node --test scripts/visual-timing.test.mjs scripts/production-contract.test.mjs` — 22 passed.
- Typecheck: `npm run typecheck --workspace @auto-video/remotion-video` — passed.
- Full suite: `npm test` — 78 passed.

Notes:

- The ordinary sandbox blocks Remotion's Chromium integration test; the focused and full tests passed when launched with approved elevated local-browser permission.

## Task 2 review fix

- RED confirmed with a valid enhanced sentence whose `visual.emphasis` (`0ABC`) crossed the existing 12-codepoint boundary; the prior implementation threw `TypeError: emphasis crosses caption chunks`.
- `splitCaptionText` now protects an emphasis range while splitting, preserves full text and contiguous frame coverage, and safely rebalances a short trailing chunk toward seven characters when the boundary remains valid.
- The one-frame enhanced cue path remains unchanged; impossible 7–12 sizing guarantees for 13-codepoint text and positive cues when `voiceFrames < chunks` are not forced.
- Verification: `node --test scripts/visual-timing.test.mjs` — 7 passed; `npm run typecheck --workspace @auto-video/remotion-video` — passed.
- Follow-up boundary fix: the crossing-emphasis regression now requires bounded cues `[`12345678`, `90ABCDEFGHIJ`]`; the splitter shifts the adjacent boundary before the protected emphasis instead of producing one oversized cue.
