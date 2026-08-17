# Remotion 自动剪辑项目骨架

## 目标

从空仓库搭建一个可运行的 npm workspace，并先把 SMB 素材变成可检索、可人工快速确认的生产基础库。网页可以启动，Remotion Studio 可以预览，示例商品视频可以渲染，自动剪辑继续按候选素材按需生成代理。

暂时无法完成的真实能力不做假实现，统一记录在 [`DEFERRED_CAPABILITIES.md`](./DEFERRED_CAPABILITIES.md)。

## 工程结构

- `apps/web`：本地单用户审核工作台。
- `packages/remotion-video`：Remotion 商品营销视频模板。
- `packages/shared`：产品、素材镜头和时间线共享类型。
- `packages/core`：示例数据、校验逻辑和外部能力接口。
- `skills/auto-edit-product-video`：项目内 Codex 自动剪辑技能。
- `scripts/asset-library.mjs`：SMB 只读扫描、指纹、联系表、CTA 四帧图、质量标记、断点恢复和本地检索。
- `docs/DEFERRED_CAPABILITIES.md`：尚未接入能力及其完成标准。

> 当前环境不允许写入仓库根目录下的 `.agents` 特殊目录，因此项目技能源码保存在普通的 `skills/` 目录，后续可按 Codex 环境需要安装或映射到技能发现目录。

## 可运行基线

- 使用 npm workspaces、TypeScript、React、Vite 和 Remotion。
- `npm run dev` 启动审核网页。
- `npm run studio` 启动 Remotion Studio。
- `npm run render:demo` 渲染示例竖屏 MP4。
- `npm run typecheck` 检查所有 workspace。
- 示例时间线为 1080×1920、24 秒的商品营销草稿，不依赖外部素材。
- 网页和 Remotion 共同消费 `Timeline` 数据结构。
- 资产库所有衍生物写入 `work/asset-library/`，不向 SMB 写入，不全量生成代理。
- 未配置的 NAS、AI、TTS 等能力必须明确返回 `not_configured`。

## 验收标准

- 全新安装依赖后，网页和 Remotion Studio 均可启动。
- 示例 Composition 可以预览并渲染 MP4。
- Web、Remotion 和核心逻辑共用相同的时间线类型。
- TypeScript 检查与 Codex 技能结构校验通过。
- 项目中不伪造 NAS、AI、TTS 或真实素材分析结果。

## 当前假设

- 第一阶段为单用户本地开发环境，不实现登录和权限。
- 当前机器已经安装 Node.js、npm 和 FFmpeg。
- 真实 SMB 全量运行仍需在挂载后人工启动；本地框架不自动挂载或写入共享盘。
- Codex 负责剪辑决策；确定性的资产扫描、索引、抽帧、配音和渲染能力由工具实现。
