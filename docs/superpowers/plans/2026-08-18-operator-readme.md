# Operator README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a root `README.md` that lets an operator run the raw-copy-to-local-Remotion workflow without reading source code.

**Architecture:** Keep one operator-first document and one public command surface. The README derives every command and default from `scripts/s5max-daily.py`; it links to design material only as optional background.

**Tech Stack:** Markdown, Python `argparse`, Node.js/npm, local IndexTTS 2.5, SMB asset catalog, Remotion.

## Global Constraints

- The user supplies raw copy; the system creates copy classification, combinations, ProductionPlan, Timeline, and shot assignments.
- `single` creates one random combination; `batch` defaults to 300 meaningful unique combinations.
- SMB footage, local IndexTTS 2.5, and Remotion final encoding are mandatory.
- Batch rendering stops after one sample until `approve`; `reject` archives the batch.
- Existing `work/` and `out/` artifacts must be preserved.
- Do not document remote TTS, network footage fallback, or a second production workflow.

---

### Task 1: Write and verify the operator README

**Files:**
- Create: `README.md`
- Read: `scripts/s5max-daily.py`
- Read: `skills/auto-edit-product-video/SKILL.md`

**Interfaces:**
- Consumes: `python3 scripts/s5max-daily.py {capacity,prepare,sample,approve,reject,render}`.
- Produces: one operator guide whose examples use `work/production-batches/<batchId>/manifest.json` and `out/production-batches/<batchId>/`.

- [ ] **Step 1: Record the documentation RED**

Run:

```bash
test -f README.md
```

Expected: exit 1 because the root README does not exist.

- [ ] **Step 2: Create the minimal README**

Write these sections in this order:

```markdown
# 本地短视频自动生产
## 这是什么
## 开始前检查
## 先准备两个输入文件
## 最短操作流程
## 单条模式
## 批量模式（默认 300 条）
## 六个命令
## 审批、拒绝与断点恢复
## 目录与产物
## 常见问题
## 硬边界
```

Use the current defaults exactly:

```text
materials: work/s5max-30-unique/smb-expanded-materials.json
catalog: work/asset-library/catalog.json
voice: work/indextts2-s5max/voice_03.wav
model: work/indextts25/index-tts/checkpoints
python: work/indextts25/index-tts/.venv/bin/python
workspace: current repository
```

The quick-start examples must invoke only:

```bash
python3 scripts/s5max-daily.py capacity --copy-csv <copy.csv>
python3 scripts/s5max-daily.py prepare --mode single --source-copy <source.txt> --copy-csv <copy.csv>
python3 scripts/s5max-daily.py prepare --mode batch --source-copy <source.txt> --copy-csv <copy.csv> --count 300
python3 scripts/s5max-daily.py sample --manifest <manifest.json>
python3 scripts/s5max-daily.py approve --manifest <manifest.json>
python3 scripts/s5max-daily.py reject --manifest <manifest.json> --reason <reason>
python3 scripts/s5max-daily.py render --manifest <manifest.json>
```

- [ ] **Step 3: Verify the command surface and required operator contracts**

Run:

```bash
python3 scripts/s5max-daily.py --help
for command in capacity prepare sample approve reject render; do python3 scripts/s5max-daily.py "$command" --help; done
rg -n "single|batch|300|meaningful|unique|SMB|IndexTTS 2.5|Remotion|sample|approve|reject|render|work/production-batches|out/production-batches" README.md
```

Expected: all six CLI help commands exit 0; every required contract appears in the README.

- [ ] **Step 4: Check readability and repository hygiene**

Run:

```bash
rg -n "TBD|TODO|ProductionPlan.*用户|Timeline.*用户|远程 TTS|网络素材回退" README.md
git diff --check -- README.md
```

Expected: the first command has no matches; `git diff --check` exits 0.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: add operator production guide"
```
