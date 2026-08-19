import {randomUUID} from "node:crypto";
import {mkdir, readFile, rename, writeFile} from "node:fs/promises";
import path from "node:path";

export const assertDescendant = (parent, child, label = "path") => {
  const relative = path.relative(parent, child);
  if (
    relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must be a strict descendant of ${parent}: ${child}`);
  }
};

export const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

export const writeJsonAtomic = async (filePath, value) => {
  await mkdir(path.dirname(filePath), {recursive: true});
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {encoding: "utf8", flag: "wx"});
  await rename(temporary, filePath);
};
