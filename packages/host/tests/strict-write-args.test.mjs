// Every write tool vault-mcp registers refuses an argument it does not name (#510; Nelson's pick A of
// "Make every vault-mcp write tool refuse an argument it does not name", 2026-10-12). Read tools and
// satellite tools keep their schemas. Built through the REAL server wiring.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { installObsidianStub } from "./obsidian-stub.mjs";

installObsidianStub();
const { buildMcpServer } = await import("../src/mcp/server.ts");

function build() {
  const app = {
    vault: {
      adapter: { basePath: "/nonexistent-vault" },
      getName: () => "test",
      getMarkdownFiles: () => [],
      getFiles: () => [],
      getAllLoadedFiles: () => [],
      getAbstractFileByPath: () => null,
      on: () => ({}),
      configDir: ".obsidian",
    },
    metadataCache: { getFileCache: () => null, resolvedLinks: {}, unresolvedLinks: {}, on: () => ({}) },
    workspace: { layoutReady: true, iterateAllLeaves: (cb) => cb({}), getActiveFile: () => null, on: () => ({}) },
    plugins: { plugins: {}, manifests: {}, enabledPlugins: new Set() },
    internalPlugins: { getPluginById: () => null },
    commands: { commands: {}, executeCommandById: () => true },
  };
  const ctx = {
    pluginVersion: "0.0.0", socketPath: "/tmp/none.sock", vaultName: "test", enabledPlugins: () => [],
    getSettings: () => ({ allowlist: [], readOnly: false, trustedReadOnlyPlugins: [] }),
    getExternalTools: () => [
      { ownerId: "sat", toolName: "sat_write", spec: { description: "a satellite write", inputSchema: { type: "object", properties: { x: { type: "string" } } }, annotations: { readOnlyHint: false } } },
    ],
  };
  return buildMcpServer(app, ctx)._registeredTools;
}

const strict = (t) => t.inputSchema?._def?.unknownKeys === "strict";

describe("strict arguments on write tools (#510)", () => {
  const tools = build();
  const names = Object.keys(tools);
  const writes = names.filter((n) => tools[n].annotations?.readOnlyHint === false && n !== "sat_write");
  const reads = names.filter((n) => tools[n].annotations?.readOnlyHint !== false);

  test("every write tool vault-mcp registers is strict", () => {
    assert.ok(writes.length >= 30, `found only ${writes.length} write tools`);
    const loose = writes.filter((n) => !strict(tools[n]));
    assert.deepEqual(loose, [], `write tools that still drop an unknown argument: ${loose.join(", ")}`);
  });

  test("an unknown argument is refused with Unrecognized key(s), on a shared tool and on a host tool", () => {
    for (const [name, args] of [
      ["obsidian_patch_note", { path: "A.md", anchor_kind: "heading", anchor: "H", op: "append", content: "x" }],
      ["obsidian_append_note", { path: "A.md", content: "x", frontmatter: { a: 1 } }],
      ["obsidian_move_note", { from: "A.md", to: "B.md", overwrite_links: true }],
    ]) {
      if (!tools[name]) continue;
      const r = tools[name].inputSchema.safeParse(args);
      assert.equal(r.success, false, name);
      assert.match(JSON.stringify(r.error.issues), /unrecognized_keys/, name);
    }
  });

  test("the plugin's own kernel-argument descriptions are kept on shared write tools (#546 review 2)", () => {
    assert.match(tools.obsidian_append_note.inputSchema.shape.idempotency_key.description, /^REQUIRED for this tool/);
    assert.match(tools.obsidian_write_note.inputSchema.shape.if_rev.description, /^REQUIRED when overwrite is true/);
    assert.doesNotMatch(tools.obsidian_append_note.inputSchema.shape.idempotency_key.description, /file-system server/);
  });

  test("the kernel arguments stay accepted on a strict write tool", () => {
    const r = tools.obsidian_append_note.inputSchema.safeParse({ path: "A.md", content: "x", idempotency_key: "k", intent: "why" });
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
  });

  test("obsidian_write_notes refuses an unknown argument and an unknown key on an item", () => {
    const s = tools.obsidian_write_notes.inputSchema;
    assert.equal(s.safeParse({ notes: [{ path: "A.md", body: "x" }] }).success, true);
    assert.equal(s.safeParse({ notes: [{ path: "A.md", body: "x" }], overwrite: true }).success, false, "an unknown top-level argument");
    assert.equal(s.safeParse({ notes: [{ path: "A.md", content: "x" }] }).success, false, "content is not body");
  });

  test("read tools and satellite tools are unchanged", () => {
    assert.ok(reads.length > 0);
    assert.ok(reads.some((n) => !strict(tools[n])), "reads keep the lenient object");
    assert.equal(strict(tools.sat_write), false, "a satellite's own schema is left alone");
  });
});
