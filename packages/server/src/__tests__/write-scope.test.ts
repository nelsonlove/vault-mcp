import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fsWriteScope, WRITE_SCOPE_ENV_VAR } from "../fs-mode.js";

test("VAULT_MCP_WRITE_SCOPE: unset is no rule; JSON is the plugin's setting; a value that does not parse refuses every write", () => {
  assert.deepEqual(fsWriteScope({}), { mode: "all", paths: [] });
  assert.deepEqual(fsWriteScope({ [WRITE_SCOPE_ENV_VAR]: '{"mode":"create-only","paths":["**/[0-9][0-9].01 Inbox/*.md"]}' }), {
    mode: "create-only",
    paths: ["**/[0-9][0-9].01 Inbox/*.md"],
  });
  assert.deepEqual(fsWriteScope({ [WRITE_SCOPE_ENV_VAR]: "{not json" }), { mode: "create-only", paths: [] });
});

test("every FS-mode write passes the write-scope check in mutate, before the queue", () => {
  const src = fs.readFileSync(new URL("../../src/fs-mode.ts", import.meta.url), "utf8");
  const mutate = src.slice(src.indexOf("const mutate = async"), src.indexOf("return kernel.runMutation("));
  assert.match(mutate, /writeScopeRefusal\(op, args, targets, scope,/);
  // Every write on this transport goes through mutate: count the backend's mutate calls against its write methods.
  const calls = src.match(/mutate\(\s*"obsidian_[a-z_]+"/g) ?? [];
  assert.ok(calls.length >= 6, `expected the six FS writes to use mutate, found ${calls.length}`);
});
