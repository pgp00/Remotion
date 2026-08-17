# S5Max 示范片 02 科技质感版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 CSV 科技单品脚本生成一条带 AI 中文配音、字幕和稳定礼盒 CTA 的 24.6 秒竖屏示范片。

**Architecture:** 复用示范片 01 的一次性快速路径，不新增平台能力。只准备六个产品镜头，使用现有 Remotion Composition 渲染字幕画面，再用 FFmpeg 合入本机 TTS 人声并生成联系表。

**Tech Stack:** Remotion 4.0.496、FFmpeg/ffprobe、macOS `say`、现有 TypeScript Composition。

## Global Constraints

- `/Volumes/192.168.50.79` 只读；所有衍生文件只写仓库的 `work/`、`out/` 和 `docs/`。
- 字幕逐字来自 CSV 视频 ID `7670835392590872618`；该脚本没有可用效果数据，不得描述为数据赢家。
- 配音只做型号和数字的发音归一化。
- 输出固定为 H.264、`yuv420p`、1080×1920、30fps、AAC、24.6 秒、738 帧。
- 不加 BGM，不保留源素材音轨，不接入云端 TTS。
- CTA 首末帧必须保留可辨识产品和礼盒，不得为空桌面。
- 当前目录不是 Git 仓库；不得执行 `git init`，本计划没有 commit 步骤。

---

## Artifact Map

- Voice copy: `work/s5max-quick/scripts/demo-02-voice.txt`
- Voice asset: `work/s5max-quick/audio/demo-02-voice.m4a`
- Render props: `work/s5max-quick/demo-02.props.json`
- Proxies: `work/s5max-quick/public/proxies/d2-*.mp4` and `rotor.mp4`
- Silent render: `out/s5max-demo-02-tech.silent.mp4`
- Boss output: `out/s5max-demo-02-tech.mp4`
- Contact sheet: `work/s5max-quick/contacts/demo-02-final-cut.jpg`

### Task 1: 生成并测量 AI 配音

**Files:**

- Read: `work/s5max-quick/scripts/demo-02-voice.txt`
- Create: `work/s5max-quick/audio/demo-02-voice.m4a`

**Interfaces:**

- Consumes: 普通话发音文本、`Tingting`、语速 230
- Produces: 单声道 AAC 音轨，内容时长约 24.131 秒

- [x] **Step 1: 生成 AIFF**

```bash
say -v Tingting -r 230 -f work/s5max-quick/scripts/demo-02-voice.txt -o /tmp/s5max-demo-02-voice.aiff
```

- [x] **Step 2: 转为 AAC 并验证**

```bash
ffmpeg -nostdin -hide_banner -loglevel error -y \
  -i /tmp/s5max-demo-02-voice.aiff \
  -c:a aac -b:a 192k \
  work/s5max-quick/audio/demo-02-voice.m4a

ffprobe -v error -show_entries format=duration \
  -of default=noprint_wrappers=1:nokey=1 \
  work/s5max-quick/audio/demo-02-voice.m4a
```

Expected: 约 `24.131` 秒，且存在 AAC 音频流。

### Task 2: 准备六个短代理

**Files:**

- Create: `work/s5max-quick/public/proxies/d2-hook.mp4`
- Create: `work/s5max-quick/public/proxies/d2-charge.mp4`
- Create: `work/s5max-quick/public/proxies/d2-body.mp4`
- Reuse: `work/s5max-quick/public/proxies/rotor.mp4`
- Create: `work/s5max-quick/public/proxies/d2-water.mp4`
- Create: `work/s5max-quick/public/proxies/d2-cta.mp4`

**Interfaces:**

- Consumes: 六个 SMB 绝对路径与下表精确入点/时长
- Produces: H.264、1080×1920、30fps、无音频代理

| Proxy | SMB source | Start | Duration |
|---|---|---:|---:|
| `d2-hook.mp4` | `7.27/S5素材/产品细节及礼盒展示/机身展示/转台旋转展示机身/ycc2062.MP4` | 4.0 | 2.5 |
| `d2-charge.mp4` | `7.27/S5素材/产品细节及礼盒展示/充电口展示通电电量显示/ycc1932.MP4` | 0.5 | 5.966667 |
| `d2-body.mp4` | `7.27/S5素材/产品细节及礼盒展示/机身展示/机身扫光/ycc1970.MP4` | 0.0 | 5.3 |
| `rotor.mp4` | `7.27/S5素材/产品细节及礼盒展示/转子展示/ycc1975.MP4` | 1.0 | 5.6 |
| `d2-water.mp4` | `7.27/S5素材/产品细节及礼盒展示/防水效果/直接冲水/ycc2008.MP4` | 1.0 | 3.4 |
| `d2-cta.mp4` | `7.27/S5素材/产品细节及礼盒展示/礼盒及赠品展示/纯展示/ycc2036.MP4` | 2.0 | 5.4 |

- [x] **Step 1: 执行六个已定入点的代理命令**

```bash
make_proxy() {
  local proxy_start="$1" proxy_source="$2" proxy_duration="$3" proxy_output="$4"
  ffmpeg -nostdin -hide_banner -loglevel error -y \
    -ss "$proxy_start" -i "$proxy_source" -t "$proxy_duration" \
    -map 0:v:0 -map_metadata -1 \
    -vf "scale=w=1080:h=1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p" \
    -an -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -fps_mode cfr \
    -movflags +faststart "$proxy_output"
}

make_proxy 4.0 "/Volumes/192.168.50.79/7.27/S5素材/产品细节及礼盒展示/机身展示/转台旋转展示机身/ycc2062.MP4" 2.5 "work/s5max-quick/public/proxies/d2-hook.mp4"
make_proxy 0.5 "/Volumes/192.168.50.79/7.27/S5素材/产品细节及礼盒展示/充电口展示通电电量显示/ycc1932.MP4" 5.966667 "work/s5max-quick/public/proxies/d2-charge.mp4"
make_proxy 0.0 "/Volumes/192.168.50.79/7.27/S5素材/产品细节及礼盒展示/机身展示/机身扫光/ycc1970.MP4" 5.3 "work/s5max-quick/public/proxies/d2-body.mp4"
make_proxy 1.0 "/Volumes/192.168.50.79/7.27/S5素材/产品细节及礼盒展示/转子展示/ycc1975.MP4" 5.6 "work/s5max-quick/public/proxies/rotor.mp4"
make_proxy 1.0 "/Volumes/192.168.50.79/7.27/S5素材/产品细节及礼盒展示/防水效果/直接冲水/ycc2008.MP4" 3.4 "work/s5max-quick/public/proxies/d2-water.mp4"
make_proxy 2.0 "/Volumes/192.168.50.79/7.27/S5素材/产品细节及礼盒展示/礼盒及赠品展示/纯展示/ycc2036.MP4" 5.4 "work/s5max-quick/public/proxies/d2-cta.mp4"
```

Expected: 六个输出均非空；SMB 目录无新增文件。

### Task 3: 渲染字幕画面并合入人声

**Files:**

- Read: `work/s5max-quick/demo-02.props.json`
- Create: `out/s5max-demo-02-tech.silent.mp4`
- Create: `out/s5max-demo-02-tech.mp4`

**Interfaces:**

- Consumes: 六镜头、九条字幕、738 帧时间线和 AI 人声
- Produces: 24.6 秒老板验收版

- [x] **Step 1: 渲染画面**

```bash
./node_modules/.bin/remotion render \
  packages/remotion-video/src/index.ts ProductMarketingReal \
  out/s5max-demo-02-tech.silent.mp4 \
  --props work/s5max-quick/demo-02.props.json \
  --public-dir work/s5max-quick/public \
  --codec=h264 --pixel-format=yuv420p --color-space=bt709 \
  --audio-codec=aac --enforce-audio-track --overwrite=true
```

- [x] **Step 2: 合入 AI 配音**

```bash
ffmpeg -nostdin -hide_banner -loglevel error -y \
  -i out/s5max-demo-02-tech.silent.mp4 \
  -i work/s5max-quick/audio/demo-02-voice.m4a \
  -filter_complex "[1:a]apad[a]" -map 0:v:0 -map "[a]" \
  -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart \
  out/s5max-demo-02-tech.mp4
```

Expected: Remotion 与 FFmpeg 均退出 0；最终输出 738 帧。

### Task 4: 技术与视觉验收

**Files:**

- Create: `work/s5max-quick/contacts/demo-02-final-cut.jpg`

**Interfaces:**

- Consumes: 最终 MP4
- Produces: 媒体证据与 CTA 首末帧联系表

- [x] **Step 1: 完整解码**

```bash
ffmpeg -nostdin -v error -xerror -i out/s5max-demo-02-tech.mp4 -f null -
```

Expected: exit 0，无错误文本。

- [x] **Step 2: 核对媒体规格**

```bash
ffprobe -v error -count_frames \
  -show_entries stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,nb_read_frames,sample_rate,channels:format=duration,size \
  -of json out/s5max-demo-02-tech.mp4
```

Expected: H.264、`yuv420p`、1080×1920、30/1、738 帧、AAC、24.6 秒。

- [x] **Step 3: 核对音量**

```bash
ffmpeg -nostdin -hide_banner -i out/s5max-demo-02-tech.mp4 \
  -vn -af volumedetect -f null -
```

Expected: `mean_volume` 约 -18.6 dB，`max_volume` 约 -3.3 dB。

- [x] **Step 4: 人工/Codex 查看联系表**

Expected: 转台、电子屏、扫光、转子、冲水和礼盒 CTA 顺序正确；CTA START 与 CTA END 均有完整产品和礼盒，末帧不是空桌面。
