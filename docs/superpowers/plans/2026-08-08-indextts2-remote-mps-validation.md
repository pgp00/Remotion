# IndexTTS2 远端 MPS 验证 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在远端 M4 16GB Mac mini 上验证 IndexTTS2 能否通过 MPS 在 5 分钟内生成约 30 秒中文广告口播。

**Architecture:** 所有安装、模型、日志和输出放在远端 `~/index-tts-validation/`。使用官方 CLI 串行执行环境检查、短句验证和长文案验证，不接入当前 Remotion 项目。

**Tech Stack:** macOS 26.4、Apple MPS、Python 3.10、`uv`、IndexTTS2 CLI、`afinfo`。

## Global Constraints

- 不生成视频，不修改 Remotion 源码或现有成片。
- 只使用官方 IndexTTS2 源码、模型和示例音色。
- 不安装 WebUI、DeepSpeed、Flash Attention、Docker 或 `torch.compile`。
- 推理设备显式固定为 `mps`，不得静默回退到 CPU。
- MPS 失败最多重试一次；不得通过删除远端既有数据来恢复。

---

### Task 1: 建立隔离环境并检查 MPS

**Files:**

- Create: remote `~/index-tts-validation/`
- Create: remote `~/index-tts-validation/logs/`
- Create: remote `~/index-tts-validation/outputs/`

**Interfaces:**

- Consumes: `fang@192.168.77.2` SSH 登录和远端网络。
- Produces: 可运行的官方 `indextts2` CLI，以及 `check` 日志。

- [x] **Step 1: 创建隔离目录并记录初始状态**

Run remotely:

```bash
mkdir -p "$HOME/index-tts-validation/logs" "$HOME/index-tts-validation/outputs" "$HOME/index-tts-validation/bin"
system_profiler SPHardwareDataType
df -h "$HOME/index-tts-validation"
```

Expected: Apple M4、16GB；目标卷有至少 30GB 可用空间。

- [x] **Step 2: 安装独立 `uv` 二进制**

Run remotely from `~/index-tts-validation`:

```bash
curl -fL https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz -o uv.tar.gz
tar -xzf uv.tar.gz
cp uv-aarch64-apple-darwin/uv bin/uv
bin/uv --version
```

Expected: `uv` 打印版本并退出 0；不写 Homebrew 或系统 Python。

- [x] **Step 3: 下载官方源码并安装基础 CLI**

Run remotely from `~/index-tts-validation`:

```bash
curl -fL https://github.com/index-tts/index-tts/archive/refs/heads/main.tar.gz -o index-tts-main.tar.gz
tar -xzf index-tts-main.tar.gz
bin/uv tool install --python 3.10 ./index-tts-main
```

Expected: 用户级 `indextts2` CLI 安装成功；未请求任何可选 extra。

- [x] **Step 4: 下载官方模型和检查设备**

Run remotely:

```bash
"$HOME/.local/bin/indextts2" download --source modelscope --model-dir "$HOME/index-tts-validation/checkpoints"
"$HOME/.local/bin/indextts2" check --device mps > "$HOME/index-tts-validation/logs/check.log" 2>&1
```

Expected: 必需模型资源、Python 包检查通过，并明确输出 `mps: available`。

### Task 2: 生成并验证两个示例

**Files:**

- Create: remote `~/index-tts-validation/outputs/short.wav`
- Create: remote `~/index-tts-validation/outputs/ad-30s.wav`
- Create: remote `~/index-tts-validation/logs/short.log`
- Create: remote `~/index-tts-validation/logs/ad-30s.log`

**Interfaces:**

- Consumes: 官方 `examples/voice_01.wav` 和已通过检查的 MPS 环境。
- Produces: 两份 WAV、推理日志和耗时证据。

- [x] **Step 1: 确认官方示例音色已下载**

Run remotely from `~/index-tts-validation/index-tts-main`:

```bash
"$HOME/index-tts-validation/bin/uv" run python -c 'from indextts.utils.examples_downloader import ensure_examples_available; ensure_examples_available()'
afinfo examples/voice_01.wav
```

Expected: `examples/voice_01.wav` 存在且 `afinfo` 能读取。

- [x] **Step 2: 生成短句并记录耗时**

Run remotely from `~/index-tts-validation/index-tts-main`:

```bash
/usr/bin/time -p "$HOME/.local/bin/indextts2" synth --device mps --text "这款剃须刀动力充足，贴面顺滑，日常清洁也更省心。" --voice examples/voice_01.wav --output "$HOME/index-tts-validation/outputs/short.wav" > "$HOME/index-tts-validation/logs/short.log" 2>&1
```

Expected: 退出 0，输出 `Generated:`；不存在设备回退或 OOM。

- [x] **Step 3: 验证短句 WAV**

Run remotely:

```bash
afinfo "$HOME/index-tts-validation/outputs/short.wav"
```

Expected: 文件为非零时长的有效 WAV。

- [x] **Step 4: 生成约 30 秒广告文案并记录耗时**

Run remotely from `~/index-tts-validation/index-tts-main`:

```bash
/usr/bin/time -p "$HOME/.local/bin/indextts2" synth --device mps --text "买剃须刀，重点看刀头、电机和防水表现。浮动刀头贴合面部轮廓，处理下巴和嘴角更顺手。高速电机带来稳定动力，胡须浓密也能从容应对。机身支持水洗，使用后直接冲洗，日常打理更轻松。大容量电池满足通勤和旅行需求，随时保持清爽状态。" --voice examples/voice_01.wav --output "$HOME/index-tts-validation/outputs/ad-30s.wav" > "$HOME/index-tts-validation/logs/ad-30s.log" 2>&1
```

Expected: 退出 0，端到端 `real` 时间不超过 300 秒。

- [x] **Step 5: 最终验证**

Run remotely:

```bash
afinfo "$HOME/index-tts-validation/outputs/ad-30s.wav"
ls -lh "$HOME/index-tts-validation/outputs/short.wav" "$HOME/index-tts-validation/outputs/ad-30s.wav"
```

Expected: 两个文件均非空且可解析；长文案 WAV 的音频时长接近 30 秒。

### Task 3: 对照成功标准并保留结果

**Files:**

- Read: remote `~/index-tts-validation/logs/*.log`
- Read: remote `~/index-tts-validation/outputs/*.wav`

**Interfaces:**

- Consumes: Task 1–2 的检查、耗时和音频证据。
- Produces: 远端可行、性能不达标或 MPS/内存阻断三者之一的明确结论。

- [x] **Step 1: 核对设备、错误和耗时**

Run remotely:

```bash
grep -E "mps: available|Generated:|Total inference time|Generated audio length|RTF|real " "$HOME/index-tts-validation/logs/"*.log
```

Expected: MPS 可用、两次生成成功；长文案端到端耗时不超过 300 秒。

- [x] **Step 2: 报告人工试听边界**

报告两份 WAV 的路径、时长、耗时和错误状态。机器验证不冒充人工自然度结论；漏字/重复、停顿、重音、语气连贯和机器感由用户试听确认。
