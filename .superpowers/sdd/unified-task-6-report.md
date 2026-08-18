# Task 6 report

## Status

DONE — unified raw-copy Skill/docs workflow implemented. No audio/video generation or heavy regression was run.

## RED baseline

Fresh retrieval/pressure scenario: “用户只给原始产品文案，指定 batch，希望立即开始；不要让用户准备 CSV、ProductionPlan 或 Timeline。”

The pre-change Skill retrieval audit reported:

```json
{"rawInput":true,"defaultSingle":false,"capacity":false,"sample":false,"approve":false,"reject":false,"history":false}
```

The new contract test was then run before changing the Skill and failed on the missing default-single rule, confirming RED.

## GREEN changes

- `SKILL.md`: replaced the old seven-step/manual-Timeline workflow with the nine-step raw-copy workflow; documents internal `category,text` CSV, source fields, single/batch defaults, capacity and 300 confirmation, SMB visual verification, local IndexTTS 2.5, sample approval gate, six commands, Remotion-only production, cross-history uniqueness, and artifact retention.
- `agents/openai.yaml`: default prompt now points to the single workflow and batch sample gate.
- `production-plan-contract.md`: defines `sourceText` as the selected current video's sentence text, not the whole copy pool.
- `scripts/skill-contract.test.mjs`: contract assertions cover the new workflow and six internal commands.
- `docs/PROJECT_PLAN.md`: documents one user workflow, six coordinator commands, and legacy `work/s5max-daily`/`out/s5max-daily` retention.

Fresh GREEN retrieval output:

```json
{"missing":[],"route":[3,2,2,2,2,3],"no_user_artifact":true,"green":true}
```

## Checks

- `node --test scripts/skill-contract.test.mjs` — PASS (1/1)
- `node --check scripts/skill-contract.test.mjs` — PASS
- `git diff --check` — PASS
- `python3 scripts/s5max-daily.py --help` — six public commands: `capacity`, `prepare`, `sample`, `approve`, `reject`, `render`
- `rg` checks — no old manual workflow tokens or user-authored CSV/JSON/ProductionPlan requirement in the Skill

## Concerns

- Real media production remains intentionally unrun; Task 7 owns the real single/batch smoke and approval gate.
- The coordinator retains a compatibility-only legacy `plan` parsing branch, but its public help and documented workflow expose only the six commands; Task 6 did not change coordinator code.
- Existing unrelated worktree changes and `work/`/`out/` artifacts were preserved.

## Commit

The final commit (`docs: unify product video production workflow`) contains only the five authorized project files and this report; its hash is reported by the agent after commit.
