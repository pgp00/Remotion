# 本地短视频自动生产

把一份产品原始文案自动组合成单条或批量短视频。系统内部完成拆句、分类、组合、配镜头、语音、时间线和渲染；操作员不需要手写 ProductionPlan、Timeline 或镜头表。

生产链固定为：

```text
原始文案 → 自主组合 → 本地 IndexTTS 2.5 → SMB 镜头 → Remotion → MP4
```

## 这是什么

- `single`：每次随机组合 1 条视频并直接渲染。
- `batch`：默认准备 300 条 meaningful unique 视频，先生成 1 条样片，批准后才渲染其余视频。
- unique 同时检查文案组合、规范化全文和有序镜头序列；改变裁切点不能伪装成新视频。
- 只使用本地 IndexTTS 2.5、本地挂载的 SMB 素材和 Remotion，不使用远程 TTS 或网络素材兜底。

## 项目结构

```text
scripts/s5max-daily.py             六命令生产协调器
scripts/indextts25-batch.py        本地 IndexTTS 2.5 逐句语音与缓存
scripts/produce.mjs                单条视频生产内核
packages/remotion-video/           Remotion Composition 与逐句音画时间线
skills/auto-edit-product-video/    Codex 操作规范
work/asset-library/                SMB 素材目录和代理文件
work/indextts25/cache/             内容寻址的逐句 WAV 缓存
work/production-batches/<批次>/    批次文案、计划、manifest 和审计材料
work/production/<视频 ID>/         单条生产过程和 QC 记录
out/production-batches/<批次>/     正式 MP4
```

不要清空或覆盖 `work/`、`out/`。它们同时承担缓存、历史唯一性、审计和断点恢复。

## 开始前检查

在仓库根目录执行：

```bash
node --version
python3 --version
npm install
python3 scripts/s5max-daily.py --help

test -f work/s5max-30-unique/smb-expanded-materials.json
test -f work/asset-library/catalog.json
test -f work/indextts2-s5max/voice_03.wav
test -d work/indextts25/index-tts/checkpoints
test -x work/indextts25/index-tts/.venv/bin/python
```

要求：

- Node.js 20 或更高版本。
- SMB 已挂载，`catalog.json` 中的素材路径在本机可读取。
- IndexTTS 2.5 模型、虚拟环境和参考音色均在本地。
- 默认使用 Apple Silicon `mps`；没有 MPS 时给 `prepare` 增加 `--device cpu`。

默认路径：

| 用途 | 路径 |
|---|---|
| SMB 镜头选择 | `work/s5max-30-unique/smb-expanded-materials.json` |
| 素材目录 | `work/asset-library/catalog.json` |
| 参考音色 | `work/indextts2-s5max/voice_03.wav` |
| IndexTTS 2.5 模型 | `work/indextts25/index-tts/checkpoints` |
| IndexTTS Python | `work/indextts25/index-tts/.venv/bin/python` |
| 工作区 | 当前仓库 |

路径不同时，用对应的 `--materials`、`--catalog`、`--voice`、`--model-dir`、`--python` 或 `--workspace` 覆盖。

## 先准备输入

人只需提交原始文案和模式。例如交给 Codex：

```text
模式：batch
目标：300
原始文案：
（粘贴完整文案）
```

Codex 会在内部生成两个机器输入：

- `source-copy.txt`：原始文案快照。
- `copy-pool.csv`：拆句、分类和规范化后的文案池。

CLI 需要同时接收这两个文件，但 `copy-pool.csv` 不是第二份人工输入。其格式为 `category,text`；类别只允许 `hook`、`shave`、`blade`、`power`、`water`、`charge`、`appearance`、`scene`、`cta`。必须有 hook、CTA，以及至少四类卖点/场景。

下文假设文件位于：

```text
work/operator-input/source-copy.txt
work/operator-input/copy-pool.csv
```

## 最短操作流程

```text
单条：prepare(single) → render
批量：capacity → prepare(batch) → sample → approve → render
                                      └→ reject（样片不通过）
```

每个成功命令都会向标准输出打印一行 JSON。失败时标准错误以 `error:` 开头，并以非零状态退出。

## 单条模式

每个新批次只随机一次；同一个批次重试时保持原组合。

```bash
BATCH_ID="single-$(date +%Y%m%d-%H%M%S)"
MANIFEST="work/production-batches/$BATCH_ID/manifest.json"

python3 scripts/s5max-daily.py prepare \
  --mode single \
  --batch-id "$BATCH_ID" \
  --source-copy work/operator-input/source-copy.txt \
  --copy-csv work/operator-input/copy-pool.csv

python3 scripts/s5max-daily.py render --manifest "$MANIFEST"
```

正式视频位于：

```text
out/production-batches/<批次 ID>/
```

## 批量模式（默认 300 条）

### 1. 检查容量、时间和磁盘

```bash
python3 scripts/s5max-daily.py capacity \
  --copy-csv work/operator-input/copy-pool.csv \
  --count 300
```

只有 JSON 中 `canProduce` 为 `true` 时才继续。输出同时包含预计 TTS、代理、渲染时间和磁盘空间。容量不足时先补充文案或合格 SMB 镜头；不能改用网络素材凑数。

### 2. 准备并封存批次

`prepare` 会一次加载本地 IndexTTS 2.5，生成或复用逐句 WAV，再按真实 WAV 时长确定 Remotion 时间线。

```bash
BATCH_ID="batch-$(date +%Y%m%d-%H%M%S)"
MANIFEST="work/production-batches/$BATCH_ID/manifest.json"

python3 scripts/s5max-daily.py prepare \
  --mode batch \
  --count 300 \
  --batch-id "$BATCH_ID" \
  --source-copy work/operator-input/source-copy.txt \
  --copy-csv work/operator-input/copy-pool.csv
```

省略 `--count` 时，batch 仍默认为 300。

### 3. 只生成一条样片

```bash
python3 scripts/s5max-daily.py sample --manifest "$MANIFEST"
```

命令返回 `sampleId`。只检查对应的正式 MP4，重点确认：

- 文案与镜头逐句对应。
- 语音完整，无截断、拉伸或静音替代。
- 非末句停顿为 5 帧，字幕只在本句语音期间显示。
- 产品、画质、裁切和节奏符合要求。

### 4A. 样片通过

```bash
python3 scripts/s5max-daily.py approve --manifest "$MANIFEST"
python3 scripts/s5max-daily.py render --manifest "$MANIFEST" --jobs 1
```

`render` 在 batch 模式下必须经过 `approve`。第一次建议保持 `--jobs 1`；本机资源确认稳定后再提高并发。

### 4B. 样片不通过

```bash
python3 scripts/s5max-daily.py reject \
  --manifest "$MANIFEST" \
  --reason "镜头与第二句卖点不匹配"
```

整个批次会归档并释放预留的唯一性签名。保留归档证据，根据反馈准备一个新的批次 ID；不要在旧 manifest 上手改组合。

## 六个命令

| 命令 | 用途 | 关键输入 |
|---|---|---|
| `capacity` | 在昂贵工作前检查唯一组合容量、时间和磁盘 | `--copy-csv`，可选 `--count`、`--jobs` |
| `prepare` | 组合文案、选择 SMB 镜头、预热 TTS、写入并封存批次 | `--mode`、`--source-copy`、`--copy-csv` |
| `sample` | batch 只渲染一条代表性样片 | `--manifest` |
| `approve` | 确认已经核验的样片 | `--manifest` |
| `reject` | 归档未进入正式批量渲染的批次 | `--manifest`、`--reason` |
| `render` | single 渲染一条；batch 在批准后渲染剩余条目 | `--manifest`，可选 `--jobs` |

查看准确参数：

```bash
python3 scripts/s5max-daily.py --help
python3 scripts/s5max-daily.py prepare --help
```

其他命令同样支持 `--help`。

## 审批、拒绝与断点恢复

- `prepare` 中断且尚未生成 manifest：使用相同的 `--batch-id`、输入和参数重新执行，系统复用草稿与 TTS 缓存。
- `sample` 中断：对同一个 manifest 再执行 `sample`。
- 已批准的 `render` 中断：对同一个 manifest 再执行 `render`；已验证的视频会跳过，异常输出会移入批次的 `retries/` 后重做。
- 命令提示批次已经处于某个状态时，不要再次 `prepare`；按状态继续 `sample`、`approve`、`reject` 或 `render`。
- 不要手工改 manifest 状态，不要删除已验证的正式 MP4 来“重新开始”。

## 目录与产物

一个批次的主要文件：

```text
work/production-batches/<批次 ID>/
├── source-copy.txt
├── copy-pool.csv
├── draft-plan.json
├── scripts.json
├── material-matrix.json
├── tts-prewarm.jsonl
├── tts-prewarm-manifest.json
├── plans/
├── retries/                 仅失败恢复时出现
└── manifest.json            后续命令的唯一状态入口

out/production-batches/<批次 ID>/
└── *.mp4                    正式成片
```

逐句 WAV 缓存在 `work/indextts25/cache/`，重复文案会复用；单条生产证据位于 `work/production/<视频 ID>/`。这些目录都必须保留。

## 常见问题

| 现象 | 处理 |
|---|---|
| `canProduce: false` | 查看 `missing`；补充对应类别文案或经人工视觉核验的 SMB 镜头后重新检查容量。 |
| `CSV must contain category,text columns` | 让 Codex 重新生成 UTF-8 CSV，首行必须是 `category,text`。 |
| `copy pool needs at least four...` | 补充至少四种卖点/场景类别，不能复制同一句凑数量。 |
| 找不到 voice、model 或 Python | 检查默认路径，或显式传入 `--voice`、`--model-dir`、`--python`。 |
| catalog 缺素材或镜头时长不足 | 修复 SMB 挂载并更新本地素材 catalog/selection；不要切换网络素材。 |
| `batch ... is already in state ...` | 该批次已准备；读取 manifest 并继续相应的后续命令。 |
| `a verified sample is required before approval` | 先成功执行 `sample`，确认样片文件仍存在且生产 manifest 完整。 |
| batch render 要求批准 | 先人工看样片，再执行 `approve`。 |
| Remotion/Chromium 启动失败 | 检查本机 Remotion 浏览器依赖和权限后重跑同一命令；不要删除批次状态。 |
| 渲染中断或部分失败 | 对同一 manifest 重跑 `render`，让系统按文件事实和 QC 记录恢复。 |

SMB 素材目录需要更新时，让 Codex 使用项目现有的 `asset-library scan/search` 流程重新扫描和人工核验，不要手工伪造 catalog 记录。

## 硬边界

- 人的必需输入只有原始文案；CSV、组合、ProductionPlan、Timeline 和镜头表由系统生成。
- SMB 是必须的数据源，不使用网络素材回退。
- TTS 必须在本地通过 IndexTTS 2.5 生成；每批一次模型加载，逐句缓存。
- 最终 MP4 只能由 Remotion 生产；逐句语音、停顿、字幕和镜头按 30fps 帧时钟对齐。
- 非末句恰好停顿 5 帧，末句不追加停顿；语音期间不得靠冻结画面补时长。
- 批量默认 300 条并保持 meaningful unique；样片未批准前不得渲染其余条目。
- 所有历史成片、缓存、QC、重试和归档材料必须保留。
