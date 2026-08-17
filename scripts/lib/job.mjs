import {constants as fsConstants} from "node:fs";
import {randomUUID} from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const JOB_ID_RE = /^[A-Za-z0-9_-]+$/;
const STATUSES = new Set([
  "index_failed", "indexed", "prepare_failed", "prepared", "needs_review",
  "validation_failed", "render_failed", "qc_failed", "complete",
]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const readUtf8 = async (filePath) => new TextDecoder("utf-8", {fatal: true}).decode(await readFile(filePath));

export const assertDescendant = (parent, child, label = "path") => {
  const relative = path.relative(parent, child);
  if (
    relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must be a strict descendant of ${parent}: ${child}`);
  }
};

const validateStringArray = (value, label, errors) => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    errors.push(`${label} must be an array of strings.`);
  }
};

const validateConfig = (value) => {
  const errors = [];
  if (!isObject(value)) errors.push("Job config must be a JSON object.");
  if (value?.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  if (typeof value?.jobId !== "string" || !JOB_ID_RE.test(value.jobId)) {
    errors.push("jobId must match /^[A-Za-z0-9_-]+$/.");
  }
  if (typeof value?.sourceRoot !== "string" || !path.isAbsolute(value.sourceRoot)) {
    errors.push("sourceRoot must be an absolute path.");
  }
  if (typeof value?.scriptPath !== "string" || value.scriptPath.length === 0) {
    errors.push("scriptPath must be a non-empty string.");
  }
  if (!isObject(value?.product)) {
    errors.push("product must be an object.");
  } else {
    for (const key of ["sku", "name"]) {
      if (typeof value.product[key] !== "string" || value.product[key].length === 0) {
        errors.push(`product.${key} must be non-empty.`);
      }
    }
    validateStringArray(value.product.sellingPoints, "product.sellingPoints", errors);
    validateStringArray(value.product.aliases, "product.aliases", errors);
    validateStringArray(value.product.referenceImages, "product.referenceImages", errors);
  }
  const target = value?.target;
  if (!isObject(target)) {
    errors.push("target must be an object.");
  } else if (
    target.width !== 1080 || target.height !== 1920 || target.fps !== 30 ||
    target.minDurationSeconds !== 20 || target.maxDurationSeconds !== 40
  ) {
    errors.push("target must be exactly 1080x1920, 30fps, 20-40 seconds.");
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return value;
};

const buildPaths = (workspaceRoot, sourceRoot, jobId) => {
  const workDir = path.join(workspaceRoot, "work", jobId);
  const publicDir = path.join(workDir, "public");
  const contactsDir = path.join(workDir, "contacts");
  return {
    jobId,
    workspaceRoot,
    sourceRoot,
    workDir,
    publicDir,
    proxiesDir: path.join(publicDir, "proxies"),
    contactsDir,
    indexPath: path.join(workDir, "index.json"),
    timelinePath: path.join(workDir, "timeline.json"),
    propsPath: path.join(workDir, "props.json"),
    resultPath: path.join(workDir, "result.json"),
    partialOutputPath: path.join(workspaceRoot, "out", `${jobId}.partial.mp4`),
    outputPath: path.join(workspaceRoot, "out", `${jobId}.mp4`),
    finalCutContactPath: path.join(contactsDir, "final-cut.jpg"),
  };
};

export const loadJobDefinition = async (jobFile, {workspaceRoot = process.cwd()} = {}) => {
  const workspacePath = path.resolve(workspaceRoot);
  const realWorkspace = await realpath(workspacePath);
  const resolvedJobFile = await realpath(path.resolve(workspacePath, jobFile));
  assertDescendant(realWorkspace, resolvedJobFile, "jobFile");
  const raw = validateConfig(JSON.parse(await readUtf8(resolvedJobFile)));
  const scriptCandidate = path.isAbsolute(raw.scriptPath)
    ? raw.scriptPath
    : path.resolve(workspacePath, raw.scriptPath);
  const realScriptPath = await realpath(scriptCandidate);
  assertDescendant(realWorkspace, realScriptPath, "scriptPath");
  if (!(await stat(realScriptPath)).isFile()) throw new Error("scriptPath must be a regular file.");
  await access(realScriptPath, fsConstants.R_OK);
  await readUtf8(realScriptPath);
  return {
    config: {...raw, scriptPath: scriptCandidate},
    paths: buildPaths(workspacePath, raw.sourceRoot, raw.jobId),
  };
};

export const loadJob = async (
  jobFile,
  {workspaceRoot = process.cwd(), mountRoot = "/Volumes/192.168.50.79"} = {},
) => {
  const definition = await loadJobDefinition(jobFile, {workspaceRoot});
  const [realMount, realSource] = await Promise.all([
    realpath(mountRoot),
    realpath(definition.config.sourceRoot),
  ]);
  assertDescendant(realMount, realSource, "sourceRoot");
  if (!(await stat(realSource)).isDirectory()) throw new Error("sourceRoot must be a readable directory.");
  await access(realSource, fsConstants.R_OK);
  return {
    config: {...definition.config, sourceRoot: realSource},
    paths: buildPaths(definition.paths.workspaceRoot, realSource, definition.config.jobId),
  };
};

const ensureSafeDirectory = async (workspaceRoot, directory) => {
  const realWorkspaceRoot = await realpath(workspaceRoot);
  assertDescendant(workspaceRoot, directory, "derived directory");
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink()) throw new Error(`Derived directory may not be a symbolic link: ${directory}`);
    if (!info.isDirectory()) throw new Error(`Derived directory path is not a directory: ${directory}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(directory);
  }
  assertDescendant(realWorkspaceRoot, await realpath(directory), "derived directory realpath");
};

export const ensureWorkDirs = async (paths) => {
  const workRoot = path.join(paths.workspaceRoot, "work");
  const outRoot = path.dirname(paths.outputPath);
  for (const directory of [workRoot, outRoot, paths.workDir, paths.publicDir, paths.proxiesDir, paths.contactsDir]) {
    await ensureSafeDirectory(paths.workspaceRoot, directory);
  }
};

export const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

export const writeJsonAtomic = async (filePath, value) => {
  await mkdir(path.dirname(filePath), {recursive: true});
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {encoding: "utf8", flag: "wx"});
  await rename(temporary, filePath);
};

export const writeResult = async (paths, status, detail = {}) => {
  if (!STATUSES.has(status)) throw new Error(`Unknown result status: ${status}`);
  let previous = {};
  try {
    previous = await readJson(paths.resultPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeJsonAtomic(paths.resultPath, {
    ...previous,
    ...detail,
    schemaVersion: 1,
    jobId: paths.jobId,
    status,
    updatedAt: new Date().toISOString(),
  });
};

export const assertReadableProxyFiles = async (props, publicDir) => {
  const realPublic = await realpath(publicDir);
  for (const [key, shot] of Object.entries(props.shots ?? {})) {
    const proxyPath = shot?.proxyPath;
    if (typeof proxyPath !== "string" || proxyPath.length === 0 || path.isAbsolute(proxyPath)) {
      throw new Error(`Shot ${key} proxyPath must be a non-empty public-dir relative path.`);
    }
    const candidate = path.resolve(realPublic, proxyPath);
    assertDescendant(realPublic, candidate, `Shot ${key} proxyPath escape`);
    let resolved;
    try {
      resolved = await realpath(candidate);
      assertDescendant(realPublic, resolved, `Shot ${key} proxyPath escape`);
      await access(resolved, fsConstants.R_OK);
    } catch (error) {
      throw new Error(`Shot ${key} proxy is not readable: ${error.message}`);
    }
    if (!(await stat(resolved)).isFile()) throw new Error(`Shot ${key} proxy must be a regular file.`);
  }
};
