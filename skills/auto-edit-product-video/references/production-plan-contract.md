# ProductionPlan 唯一契约

权威实现是 `packages/remotion-video/src/production-contract.js`。Codex 写入的内部 JSON 只能包含以下字段：

```json
{
  "schemaVersion": 1,
  "id": "safe-local-id",
  "title": "产品标题",
  "sourceText": "当前成片选中的全部字幕文本按顺序连接",
  "catalogPath": "work/asset-library/catalog.json",
  "voice": {
    "promptPath": "本地参考音色.wav",
    "durationFactor": 1
  },
  "sentences": [{
    "id": "sentence-01",
    "text": "用户原文句子",
    "ttsText": "仅为发音调整的等义文本",
    "shot": {
      "sourceId": "catalog-source-id",
      "sourceInSeconds": 0,
      "sourceOutSeconds": 4,
      "fit": "cover",
      "focusX": 0.5,
      "focusY": 0.5
    }
  }]
}
```

- 顶层、`voice`、每句和 `shot` 均拒绝额外字段；`schemaVersion` 必须为 1，`id` 和句子 ID 唯一且可安全用于本地文件名。
- `catalogPath` 与 `promptPath` 必须是本地路径；catalog 的 `sourceRoot` 及每个 `sourceId` 必须存在，SMB 始终只读。
- `sourceText` 是当前成片选中的全部字幕文本按顺序连接后的结果，不是用户提交的整个句子池；整个句子池由批次目录中的 `source-copy.txt` 和 `copy-pool.csv` 保留。ProductionPlan 仍必须满足所有 `sentence.text` 连接后等于 `sourceText`。
- 全部 `text` 按顺序连接并忽略空白后必须等于当前成片的 `sourceText`；`ttsText` 只能改变读音表达。
- `durationFactor` 范围为 0.5–2.0；`fit` 只能是 `cover` 或 `contain`；`focusX`、`focusY` 范围为 0–1。
- 输出固定为 1080×1920、30fps。WAV 实测时长向上取整得到语音帧；每个非末句追加 5 帧停顿，末句不追加。
- 每个镜头区间换算后的帧数必须覆盖对应语音帧；字幕只在语音帧内可见，停顿期间只冻结句末画面。

执行命令：

```bash
npm run produce -- --plan work/production-plans/<id>.json
```
