#!/usr/bin/env node
import {pathToFileURL} from "node:url";
import {readJson, ensureWorkDirs, loadJob, loadJobDefinition, writeJsonAtomic, writeResult} from "./lib/job.mjs";
import {assertIndexMatchesSourceRoot, indexAssets} from "./lib/index-assets.mjs";
import {prepareMedia} from "./lib/prepare-media.mjs";
import {qcRender, renderJob, validateWithRemotion} from "./lib/render-qc.mjs";

const stageNames = ["index", "prepare", "validate", "render", "qc"];
export const failureStatus = {
  index: "index_failed",
  prepare: "prepare_failed",
  validate: "validation_failed",
  render: "render_failed",
  qc: "qc_failed",
};

export const parseCli = (argv) => {
  const [command, ...tokens] = argv;
  if (!command) throw new Error("Usage: auto-edit <index|prepare|validate|render|qc|run> --config <job.json> [--through prepare|--from validate]");
  const values = {command, configPath: null, from: null, through: null};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!value) throw new Error(`Missing value for ${flag}.`);
    if (flag === "--config") values.configPath = value;
    else if (flag === "--from") values.from = value;
    else if (flag === "--through") values.through = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!values.configPath) throw new Error("--config is required.");
  return values;
};

export const stagesFor = ({command, from, through}) => {
  if (stageNames.includes(command)) {
    if (from || through) throw new Error("Stage commands do not accept --from or --through.");
    if (command === "render") return ["validate", "render"];
    if (command === "qc") return ["validate", "qc"];
    return [command];
  }
  if (command !== "run") throw new Error(`Unknown command: ${command}`);
  if (through === "prepare" && from === null) return ["index", "prepare"];
  if (from === "validate" && through === null) return ["validate", "render", "qc"];
  throw new Error("run supports only --through prepare or --from validate.");
};

export const executeStages = async (stages, runStage, onFailure) => {
  for (const stage of stages) {
    try {
      await runStage(stage);
    } catch (error) {
      await onFailure(stage, error);
      throw error;
    }
  }
};

const readIfPresent = async (filePath, fallback) => {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
};

export const runCli = async (argv = process.argv.slice(2)) => {
  const options = parseCli(argv);
  const stages = stagesFor(options);
  const definition = await loadJobDefinition(options.configPath);
  const requiresSource = stages.some((stage) => stage === "index" || stage === "prepare");
  let job;
  try {
    job = requiresSource ? await loadJob(options.configPath) : definition;
  } catch (error) {
    await ensureWorkDirs(definition.paths);
    await writeResult(definition.paths, failureStatus[stages[0]], {error: error.message});
    throw error;
  }
  const {config, paths} = job;
  await ensureWorkDirs(paths);

  const handlers = {
    index: async () => {
      const previousIndex = await readIfPresent(paths.indexPath, null);
      const {index, metrics} = await indexAssets({sourceRoot: paths.sourceRoot, previousIndex});
      await writeJsonAtomic(paths.indexPath, index);
      await writeResult(paths, "indexed", {index: metrics, error: null});
      process.stdout.write(`indexed sources=${metrics.sources} cached=${metrics.cached} probed=${metrics.probed} failed=${metrics.failed}\n`);
    },
    prepare: async () => {
      const index = await readJson(paths.indexPath);
      assertIndexMatchesSourceRoot(index, paths.sourceRoot);
      const {updatedIndex, metrics} = await prepareMedia({index, paths});
      await writeJsonAtomic(paths.indexPath, updatedIndex);
      const recheckedJob = await loadJob(options.configPath);
      if (recheckedJob.paths.sourceRoot !== paths.sourceRoot) throw new Error("sourceRoot changed while prepare was running.");
      if (metrics.prepared + metrics.cached === 0) throw new Error("No source was prepared successfully.");
      await writeResult(paths, "prepared", {prepare: metrics, error: null});
      process.stdout.write(`prepared=${metrics.prepared} cached=${metrics.cached} failed=${metrics.failed}\n`);
    },
    validate: async () => {
      await validateWithRemotion({config, paths});
      process.stdout.write(`validated ${paths.propsPath}\n`);
    },
    render: async () => {
      const render = await renderJob({paths});
      const current = await readIfPresent(paths.resultPath, {status: "prepared"});
      await writeResult(paths, current.status, {render, error: null});
      process.stdout.write(`rendered partial ${paths.partialOutputPath}\n`);
    },
    qc: async () => {
      const qc = await qcRender({paths});
      await writeResult(paths, "complete", {qc, error: null});
      process.stdout.write(`complete ${paths.outputPath}\n`);
    },
  };

  await executeStages(
    stages,
    async (stage) => handlers[stage](),
    async (stage, error) => writeResult(paths, failureStatus[stage], {error: error.message}),
  );
  if (options.command === "run" && options.through === "prepare") {
    await writeResult(paths, "needs_review", {
      error: null,
      nextAction: `Review ${paths.indexPath} and contacts, then create ${paths.timelinePath}.`,
    });
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
