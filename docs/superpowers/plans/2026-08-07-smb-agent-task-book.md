# SMB 全量资产库并行验收任务书

## Objective

在已挂载的 `/Volumes/192.168.50.79` 上完成只读全量扫描；本地生成 catalog、技术索引、指纹、联系表、CTA 四帧图及可恢复运行证据。SMB 不允许任何写入。

## Baseline

- Workspace: `/Users/gilgamesharcher/Repo/Remotion`
- Source: `/Volumes/192.168.50.79`
- Local work: `work/asset-library`
- Running command: `node scripts/asset-library.mjs scan --source-root /Volumes/192.168.50.79 --work-dir work/asset-library --media-concurrency 4`
- User-owned changes: preserve all existing files and the running scan
- Concurrency: use independent read-only agents; lead owns integration and final verdict

## Work graph

```text
Lead keeps scan alive
├── progress/watchdog
├── SMB safety/source snapshot review
├── catalog/schema acceptance review
├── media JPEG/CTA artifact validator
├── search/query acceptance review
└── failure/resume evidence review
        ↓
Lead performs final local verification and reports APPROVE/BLOCK
```

## Role matrix

| Role | Tier | Objective | Write ownership | Deliverable |
| --- | --- | --- | --- | --- |
| PROJECT_LEAD | L | Keep scan alive, integrate evidence, final verdict | Shared docs and final report | APPROVE/BLOCK report |
| WATCHDOG | R | Track checkpoint growth and phase transitions | Unique watchdog report only | Progress/stall evidence |
| SMB_SAFETY | R | Verify mount/source snapshot and no source writes | Unique safety report only | Mount and snapshot evidence |
| CATALOG_REVIEW | R | Validate catalog schema, states, fingerprints, flags | Unique catalog report only | Schema/count findings |
| MEDIA_REVIEW | R | Validate local contact/CTA JPEG artifacts | Unique media report only | JPEG/CTA findings |
| SEARCH_REVIEW | R | Exercise search filters against catalog | Unique search report only | Query acceptance matrix |
| RESUME_REVIEW | R | Check checkpoint/run failure-resume evidence | Unique resume report only | Recovery findings |

## Integration order

1. Keep the running scan uninterrupted.
2. Collect independent read-only reports after artifacts appear.
3. Lead reconciles count, source snapshot, artifact, search, and resume evidence.
4. Run final local verification; report `APPROVE` or `BLOCK` with residual risks.

## Shared constraints

- All source access is read-only; never create, rename, delete, or chmod under `/Volumes/192.168.50.79`.
- Agents may read `scripts/`, local checkpoint, run metadata, and local artifacts.
- Agents do not edit production code or shared docs while the scan is running.
- Any local report must use a unique path under `work/asset-library/agent-reports/`.
- Report evidence, not only a completion claim.
- Media generation is split into four deterministic worker shards; the lead owns the shared checkpoint publication.

## Acceptance matrix

| Requirement | Verification | Status |
| --- | --- | --- |
| Source snapshot is stable and SMB remains mounted | mount/df + manifest snapshot comparison | PENDING |
| All discovered media have a record or isolated error | checkpoint/catalog count and state totals | PENDING |
| Successful records have fingerprint and technical metadata | local JSON inspection | PENDING |
| Contacts and CTA outputs are valid local JPEGs | SOI/EOI, dimensions, count, path locality | PENDING |
| Search filters return expected subsets | CLI search matrix | PENDING |
| Resume/failure evidence is preserved | checkpoint + runs metadata | PENDING |
| No SMB writes | source mount metadata and path audit | PENDING |
