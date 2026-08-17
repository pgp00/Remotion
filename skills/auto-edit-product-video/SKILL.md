---
name: auto-edit-product-video
description: Prepare, select, validate, and render one traceable vertical product-video Timeline from an explicit local/SMB batch and a user script in this Remotion repository. Use when Codex is asked to inspect indexed footage, choose real shots, revise a Timeline, or render an approved review draft.
---

# Auto-edit one product video draft

## Protect the source and the claims

- Read `docs/DEFERRED_CAPABILITIES.md` and the selected job JSON before acting.
- Treat `sourceRoot` as read-only. Write only under the job's local `work/` and `out/` paths.
- Use only the user's script text for subtitles and claims; split or shorten literal passages, but do not invent efficacy, pricing, certification, or comparison claims.
- Never substitute demo placeholders, a different product, or unrelated footage when a trustworthy match is absent.
- Treat the MVP as a silent, non-publishable review draft. Voiceover and music remain `source: null`, `state: not_configured`.

## Pass 1: index and prepare

Run:

```bash
node scripts/auto-edit.mjs run --config <job-json> --through prepare
```

Stop on a nonzero exit. Do not fall back to `ProductMarketingDemo`.

Read the job JSON, its UTF-8 script, `work/<job-id>/index.json`, and every `work/<job-id>/contacts/<source-id>.jpg`.

## Select one Timeline

1. Split the script into hook, body/selling points, proof shots, and CTA without adding claims.
2. Use directory segments and `product.aliases` only for recall. Product/SKU correctness outranks image quality and visual variety.
3. Select real source ranges from contact sheets. Ordinary clips default to 2–4 seconds; the hook should begin within the first 3 seconds.
4. Never repeat the same source range. Never select two different sources with the same non-null `quickFingerprint`.
5. If a script segment has no credible footage, stop and ask for a source choice. Do not use `assetShotId: null`.
6. Write exactly one `work/<job-id>/timeline.json` against `packages/shared/src/index.ts` and `references/timeline-contract.md`.
7. Use 1080×1920, 30fps, 600–1200 contiguous frames. Keep `voiceover` and `music` unconfigured.
8. Keep Timeline status `needs_review`. Present every clip's `AssetShot.id`, source path, source in/out, purpose, and confidence to the user.
9. Preserve low-confidence reasons and selected-shot details in `result.json.reviewNotes`; do not erase existing stage metrics.
10. Only after explicit user approval, change Timeline status to `approved`.

## Pass 2: validate, render, and verify

Run:

```bash
node scripts/auto-edit.mjs run --config <job-json> --from validate
```

The command must fail before rendering if subtitles are not literal script text, a shot/range/proxy is invalid, duplicate fingerprints are selected, Timeline is not approved, or the demo SKU/null shots appear.

If this pass reaches `qc_failed`, keep the diagnostic partial and render manifest. After fixing the QC environment—not the approved Timeline—retry only:

```bash
node scripts/auto-edit.mjs qc --config <job-json>
```

QC must reject the partial if the current validated Props SHA-256 differs from the render manifest. For any Timeline or shot change, preserve the old job artifacts and use a new job ID; never promote the old partial.

Report the final MP4, final-cut contact sheet, `result.json.status`, every used source/range, low-confidence choices, and the fact that the MVP audio track is silent.

## Demo mode

Use `ProductMarketingDemo` only for a user-requested framework smoke test:

```bash
npm run typecheck
npm run studio
npm run render:demo
```

State that demo mode uses programmatic placeholders and is not a real material draft.

Use this exact review-note shape so later `writeResult()` merges it unchanged:

```ts
interface ReviewNotes {
  selectedShots: Array<{
    clipId: string;
    assetShotId: string;
    sourcePath: string;
    sourceInSeconds: number;
    sourceOutSeconds: number;
    purpose: "hook" | "body" | "proof" | "cta";
    confidence: number;
  }>;
  lowConfidence: Array<{
    clipId: string;
    reason: string;
  }>;
}
```

Populate every value from the actual index, Timeline, and visual review; never use invented IDs or paths.
