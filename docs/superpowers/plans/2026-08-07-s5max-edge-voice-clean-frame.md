# S5Max Edge 配音与纯净画面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Microsoft Edge 中文神经男声重做两条 S5Max 配音，并移除模板全部角落叠加层。

**Architecture:** 复用现有代理、时间线和静音渲染路径。六句配音逐段生成并贴合原镜头时长；画面层仅保留正文字幕，再重新渲染和合入音轨。

**Tech Stack:** Remotion 4.0.496、FFmpeg/ffprobe、`uvx`、`edge-tts`、TypeScript。

## Global Constraints

- SMB 素材只读；只写仓库 `work/`、`out/` 和 `docs/`。
- 声音固定为 `zh-CN-YunxiNeural`；不增加持久 Python 依赖。
- 移除模板角标，保留正文字幕和素材内产品 Logo。
- 两条输出分别保持 28.5 秒/855 帧与 24.6 秒/738 帧。
- 当前目录不是 Git 仓库，不执行 commit。

---

### Task 1: 移除角落叠加层

**Files:**

- Modify: `packages/remotion-video/src/product-marketing-video.tsx`

**Interfaces:**

- Consumes: `Timeline.subtitles`、`Timeline.brand`
- Produces: 只含 `SubtitleLayer` 的 `ProductMarketingChrome`

- [x] **Step 1: 验证当前源码仍含角标**

```bash
rg -n 'BrandBadge|timeline\.productSku|timeline\.cta' packages/remotion-video/src/product-marketing-video.tsx
```

Expected: 找到左上品牌与底部两项角标。

- [x] **Step 2: 将 `ProductMarketingChrome` 缩减为正文字幕层**

```tsx
export const ProductMarketingChrome = ({timeline}: {timeline: Timeline}) => (
  <SubtitleLayer cues={timeline.subtitles} brand={timeline.brand} />
);
```

- [x] **Step 3: 验证角标已消失且类型检查通过**

```bash
! rg -n 'BrandBadge|timeline\.productSku|timeline\.cta' packages/remotion-video/src/product-marketing-video.tsx
npm run typecheck
```

Expected: 搜索退出 1；TypeScript 退出 0。

### Task 2: 生成并贴合 Edge TTS 配音

**Files:**

- Read: `work/s5max-quick/scripts/demo-01-voice.txt`
- Read: `work/s5max-quick/scripts/demo-02-voice.txt`
- Create: `work/s5max-quick/audio/edge/`
- Replace: `work/s5max-quick/audio/demo-01-voice.m4a`
- Replace: `work/s5max-quick/audio/demo-02-voice.m4a`

**Interfaces:**

- Consumes: 两份六行中文配音文案与原六段时长
- Produces: 与现有时间线贴合的 AAC 单声道人声

- [x] **Step 1: 用 `edge-tts` 逐句生成 `zh-CN-YunxiNeural` 音频**

```bash
uvx --from edge-tts edge-tts --voice zh-CN-YunxiNeural --rate=+8% --text "买剃须刀就看三点，刀头、电机和防水" --write-media work/s5max-quick/audio/edge/demo-01-01.mp3
```

Expected: 十二句均生成 MP3/SRT；充电句口播使用已验证的同义文本“接口快充，大容量电池长续航，出门旅行更放心”。

- [x] **Step 2: 用 FFmpeg 将每句贴合对应镜头时长并串接**

```bash
ffmpeg -nostdin -hide_banner -loglevel error -y -i work/s5max-quick/audio/edge/demo-01-01.mp3 -af "apad,atrim=duration=3.526" work/s5max-quick/audio/edge/demo-01-01.m4a
```

Expected: 十二段音频分别与计划镜头时长一致，串接后生成两份 `demo-*-voice.m4a`。

### Task 3: 重渲染并验收

**Files:**

- Replace: `out/s5max-demo-01-data.silent.mp4`
- Replace: `out/s5max-demo-02-tech.silent.mp4`
- Replace: `out/s5max-demo-01-data.mp4`
- Replace: `out/s5max-demo-02-tech.mp4`
- Replace: `work/s5max-quick/contacts/demo-01-final-cut.jpg`
- Replace: `work/s5max-quick/contacts/demo-02-final-cut.jpg`

**Interfaces:**

- Consumes: 纯净字幕画面与两份 Edge TTS 音轨
- Produces: 两条老板验收版和联系表

- [x] **Step 1: 按现有 props 重渲染两个 Composition 并合入新音轨**

```bash
./node_modules/.bin/remotion render packages/remotion-video/src/index.ts ProductMarketingReal out/s5max-demo-01-data.silent.mp4 --props work/s5max-quick/demo-01.props.json --public-dir work/s5max-quick/public --codec=h264 --pixel-format=yuv420p --color-space=bt709 --audio-codec=aac --enforce-audio-track --overwrite=true
```

Expected: 两个 Remotion 渲染均退出 0；FFmpeg 合入音轨后时长和帧数不变。

- [x] **Step 2: 完整解码、ffprobe 并检查联系表**

```bash
ffmpeg -nostdin -v error -xerror -i out/s5max-demo-01-data.mp4 -f null -
ffprobe -v error -count_frames -show_entries stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,nb_read_frames,sample_rate,channels:format=duration -of json out/s5max-demo-01-data.mp4
```

Expected: 1080×1920、30fps、H.264/AAC、855/738 帧；角落叠加层消失、字幕与 CTA 产品保留。
