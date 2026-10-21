/**
 * duplicate-frontmatter-keys-transports.test.mjs — #605 on every host road
 * that writes frontmatter text: a repeated key at the root or inside a
 * `verified` record is refused, with the allowed-agent list EMPTY (the bypass
 * needed no setting). The repro: two `verified` blocks, a forged one first and
 * the original last, which the guard's last-key-wins reader read as unchanged.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { installObsidianStub, TFile, parseYaml } from "./obsidian-stub.mjs";
import { fakeServer } from "./fake-server.mjs";

installObsidianStub();
const { ObsidianBackend } = await import("../src/mcp/obsidian-backend.ts");
const { composeNote } = await import("../src/mcp/write-notes-compose.ts");
const { registerComplementaryTools, guardAppendResult } = await import("../src/mcp/tools-complementary.ts");
const { cliAcceptRefusal } = await import("../src/mcp/tools-cli.ts");
const { registerFsTools, parseGuardFrontmatter } = await import("@vault-mcp/core");

const ORIGINAL = "---\nverified:\n  - by: human:owner\n    at: x\n---\nbody ^b\n";
const FORGED = "---\nverified:\n  - by: human:forged\n    at: y\nverified:\n  - by: human:owner\n    at: x\n---\nbody ^b\n";

function fakeApp(files = {}, blocks = {}) {
  const store = new Map(Object.entries(files));
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (store.has(p) ? new TFile(p) : null),
      read: async (f) => store.get(f.path) ?? "",
      cachedRead: async (f) => store.get(f.path) ?? "",
      create: async (p, c) => { store.set(p, c); },
      modify: async (f, c) => { store.set(f.path, c); },
      append: async (f, c) => { store.set(f.path, (store.get(f.path) ?? "") + c); },
      createFolder: async () => {},
    },
    metadataCache: {
      getFileCache: (f) => {
        let fm = null;
        try { fm = parseGuardFrontmatter(store.get(f.path) ?? ""); } catch { fm = null; }
        return { ...(fm ? { frontmatter: fm } : {}), blocks: blocks[f.path] ?? {}, headings: [] };
      },
    },
  };
  return { app, store };
}

function harness(files, blocks) {
  const { app, store } = fakeApp(files, blocks);
  const backend = new ObsidianBackend(app);
  const tools = new Map();
  registerFsTools({ registerTool: (name, def, handler) => tools.set(name, { def, handler }) }, backend, { decodeHtml: false });
  return { store, backend, call: (name, args) => tools.get(name).handler(args, {}) };
}

function refused(res) {
  assert.equal(res.isError, true, "the write must be refused");
  assert.match(res.content[0].text, /\[accept_forbidden\]/);
  assert.match(res.content[0].text, /repeats the key/);
}

describe("#605 on the host roads, with the allowed-agent list empty", () => {
  test("obsidian_write_note: the forged write is refused and nothing lands", async () => {
    const { store, call } = harness({ "n.md": ORIGINAL });
    refused(await call("obsidian_write_note", { path: "n.md", content: FORGED, overwrite: true }));
    assert.equal(store.get("n.md"), ORIGINAL);
  });

  test("obsidian_write_note: any repeated root key is refused", async () => {
    const { store, call } = harness({});
    refused(await call("obsidian_write_note", { path: "t.md", content: "---\ntitle: A\ntitle: B\n---\nx\n" }));
    assert.equal(store.has("t.md"), false);
  });

  test("obsidian_append_note: appending a repeating fence onto an empty note is refused", async () => {
    const { store, call } = harness({ "e.md": "" });
    refused(await call("obsidian_append_note", { path: "e.md", content: FORGED }));
    assert.equal(store.get("e.md"), "");
  });

  test("patchNote (obsidian_patch_note): a patch that adds a second verified block inside the fence is refused", async () => {
    // The block anchor covers the first line of the fence's body, `verified:`.
    const blocks = { "p.md": { b: { position: { start: { offset: 4 }, end: { offset: 13 } } } } };
    const { store, backend } = harness({ "p.md": ORIGINAL }, blocks);
    await assert.rejects(
      () => backend.patchNote("p.md", { type: "block", value: "b" }, "replace", "verified:\n  - by: human:forged\n    at: y\nverified:"),
      /repeats the key 'verified'/,
    );
    assert.equal(store.get("p.md"), ORIGINAL);
  });

  test("obsidian_append_at_heading: its result check (guardAppendResult) refuses the forged result", () => {
    assert.throws(() => guardAppendResult(ORIGINAL, FORGED), (e) => e.code === "accept_forbidden" && /repeats the key 'verified'/.test(e.message));
  });

  test("obsidian_append_at_heading: the registered tool refuses an insert that repeats a key in the fence", async () => {
    const text = "---\ntitle: A\n---\n\nbody\n";
    const store = new Map([["N.md", text]]);
    const calls = [];
    const app = {
      vault: {
        getAbstractFileByPath: (p) => (store.has(p) ? new TFile(p) : null),
        read: async (f) => store.get(f.path),
        create: async () => calls.push("create"),
        append: async () => calls.push("append"),
        modify: async () => calls.push("modify"),
      },
      metadataCache: {
        getFileCache: () => ({
          headings: [
            { heading: "H", level: 2, position: { start: { line: 1, offset: 4 } } },
            { heading: "Next", level: 2, position: { start: { line: 2, offset: 13 } } },
          ],
        }),
      },
    };
    const server = fakeServer();
    registerComplementaryTools(server, app, { getSettings: () => ({ allowlist: [] }) });
    const res = await server.tools.get("obsidian_append_at_heading").handler({ path: "N.md", heading: "H", content: "title: B", create_if_missing: false });
    assert.equal(res.isError, true, res.content?.[0]?.text);
    assert.match(res.content[0].text, /repeats the key 'title'/);
    assert.deepEqual(calls, []);
  });

  test("composeNote (obsidian_write_notes): a body fence that repeats a key is refused, whatever parseYaml keeps", () => {
    const deps = { stringifyYaml: () => "", parseYaml, formatTs: () => "t", now: 0, mintUid: () => "u" };
    assert.throws(
      () => composeNote({ ...deps, frontmatter: {}, body: FORGED, stamp: false, existing: parseGuardFrontmatter(ORIGINAL) }),
      (e) => e.code === "accept_forbidden" && /repeats the key 'verified'/.test(e.message),
    );
  });

  test("cliAcceptRefusal (the CLI proxy): a content fence that repeats a key is refused", () => {
    assert.match(cliAcceptRefusal("create", { path: "x.md", content: "---\ntitle: A\ntitle: B\n---\nbody" }, parseYaml) ?? "", /repeats the key 'title'/);
    assert.equal(cliAcceptRefusal("create", { path: "x.md", content: "---\ntitle: A\n---\nbody" }, parseYaml), null);
  });
});
