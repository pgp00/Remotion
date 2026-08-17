# Timeline contract

`packages/shared/src/index.ts` is the authority. This reference records the real-footage invariants used by the two-pass CLI.

- `schemaVersion === 1`; 1080×1920; 30fps; 600–1200 frames.
- Clip IDs and subtitle IDs are unique.
- Clips are in playback order, start at frame 0, are contiguous, never overlap, and exactly cover `durationInFrames`.
- Every real clip has a non-null `assetShotId` resolving through `RenderJobProps.shots`.
- `index.sourceRoot` equals the selected job's explicit `sourceRoot`; every source and shot path resolves inside that same batch.
- Every source range is inside its `AssetShot` range and is long enough for the Timeline duration.
- `fit` is `cover` or `contain`; `focusX` and `focusY` are `0..1` and default to `0.5`.
- `AssetShot.proxyPath` is relative to the job public-dir, for example `proxies/<source-id>.mp4`.
- Subtitles are literal text from the configured user script.
- `voiceover` and `music` use `source: null` and `state: not_configured`.
- Real rendering requires `status: approved`, rejects `DEMO-SKU-001`, and rejects `assetShotId: null`.
- Props have exactly `{timeline: Timeline, shots: Record<string, AssetShot>}`; `shots` contains referenced shots keyed by `shot.id`.

Run the schema-consumer check after changing the contract:

```bash
npm run typecheck
```

The real two-pass commands are:

```bash
node scripts/auto-edit.mjs run --config <job-json> --through prepare
node scripts/auto-edit.mjs run --config <job-json> --from validate
```
