import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const read = (file) => readFile(new URL(file, import.meta.url), "utf8");

test("product-video skill exposes the unified raw-copy workflow", async () => {
  const [skill, contract, agent, project] = await Promise.all([
    read("../skills/auto-edit-product-video/SKILL.md"),
    read("../skills/auto-edit-product-video/references/production-plan-contract.md"),
    read("../skills/auto-edit-product-video/agents/openai.yaml"),
    read("../docs/PROJECT_PLAN.md"),
  ]);

  assert.match(skill, /唯一必需输入[^\n]*原始文案/u);
  assert.match(skill, /未指定[^\n]*默认单条/u);
  assert.match(skill, /内部[^\n]*category,text[^\n]*CSV[^\n]*不要求用户/u);
  assert.match(skill, /sourceText[^\n]*normalizedText[^\n]*sentenceId/u);
  assert.match(skill, /不得新增[^\n]*(事实|数字|价格|承诺)/u);
  assert.match(skill, /1[^\n]*hook[^\n]*2[^\n]*4[^\n]*(卖点|场景)[^\n]*1[^\n]*CTA/iu);
  assert.match(skill, /capacity[^\n]*300/u);
  assert.match(skill, /view_image[^\n]*contactSheetPath[^\n]*ctaSheetPath/u);
  assert.match(skill, /prepare[^\n]*本地 IndexTTS 2\.5/u);
  assert.match(skill, /sample[^\n]*1 条[^\n]*批准/u);
  assert.match(skill, /approve[^\n]*剩余/u);
  assert.match(skill, /reject[^\n]*整批[^\n]*归档/u);
  assert.match(skill, /跨历史[^\n]*文案[^\n]*素材/u);
  assert.match(skill, /produce\.mjs[^\n]*唯一[^\n]*单条生产内核/u);
  assert.doesNotMatch(skill, /要求用户[^\n]*(CSV|JSON|ProductionPlan)/u);

  assert.match(contract, /sourceText[^\n]*当前成片[^\n]*不是[^\n]*整个句子池/u);
  assert.match(contract, /ProductionPlan[^\n]*sentence\.text[^\n]*sourceText/u);

  assert.match(agent, /single[^\n]*default|默认单条/iu);
  assert.match(agent, /batch[^\n]*300/iu);
  assert.match(agent, /local IndexTTS 2\.5/iu);
  assert.match(agent, /Remotion/u);

  assert.match(project, /唯一[^\n]*用户工作流/u);
  for (const command of ["capacity", "prepare", "sample", "approve", "reject", "render"]) {
    assert.match(project, new RegExp("`" + command + "`", "u"), command);
  }
  assert.match(project, /work\/s5max-daily[^\n]*保留/u);
  assert.match(project, /out\/s5max-daily[^\n]*保留/u);
});
