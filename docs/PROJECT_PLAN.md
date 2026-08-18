# 本地商品视频统一生产

这是唯一的用户工作流：用户只提供未经分类的原始文案，并可选 `single` 或 `batch` 模式；未指定模式默认单条。Codex 自主保存原文、拆句分类、组合、检索并视觉核验本地 SMB 镜头、预热本地 IndexTTS 2.5，再通过同一个 Remotion 单条生产内核逐句对齐音画并完成 QC。

## 用户工作流

1. 保存 `source-copy.txt`，内部生成 `category,text` 的 `copy-pool.csv`；用户不填写 CSV、ProductionPlan、时间线或镜头表。
2. 单条固定生产 1 条唯一组合；批量默认目标 300 条，先报告有效容量、预计耗时和磁盘空间并等待数量确认。
3. 容量不足时扩展本地 SMB，使用 `view_image` 核验 contact/CTA sheets 后更新内部素材矩阵。
4. 逐句调用本地 IndexTTS 2.5，按真实 WAV 时长选片，批量只渲染 1 条样片并等待批准；批准后才渲染剩余条目，拒绝则归档整批。
5. 交付正式 MP4 目录和简短汇总，保留内部计划、manifest、缓存、联系表、QC 和重试记录。

## 六个内部协调命令

唯一公开协调器 `scripts/s5max-daily.py` 只提供：

- `capacity`：计算单条/批量有效容量，并在批量昂贵阶段前报告容量、耗时和空间。
- `prepare`：生成内部文案池、一次性随机批次、真实 WAV 和封存 manifest。
- `sample`：批量只渲染 1 条代表性样片。
- `approve`：记录样片批准，开放剩余条目。
- `reject`：归档整批并释放预留签名。
- `render`：单条直接交付，或在批准后渲染批量剩余条目。

`scripts/produce.mjs` 是唯一的单条生产内核；协调器不自行编码视频，也不创建第二套 TTS、Remotion 或 QC。最终视频固定由 `ProductMarketingProduction` Remotion Composition 生成，素材只来自本地 SMB，语音只来自本地 IndexTTS 2.5。

## 开发命令

- `node --test scripts/skill-contract.test.mjs`：验证唯一入口和文档合同。
- `npm test`：运行保留的 Node 回归测试。
- `python3 -m unittest scripts/test_indextts25_batch.py`：运行本地 TTS 回归测试。
- `npm run typecheck`：检查 Remotion 源码。
- `npm run studio`：打开唯一生产 Composition 和联系表 Still。

生产缓存和审计材料保存在 `work/`，成片保存在 `out/`；两者均不得由源码清理任务删除。旧 `work/s5max-daily` 和 `out/s5max-daily` 是保留的历史产物，不是新入口，也不与统一用户工作流并行。SMB 始终只读，文案与完整镜头序列必须避开当前批次、已预留批次和历史正式成片。
