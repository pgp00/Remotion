import assert from "node:assert/strict";
import test from "node:test";
import {
  executeStages,
  failureStatus,
  parseCli,
  stagesFor,
} from "./auto-edit.mjs";

test("parses individual and approved two-pass commands", () => {
  assert.deepEqual(parseCli(["index", "--config", "job.json"]), {command: "index", configPath: "job.json", from: null, through: null});
  assert.deepEqual(stagesFor(parseCli(["render", "--config", "job.json"])), ["validate", "render"]);
  assert.deepEqual(stagesFor(parseCli(["qc", "--config", "job.json"])), ["validate", "qc"]);
  assert.deepEqual(stagesFor(parseCli(["run", "--config", "job.json", "--through", "prepare"])), ["index", "prepare"]);
  assert.deepEqual(stagesFor(parseCli(["run", "--config", "job.json", "--from", "validate"])), ["validate", "render", "qc"]);
  for (const argv of [
    ["run", "--config", "job.json"],
    ["run", "--config", "job.json", "--from", "render"],
    ["run", "--config", "job.json", "--through", "qc"],
    ["index", "--config", "job.json", "--from", "validate"],
    ["unknown", "--config", "job.json"],
  ]) assert.throws(() => stagesFor(parseCli(argv)));
});

test("maps every failing stage to the approved status", () => {
  assert.deepEqual(failureStatus, {
    index: "index_failed",
    prepare: "prepare_failed",
    validate: "validation_failed",
    render: "render_failed",
    qc: "qc_failed",
  });
  for (const command of ["render", "qc"]) {
    const firstStage = stagesFor(parseCli([command, "--config", "job.json"]))[0];
    assert.equal(failureStatus[firstStage], "validation_failed");
  }
});

test("executeStages stops at the first failure", async () => {
  const seen = [];
  const failures = [];
  await assert.rejects(executeStages(
    ["validate", "render", "qc"],
    async (stage) => {
      seen.push(stage);
      if (stage === "render") throw new Error("render broke");
    },
    async (stage, error) => failures.push([stage, error.message]),
  ), /render broke/);
  assert.deepEqual(seen, ["validate", "render"]);
  assert.deepEqual(failures, [["render", "render broke"]]);
});
