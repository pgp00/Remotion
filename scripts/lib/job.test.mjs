import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {assertDescendant, readJson, writeJsonAtomic} from "./job.mjs";

test("retained path and atomic JSON helpers", async () => {
  assert.doesNotThrow(() => assertDescendant("/mount", "/mount/a"));
  assert.throws(() => assertDescendant("/mount", "/mount-other/a"));
  assert.throws(() => assertDescendant("/mount", "/mount"));

  const root = await mkdtemp(path.join(tmpdir(), "production-json-"));
  const file = path.join(root, "nested", "value.json");
  await writeJsonAtomic(file, {ok: true});
  assert.deepEqual(await readJson(file), {ok: true});
});
