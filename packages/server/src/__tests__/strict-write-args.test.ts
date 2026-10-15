// The file-system server's write tools are strict (#510) and still take the kernel arguments (#546 review).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFsServer } from "../fs-mode.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tools = (buildFsServer() as any)._registeredTools as Record<string, any>;
const writes = Object.keys(tools).filter((n) => tools[n].annotations?.readOnlyHint === false);

test("every FS write tool refuses an unknown argument", () => {
  assert.ok(writes.length >= 6, `found ${writes.length}`);
  for (const n of writes) assert.equal(tools[n].inputSchema._def.unknownKeys, "strict", n);
  const r = tools.obsidian_append_note.inputSchema.safeParse({ path: "A.md", content: "x", frontmatter: { a: 1 } });
  assert.equal(r.success, false);
});

test("the kernel arguments are accepted on FS write tools, as the plugin requires a client to send them", () => {
  for (const [n, args] of [
    ["obsidian_append_note", { path: "A.md", content: "x", idempotency_key: "k", intent: "why" }],
    ["obsidian_write_note", { path: "A.md", content: "x", overwrite: true, if_rev: 1, idempotency_key: "k" }],
  ] as const) {
    const r = tools[n].inputSchema.safeParse(args);
    assert.equal(r.success, true, `${n}: ${JSON.stringify(r.error?.issues)}`);
  }
});
