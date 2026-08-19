# Agent Task Book

## Objective

把项目收敛为一条生产链：用户只提供文案，Codex 自主拆句、检索并查看 SMB 素材、组合逐句镜头，再经本地 IndexTTS 2.5 配音、Remotion 音画同步渲染和完整 QC 后，每条文案交付一个成品 MP4；迁移通过前保留全部现有产物和旧生产代码。

## Baseline

- Repository/workspace: `/Users/gilgamesharcher/repo/Remotion`
- Baseline commit or snapshot: `993567a` 加当前未提交工作树；所有 agent 必须按实际文件读取，不得重置到提交状态。
- Governing instructions: `docs/superpowers/specs/2026-08-18-local-tts-remotion-production-design.md`、Ponytail full、TDD、verification-before-completion。
- User-owned changes to preserve: 当前 `git status` 中全部修改/删除/未跟踪文件；`out/`、`work/`、SMB 内容和正式成片。
- Available concurrency: 24；实现任务顺序执行，调查与只读评审可并行。
- Session/model contract: 所有委派使用 `fork_turns=none`；执行使用 `gpt-5.6-sol/low` 或 `gpt-5.6-luna/max`；最终验收必须使用 `gpt-5.6-sol/xhigh`。
- Baseline verification: Python 16/16 通过；TypeScript 通过；Node 59/60，唯一既有失败为 Node 26/Remotion Chromium `Target.closeTarget`。

## Work graph

```text
[Lead: approved design and task book]
├── [REMOTION_SPECIALIST: exact Audio/Sequence/pause implementation, read-only]
└── [PIPELINE_SPECIALIST: minimal TTS/orchestration reuse map, read-only]
        ↓
[Lead: implementation plan and shared JSON contract]
        ↓
[CONTRACT_EXECUTOR]
        ↓
[REMOTION_EXECUTOR]
        ↓
[PIPELINE_EXECUTOR]
        ↓
[WORKFLOW_EXECUTOR]
        ↓
[Lead: real s5max-01 parity render and QC]
        ↓
[CLEANUP_EXECUTOR]
        ↓
[FINAL_REVIEWER: sol/xhigh]
```

## Role matrix

| Role | Tier | Objective | Required skills | Write ownership | Deliverable | Depends on |
| --- | --- | --- | --- | --- | --- | --- |
| PROJECT_LEAD | L | 计划、契约、集成、真实冒烟、最终裁决 | multi-agent-project-lead, writing-plans, subagent-driven-development, verification-before-completion | 计划、任务书、共享集成与最终报告 | APPROVE/BLOCK | — |
| REMOTION_SPECIALIST | S | 确认已安装 Remotion 的本地 WAV、逐句 Sequence、5 帧停顿和末帧处理方式 | ponytail | `work/agent-results/remotion-specialist.md` | API/实现建议与本地证据 | design |
| PIPELINE_SPECIALIST | S | 确认现有 TTS、素材、渲染/QC 中可复用的最短路径 | ponytail | `work/agent-results/pipeline-specialist.md` | 复用/删除地图与命令证据 | design |
| CONTRACT_EXECUTOR | E | 用 TDD 建立唯一 Props/计划校验和语音帧计算 | ponytail, test-driven-development | 实施计划指定的契约、校验及测试文件 | 代码、RED/GREEN 证据、报告 | specialists/plan |
| REMOTION_EXECUTOR | E | 用 TDD 实现本地逐句 WAV 驱动的生产 Composition | ponytail, test-driven-development | Remotion 生产组件、注册及针对性测试 | 代码、测试、报告 | contract |
| PIPELINE_EXECUTOR | E | 用 TDD 实现本地 TTS→Props→Remotion→QC 单入口 | ponytail, test-driven-development | 新生产入口、针对性 Python 测试 | 代码、测试、报告 | contract/remotion |
| WORKFLOW_EXECUTOR | E | 让 Codex 从用户原始文案自主检索、视觉确认、选片并生成内部计划 | ponytail, test-driven-development | 项目技能及最小契约测试 | 技能 diff、测试、报告 | pipeline |
| CLEANUP_EXECUTOR | E | 对照片通过后删除重复 Web、legacy TTS/渲染和 workspace 层 | ponytail, test-driven-development | 实施计划列出的删除、包配置和文档 | 精简 diff、回归证据、报告 | parity APPROVE |
| TASK_REVIEWER | R | 每任务检查规格符合性和代码质量 | ponytail, requesting-code-review | `work/agent-results/review-*.md`，源码只读 | 双重 verdict | each task |
| FINAL_REVIEWER | R | 独立全量验收功能、精简、回归和产物保护 | ponytail, requesting-code-review, verification-before-completion | `work/agent-results/final-review-sol-xhigh.md`，源码只读 | 最终 APPROVE/BLOCK | all integration |

## Shared constraints

- Preserve unrelated user changes and every existing `out/`/`work/` artifact.
- Do not use destructive Git operations; do not commit, stash, reset, checkout, clean, push, or create a PR.
- SMB is read-only; all generated files remain local.
- IndexTTS 2.5 is the only voice engine; no Edge TTS, macOS `say`, URL, API, or silent fallback.
- Remotion is the only final video renderer; FFmpeg/ffprobe are limited to preparation, probing, decode checks, and QC.
- One copy maps to one final MP4; no fixed count of 30 and no text omission or duration-driven truncation.
- The user's only required input is raw copy; agents must not ask the user to prepare shot mappings, timelines, production plans, or JSON.
- Codex must search the local catalog, inspect candidate contact sheets, and create the auditable internal plan itself.
- New behavior follows RED → GREEN → refactor with recorded commands.
- Only the lead modifies plans, task book, shared status, or files outside an agent's ownership.
- Implementation agents run sequentially in fresh sessions; reviewers never modify source.
- Every agent reports files, commands, raw results, acceptance evidence, concerns, and stop conditions.

## Role briefs

### REMOTION_SPECIALIST

- Role and tier: Remotion domain specialist, Tier S.
- Objective: Produce the exact minimal component pattern for sentence-local WAV playback, subtitle timing, moving video during speech, and a deterministic 5-frame visual pause.
- Context: Installed Remotion is `4.0.496`; existing components use `Sequence`, `OffthreadVideo`, `staticFile`, and `SubtitleLayer`.
- Required skills: `ponytail`; read its `SKILL.md` completely before work.
- May read: `package.json`, installed Remotion declarations/source, `packages/remotion-video/src/**`, relevant tests and approved design.
- May write: only `work/agent-results/remotion-specialist.md`.
- Must do: verify exports and semantics from local installed code; compare continuing video versus freezing last frame; recommend one minimal pattern; name exact test seams.
- Must not do: edit source, install anything, browse, render final media, or redefine requirements.
- Deliverables: report with inspected paths, exact imports/pseudocode, risks, and local evidence commands.
- Acceptance: another executor can implement without guessing Remotion APIs or frame coordinate semantics.
- Stop conditions: installed types/source do not expose a deterministic supported pattern.

### PIPELINE_SPECIALIST

- Role and tier: local pipeline specialist, Tier S.
- Objective: Identify the shortest reuse path from production-plan JSON through existing IndexTTS 2.5 worker to Remotion props and existing QC.
- Context: `scripts/indextts25-batch.py` is validated locally; existing JS auto-edit and Python S5Max scripts overlap and the accepted final batch was FFmpeg-based.
- Required skills: `ponytail`; read its `SKILL.md` completely before work.
- May read: `scripts/**`, package files, approved design, manifests and one accepted S5Max plan.
- May write: only `work/agent-results/pipeline-specialist.md`.
- Must do: trace exact callable functions, path/public-dir requirements, injected seams for tests, and deletion candidates; recommend Python or Node entry based on least code.
- Must not do: edit source, install anything, run TTS, render media, or propose remote services.
- Deliverables: report with reuse map, proposed CLI, file ownership, test seams, and commands inspected.
- Acceptance: lead can write an implementation plan with no duplicate orchestration or speculative layers.
- Stop conditions: required behavior cannot be expressed using installed tools and existing local worker.

### CONTRACT_EXECUTOR

- Role and tier: mechanical contract executor, Tier E.
- Objective: Implement the plan's single JSON/Props contract and exact voice-frame/pause validation with TDD.
- Context: consumes specialist reports and its extracted plan task brief.
- Required skills: `ponytail`, `test-driven-development`; read both completely before work.
- May read: approved design, task brief, relevant shared/core/Remotion types and tests.
- May write: only files named in its plan task and `work/agent-results/task-contract-report.md`.
- Must do: record expected RED failure before production changes; implement minimum; record GREEN tests and self-review.
- Must not do: change rendering, TTS execution, package structure, docs, or Git state.
- Deliverables: source/test diff and report.
- Acceptance: all contract edge cases in the task brief pass and existing typecheck remains green.
- Stop conditions: task brief conflicts with approved design or owned files contain unexpected concurrent edits.

### REMOTION_EXECUTOR

- Role and tier: Remotion implementation executor, Tier E.
- Objective: Implement and register the production Composition using local sentence WAVs and exact frame ranges.
- Context: consumes approved contract and Remotion specialist report.
- Required skills: `ponytail`, `test-driven-development`; read both completely before work.
- May read: contract files, specialist report, existing Remotion source/tests.
- May write: only files named in its plan task and `work/agent-results/task-remotion-report.md`.
- Must do: RED/GREEN tests; muted product shots; local audio only; subtitle visibility limited to voice frames; deterministic 5-frame pause behavior.
- Must not do: add visual features, edit orchestrator, delete legacy code, install dependencies, or touch artifacts.
- Deliverables: source/test diff and report.
- Acceptance: targeted tests and typecheck pass; invalid props fail loudly.
- Stop conditions: contract is incomplete or local Remotion API cannot satisfy the specified frame behavior.

### PIPELINE_EXECUTOR

- Role and tier: local production pipeline executor, Tier E.
- Objective: Implement one local entry from validated plan to cached IndexTTS 2.5, measured WAVs, Remotion props/render, manifest, and QC.
- Context: consumes approved contract, Composition ID, and pipeline specialist report.
- Required skills: `ponytail`, `test-driven-development`; read both completely before work.
- May read: approved interfaces and existing TTS/QC helpers.
- May write: only files named in its plan task and `work/agent-results/task-pipeline-report.md`.
- Must do: use stdlib/existing dependencies; reject URLs; never overwrite output; record RED/GREEN; provide injectable command seams; preserve partial-file safety.
- Must not do: call remote TTS, modify Remotion UI, delete legacy files, touch SMB, run full real model, or commit.
- Deliverables: source/test diff and report.
- Acceptance: targeted tests cover text completeness, arbitrary batch count, local path safety, cache mapping, Remotion invocation, and QC failure.
- Stop conditions: orchestration requires a new dependency or contract change not approved by lead.

### CLEANUP_EXECUTOR

- Role and tier: mechanical cleanup executor, Tier E.
- Objective: After parity APPROVE, remove only superseded source/docs/packages and leave one production path.
- Context: real `s5max-01` Remotion + IndexTTS 2.5 parity evidence must exist first.
- Required skills: `ponytail`, `test-driven-development`; read both completely before work.
- May read: repository and parity report.
- May write: only cleanup files named in its plan task and `work/agent-results/task-cleanup-report.md`.
- Must do: prove references are gone; update lockfile without adding dependencies; run targeted and full regressions; report net files/lines/dependencies removed.
- Must not do: delete artifacts, asset-library code, accepted outputs, new production path, or use destructive Git commands.
- Deliverables: deletion/config/doc diff and report.
- Acceptance: one renderer, one local TTS path, no remote voice fallback, no dead imports, package/typecheck/tests pass subject only to recorded Node 26 baseline.
- Stop conditions: parity is not approved or any deletion target still has a live caller.

### WORKFLOW_EXECUTOR

- Role and tier: autonomous workflow executor, Tier E.
- Objective: Make the project skill accept raw user copy and direct Codex through autonomous product identification, sentence splitting, local catalog search, contact-sheet inspection, shot choice, internal plan creation, and production execution.
- Context: the internal JSON contract is an audit artifact, never a user input requirement.
- Required skills: `ponytail`, `test-driven-development`; read both completely before work.
- May read: approved design, production contract/CLI, asset-library CLI/skill and existing project skill.
- May write: only files named in its plan task and `work/agent-results/task-workflow-report.md`.
- Must do: define exact stop conditions for missing/mismatched product material; require visual confirmation instead of filename guesses; leave deterministic scripts responsible only for validation/execution.
- Must not do: add an AI service, vector database, web UI, remote lookup, or ask the user for a plan/shot map.
- Deliverables: project skill change, smallest runnable contract check, and report.
- Acceptance: starting from only copy plus already configured local assets/voice, the documented agent workflow reaches an internal plan and production command without an extra user-authored artifact.
- Stop conditions: catalog or contact sheets are absent, or product identity cannot be established from copy and current conversation.

### TASK_REVIEWER

- Role and tier: independent task reviewer, Tier R.
- Objective: Issue separate spec-compliance and code-quality verdicts for one completed task.
- Required skills: `ponytail`, `requesting-code-review`; read both completely before work.
- May read: task brief, task report, owned files/diff, approved design.
- May write: only its unique `work/agent-results/review-*.md`.
- Must do: identify Critical/Important/Minor findings with file/line evidence; verify TDD evidence exists; distinguish existing Node 26 baseline.
- Must not do: edit source, waive requirements, or broaden the task.
- Acceptance: both verdicts are explicit; Critical/Important findings block progression.
- Stop conditions: missing task report or missing diff/evidence.

### FINAL_REVIEWER

- Role and tier: independent final reviewer, Tier R, `gpt-5.6-sol` with `xhigh` reasoning.
- Objective: Audit the integrated workspace and issue final APPROVE/BLOCK against the approved design and acceptance matrix.
- Required skills: `ponytail`, `requesting-code-review`, `verification-before-completion`; read all completely before work.
- May read: entire workspace, plans, reports, test results, new smoke output and manifests.
- May write: only `work/agent-results/final-review-sol-xhigh.md`.
- Must do: inspect actual code and evidence; verify artifacts preserved; check no remote TTS or duplicate final renderer remains; map every requirement to evidence.
- Must not do: modify source, accept agent summaries without inspection, commit, push, or delete.
- Deliverables: findings-first report and explicit APPROVE/BLOCK.
- Acceptance: independent release verdict with exact commands/results and residual risks.
- Stop conditions: required real render/QC evidence is absent.

## Integration order

1. Lead validates task book and collects both specialist reports.
2. Lead writes and self-reviews the implementation plan and shared contract.
3. Contract executor implements; task reviewer approves.
4. Remotion executor implements; task reviewer approves.
5. Pipeline executor implements; task reviewer approves.
6. Workflow executor implements autonomous copy-to-plan behavior; task reviewer approves.
7. Lead runs real `s5max-01` local TTS 2.5 + Remotion parity render and QC starting from its raw copy.
8. Cleanup executor runs only after parity APPROVE; task reviewer approves.
9. Lead runs complete regression and duplicate-path scans.
10. Final reviewer (`sol/xhigh`) issues the independent final verdict.

## Acceptance matrix

| Requirement | Owner | Verification | Evidence | Status |
| --- | --- | --- | --- | --- |
| Every source sentence has one local IndexTTS 2.5 WAV | PIPELINE_EXECUTOR | plan/manifest count, WAV validation, no URL | pipeline report + manifest | PENDING |
| Voice duration drives exact frames and 5-frame inter-sentence pauses | CONTRACT_EXECUTOR | unit tests and manifest arithmetic | contract report | PENDING |
| Remotion renders video, local audio, and voice-scoped subtitles | REMOTION_EXECUTOR | component tests, compositions/render evidence | Remotion report | PENDING |
| Each sentence maps to an SMB-derived product shot | PROJECT_LEAD | `s5max-01` plan/contact-sheet review | parity report | PENDING |
| User supplies only copy; Codex creates the internal shot plan autonomously | WORKFLOW_EXECUTOR | skill contract review and raw-copy parity run | workflow + parity reports | PENDING |
| Final output meets H.264/AAC/1080×1920/30fps and decodes fully | PROJECT_LEAD | ffprobe + FFmpeg null decode | parity report | PENDING |
| Existing artifacts remain unchanged | PROJECT_LEAD | before/after inventory and hashes for accepted outputs | integration report | PENDING |
| Web/legacy remote voice/duplicate renderer are removed only after parity | CLEANUP_EXECUTOR | reference scan, git diff, package inspection | cleanup report | PENDING |
| Full regressions pass except any explicitly proven pre-existing Node 26 defect | PROJECT_LEAD | Python, Node, typecheck, build/render checks | integration report | PENDING |
| Independent final approval | FINAL_REVIEWER | whole-workspace audit using `sol/xhigh` | final review report | PENDING |
