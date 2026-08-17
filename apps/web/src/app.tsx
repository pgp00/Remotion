import {capabilityDescriptors, demoProject, validateTimeline} from "@auto-video/core";
import type {TimelineClip} from "@auto-video/shared";
import {useMemo, useState} from "react";

const Icon = ({children}: {children: string}) => <span className="icon">{children}</span>;

const formatTime = (frames: number, fps: number) => {
  const seconds = frames / fps;
  return `00:${seconds.toFixed(1).padStart(4, "0")}`;
};

const ClipPreview = ({clip, active}: {clip: TimelineClip; active: boolean}) => (
  <div
    className={`clip-card ${active ? "clip-card--active" : ""}`}
    style={{
      background: `linear-gradient(145deg, ${clip.placeholder.from}, ${clip.placeholder.to})`,
    }}
  >
    <span className="clip-card__label">{clip.label}</span>
    <span className="clip-card__point">{clip.sellingPoint}</span>
  </div>
);

export const App = () => {
  const project = demoProject;
  const timeline = project.variants[0];
  const [selectedClipId, setSelectedClipId] = useState(timeline.clips[0]?.id ?? "");
  const selectedClip = timeline.clips.find((clip) => clip.id === selectedClipId) ?? timeline.clips[0];
  const validation = useMemo(() => validateTimeline(timeline), [timeline]);
  const durationSeconds = timeline.durationInFrames / timeline.fps;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand-mark">
          <div className="brand-mark__symbol">F</div>
          <div>
            <strong>Framepilot</strong>
            <span>Codex video lab</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="主要导航">
          <button className="nav-item nav-item--active" type="button">
            <Icon>⌁</Icon>剪辑项目<span className="nav-count">1</span>
          </button>
          <button className="nav-item" type="button" disabled>
            <Icon>▦</Icon>素材库<span className="soon">待接入</span>
          </button>
          <button className="nav-item" type="button" disabled>
            <Icon>◇</Icon>商品目录<span className="soon">待接入</span>
          </button>
          <button className="nav-item" type="button" disabled>
            <Icon>♫</Icon>音乐与配音<span className="soon">待接入</span>
          </button>
        </nav>

        <div className="sidebar__bottom">
          <div className="system-label">系统能力</div>
          {capabilityDescriptors.slice(0, 3).map((capability) => (
            <div className="system-row" key={capability.id}>
              <span className={`status-dot status-dot--${capability.state}`} />
              <span>{capability.label}</span>
              <small>{capability.state === "not_configured" ? "未配置" : "不可用"}</small>
            </div>
          ))}
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <div className="eyebrow">项目 / {project.product.sku}</div>
            <h1>{timeline.title}</h1>
          </div>
          <div className="topbar__actions">
            <span className={`validation ${validation.valid ? "validation--ok" : ""}`}>
              {validation.valid ? "时间线有效" : `${validation.errors.length} 个错误`}
            </span>
            <button className="button button--ghost" type="button" disabled>
              导入素材
            </button>
            <button className="button button--primary" type="button" disabled>
              正式渲染
            </button>
          </div>
        </header>

        <section className="content-grid">
          <div className="preview-column">
            <div className="section-heading">
              <div>
                <span>草稿预览</span>
                <strong>候选 A · 待审核</strong>
              </div>
              <span className="format-pill">9:16 · 1080P · {durationSeconds}秒</span>
            </div>

            <div className="preview-stage">
              <div
                className="phone-preview"
                style={{
                  background: `radial-gradient(circle at 75% 18%, rgba(255,255,255,.18), transparent 25%), linear-gradient(155deg, ${selectedClip.placeholder.from}, ${selectedClip.placeholder.to})`,
                }}
              >
                <div className="phone-preview__brand">
                  <span />MORNING LAB
                </div>
                <div className="phone-preview__copy">
                  <small>PLACEHOLDER SHOT</small>
                  <h2>{selectedClip.label}</h2>
                  <p>{selectedClip.sellingPoint}</p>
                </div>
                <div className="phone-preview__subtitle">
                  {timeline.subtitles.find(
                    (cue) =>
                      cue.startFrame >= selectedClip.startFrame &&
                      cue.startFrame < selectedClip.startFrame + selectedClip.durationInFrames,
                  )?.text ?? "示例字幕"}
                </div>
                <div className="phone-preview__footer">
                  <span>{timeline.productSku}</span>
                  <span>{timeline.cta}</span>
                </div>
              </div>
            </div>

            <div className="transport">
              <button type="button" aria-label="上一镜头" onClick={() => {
                const index = timeline.clips.findIndex((clip) => clip.id === selectedClip.id);
                setSelectedClipId(timeline.clips[Math.max(0, index - 1)].id);
              }}>‹</button>
              <button className="transport__play" type="button" aria-label="播放占位">▶</button>
              <button type="button" aria-label="下一镜头" onClick={() => {
                const index = timeline.clips.findIndex((clip) => clip.id === selectedClip.id);
                setSelectedClipId(timeline.clips[Math.min(timeline.clips.length - 1, index + 1)].id);
              }}>›</button>
              <span>{formatTime(selectedClip.startFrame, timeline.fps)} / 00:{durationSeconds.toFixed(1)}</span>
            </div>
          </div>

          <aside className="inspector">
            <div className="inspector__header">
              <div>
                <span>当前项目</span>
                <h3>{project.product.name}</h3>
              </div>
              <span className="review-badge">待审核</span>
            </div>

            <dl className="meta-grid">
              <div><dt>SKU</dt><dd>{project.product.sku}</dd></div>
              <div><dt>脚本</dt><dd>示例脚本</dd></div>
              <div><dt>候选版本</dt><dd>1 / 3</dd></div>
              <div><dt>镜头数量</dt><dd>{timeline.clips.length}</dd></div>
            </dl>

            <div className="inspector-section">
              <div className="inspector-section__title">商品卖点</div>
              <div className="tag-list">
                {project.product.sellingPoints.map((point) => <span key={point}>{point}</span>)}
              </div>
            </div>

            <div className="inspector-section">
              <div className="inspector-section__title">当前镜头</div>
              <div className="selected-shot">
                <ClipPreview clip={selectedClip} active />
                <strong>{selectedClip.label}</strong>
                <p>{selectedClip.sellingPoint}</p>
                <small>
                  {formatTime(selectedClip.startFrame, timeline.fps)} — {formatTime(selectedClip.startFrame + selectedClip.durationInFrames, timeline.fps)}
                </small>
              </div>
            </div>

            <div className="notice">
              <span>i</span>
              <p><strong>框架演示模式</strong>真实素材、TTS 和后台渲染尚未接入。当前预览来自共享时间线的程序化占位画面。</p>
            </div>
          </aside>
        </section>

        <section className="timeline-panel">
          <div className="timeline-panel__header">
            <div>
              <span className="panel-kicker">TIMELINE</span>
              <strong>{timeline.clips.length} 个镜头 · {timeline.subtitles.length} 条字幕</strong>
            </div>
            <div className="legend"><span /><em>示例占位镜头</em><span /><em>字幕覆盖</em></div>
          </div>
          <div className="timeline-ruler">
            {[0, 4, 8, 12, 16, 20, 24].map((second) => <span key={second}>{second}s</span>)}
          </div>
          <div className="timeline-track">
            {timeline.clips.map((clip) => (
              <button
                className={`timeline-clip ${selectedClip.id === clip.id ? "timeline-clip--active" : ""}`}
                key={clip.id}
                type="button"
                onClick={() => setSelectedClipId(clip.id)}
                style={{width: `${(clip.durationInFrames / timeline.durationInFrames) * 100}%`}}
              >
                <ClipPreview clip={clip} active={selectedClip.id === clip.id} />
              </button>
            ))}
          </div>
          <div className="subtitle-track">
            <span className="track-name">CC</span>
            {timeline.subtitles.map((cue) => (
              <div className="subtitle-chip" key={cue.id} style={{width: `${((cue.endFrame - cue.startFrame) / timeline.durationInFrames) * 100}%`}}>
                {cue.text}
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
};
