/**
 * yaml-divergence-transports.test.mjs — the escape cases on every host road
 * that writes frontmatter text. The guard's reader read a double-quoted `\X`
 * as a plain `X` where YAML decodes an escape, so `"\x76erified"` forged a
 * `verified` key; it now refuses a form it cannot read as YAML does. Each case
 * is checked against the `yaml` library's parse, then refused on
 * obsidian_write_note, obsidian_append_note, obsidian_patch_note,
 * obsidian_append_at_heading (the result check and the tool),
 * obsidian_write_notes (composeNote), the CLI proxy (cliAcceptRefusal) and
 * obsidian_replace_text. The notes are made up.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";

import { installObsidianStub, TFile } from "./obsidian-stub.mjs";
import { fakeServer } from "./fake-server.mjs";

installObsidianStub();
const { ObsidianBackend } = await import("../src/mcp/obsidian-backend.ts");
const { composeNote } = await import("../src/mcp/write-notes-compose.ts");
const { registerComplementaryTools, guardAppendResult } = await import("../src/mcp/tools-complementary.ts");
const { cliAcceptRefusal } = await import("../src/mcp/tools-cli.ts");
const { registerFsTools, parseGuardFrontmatter } = await import("@vault-mcp/core");

// Obsidian's parseYaml is the `yaml` library; a reader that keeps the last of two keys stands in for the #605 case.
const parseYaml = (y) => YAML.parse(y, { uniqueKeys: false });

/** [name, the frontmatter lines (between the fences), what YAML reads, the refusal]. */
const DIVERGES = /cannot read as YAML does/;
const CASES = [
  ['an escaped key "\\x76erified"', '"\\x76erified":\n  - by: human:owner\n    at: x', (y) => assert.deepEqual(y.verified, [{ by: "human:owner", at: "x" }]), DIVERGES],
  ['an escaped key "\\x61ccepted-by"', '"\\x61ccepted-by": human:owner', (y) => assert.equal(y["accepted-by"], "human:owner"), DIVERGES],
  ['acceptance-status: "\\x61ccepted"', 'acceptance-status: "\\x61ccepted"', (y) => assert.equal(y["acceptance-status"], "accepted"), DIVERGES],
  ["a root flow mapping with an escaped `by`", '{title: A, verified: [{by: "human:ow\\ner", at: x}]}', (y) => assert.equal(y.verified[0].by, "human:ow\ner"), DIVERGES],
  ["a single-quoted '' `by` folded over a blank line", "verified:\n  - by: 'human:o''wner\n\n      b'\n    at: x", (y) => assert.equal(y.verified[0].by, "human:o'wner\nb"), DIVERGES],
  ['a protected property spelled "\\x61uto-accept"', '"\\x61uto-accept": all', (y) => assert.equal(y["auto-accept"], "all"), DIVERGES],
  [
    "the #605 repro: two `verified` blocks, the forged one first",
    "verified:\n  - by: human:forged\n    at: y\nverified:\n  - by: human:owner\n    at: x",
    (y) => assert.deepEqual(y.verified, [{ by: "human:owner", at: "x" }]),
    /repeats the key 'verified'/,
  ],
];
const noteOf = (fm) => `---\n${fm}\n---\nbody\n`;

function fakeApp(files = {}, cacheExtra = {}) {
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
        return { ...(fm ? { frontmatter: fm } : {}), headings: [], ...(cacheExtra[f.path] ?? {}) };
      },
    },
  };
  return { app, store };
}

function harness(files, cacheExtra) {
  const { app, store } = fakeApp(files, cacheExtra);
  const backend = new ObsidianBackend(app);
  const tools = new Map();
  registerFsTools({ registerTool: (name, def, handler) => tools.set(name, { def, handler }) }, backend, { decodeHtml: false });
  return { store, backend, call: (name, args) => tools.get(name).handler(args, {}) };
}

function refused(res, re) {
  assert.equal(res.isError, true, "the write must be refused");
  assert.match(res.content[0].text, /\[accept_forbidden\]/);
  assert.match(res.content[0].text, re);
}

const SEED = "---\nzz: 1\n---\n\nbody ^b\n";

for (const [name, fm, yamlSays, refusal] of CASES) {
  describe(name, () => {
    test("the yaml library reads it as the guard must refuse", () => {
      yamlSays(parseYaml(fm));
    });

    test("obsidian_write_note", async () => {
      const { store, call } = harness({ "n.md": SEED });
      refused(await call("obsidian_write_note", { path: "n.md", content: noteOf(fm), overwrite: true }), refusal);
      assert.equal(store.get("n.md"), SEED);
      refused(await call("obsidian_write_note", { path: "new.md", content: noteOf(fm) }), refusal);
      assert.equal(store.has("new.md"), false);
    });

    test("obsidian_append_note (a fence onto an empty note)", async () => {
      const { store, call } = harness({ "e.md": "" });
      refused(await call("obsidian_append_note", { path: "e.md", content: noteOf(fm) }), refusal);
      assert.equal(store.get("e.md"), "");
    });

    test("obsidian_patch_note (a block replace that closes an open fence)", async () => {
      // The leading fence is still open; replacing block `b` closes it with
      // the case's YAML. The cache is the one Obsidian gives this text, as
      // the patch road checks it against the text (#596).
      const open = "---\nbody ^b\n";
      const at = open.indexOf("body ^b");
      const cache = { "p.md": { blocks: { b: { position: { start: { offset: at }, end: { offset: at + 7 } } } } } };
      const { store, backend } = harness({ "p.md": open }, cache);
      await assert.rejects(() => backend.patchNote("p.md", { type: "block", value: "b" }, "replace", fm + "\n---"), (e) => e.code === "accept_forbidden" && refusal.test(e.message));
      assert.equal(store.get("p.md"), open);
    });

    test("obsidian_append_at_heading: its result check (guardAppendResult)", () => {
      assert.throws(() => guardAppendResult(SEED, noteOf(fm)), (e) => e.code === "accept_forbidden" && refusal.test(e.message));
    });

    test("obsidian_append_at_heading: the registered tool (an insert that closes an open fence)", async () => {
      // The cache is the one Obsidian gives this text.
      const text = "---\n## H\n";
      const at = text.indexOf("## H");
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
            headings: [{ heading: "H", level: 2, position: { start: { line: 1, offset: at }, end: { line: 1, offset: at + 4 } } }],
          }),
        },
      };
      const server = fakeServer();
      registerComplementaryTools(server, app, { getSettings: () => ({ allowlist: [] }) });
      const res = await server.tools.get("obsidian_append_at_heading").handler({ path: "N.md", heading: "H", content: fm + "\n---", create_if_missing: false });
      assert.equal(res.isError, true, res.content?.[0]?.text);
      assert.match(res.content[0].text, /\[accept_forbidden\]/);
      assert.match(res.content[0].text, refusal);
      assert.deepEqual(calls, []);
    });

    test("obsidian_write_notes (composeNote, a body fence)", () => {
      const deps = { stringifyYaml: () => "", parseYaml, formatTs: () => "t", now: 0, mintUid: () => "u" };
      for (const p of [parseYaml, () => ({})]) {
        assert.throws(
          () => composeNote({ ...deps, parseYaml: p, frontmatter: {}, body: noteOf(fm), stamp: false, existing: null }),
          (e) => e.code === "accept_forbidden" && (p === parseYaml || refusal.test(e.message)),
        );
      }
    });

    test("the CLI proxy (cliAcceptRefusal)", () => {
      assert.notEqual(cliAcceptRefusal("create", { path: "x.md", content: noteOf(fm) }, parseYaml), null);
      // Refused by the guard's own reader whatever the injected parser reads.
      assert.match(cliAcceptRefusal("create", { path: "x.md", content: noteOf(fm) }, () => ({})) ?? "", refusal);
    });

    test("obsidian_replace_text (a replace inside the fence)", async () => {
      const { store, backend } = harness({ "r.md": SEED });
      await assert.rejects(
        () => backend.replaceText("r.md", "zz: 1", fm, { all: false }),
        // The replace's own YAML check refuses a repeated key first; either refusal leaves the note as it was.
        (e) => (e.code === "accept_forbidden" && refusal.test(e.message)) || e.code === "frontmatter_edit",
      );
      assert.equal(store.get("r.md"), SEED);
    });
  });
}

// Round 2 of the review: a comment after a quoted guarded value. The old reader
// read `'accepted' #'` as `accepted' #` and admitted it; YAML reads `accepted`.
const COMMENT_CASES = [
  ["a single-quoted value, then ` #'`", "acceptance-status: 'accepted' #'"],
  ['a double-quoted value, then ` #"`', 'acceptance-status: "accepted" #"'],
  ["a tab before the `#`", "acceptance-status: 'accepted'\t#'"],
  ["a sequence item", "acceptance-status:\n  - 'accepted' # x'"],
  ["a nested mapping value", "acceptance-status:\n  value: 'accepted' #'"],
];
const ACCEPTED = /accepted value|acceptance-status|cannot read as YAML does/;
for (const [name, fm] of COMMENT_CASES) {
  CASES.push([`round 2: ${name}`, fm, (y) => assert.match(JSON.stringify(y["acceptance-status"]), /"accepted"/), ACCEPTED]);
}
for (const [name, fm, yamlSays, refusal] of CASES.filter(([n]) => n.startsWith("round 2"))) {
  describe(name, () => {
    test("the yaml library reads an accepted value", () => yamlSays(parseYaml(fm)));
    test("obsidian_write_note", async () => {
      const { store, call } = harness({ "n.md": SEED });
      refused(await call("obsidian_write_note", { path: "n.md", content: noteOf(fm), overwrite: true }), refusal);
      assert.equal(store.get("n.md"), SEED);
    });
    test("obsidian_append_note", async () => {
      const { store, call } = harness({ "e.md": "" });
      refused(await call("obsidian_append_note", { path: "e.md", content: noteOf(fm) }), refusal);
      assert.equal(store.get("e.md"), "");
    });
    test("obsidian_patch_note", async () => {
      // As above: a block replace that closes an open fence, with the cache Obsidian gives the text.
      const open = "---\nbody ^b\n";
      const cache = { "p.md": { blocks: { b: { position: { start: { offset: 4 }, end: { offset: 11 } } } } } };
      const { store, backend } = harness({ "p.md": open }, cache);
      await assert.rejects(() => backend.patchNote("p.md", { type: "block", value: "b" }, "replace", fm + "\n---"), (e) => e.code === "accept_forbidden");
      assert.equal(store.get("p.md"), open);
    });
    test("obsidian_append_at_heading: its result check", () => {
      assert.throws(() => guardAppendResult(SEED, noteOf(fm)), (e) => e.code === "accept_forbidden");
    });
    test("obsidian_write_notes (composeNote)", () => {
      const deps = { stringifyYaml: () => "", formatTs: () => "t", now: 0, mintUid: () => "u" };
      assert.throws(() => composeNote({ ...deps, parseYaml, frontmatter: {}, body: noteOf(fm), stamp: false, existing: null }), (e) => e.code === "accept_forbidden");
    });
    test("the CLI proxy", () => {
      assert.notEqual(cliAcceptRefusal("create", { path: "x.md", content: noteOf(fm) }, parseYaml), null);
    });
    test("obsidian_replace_text", async () => {
      const { store, backend } = harness({ "r.md": SEED });
      await assert.rejects(() => backend.replaceText("r.md", "zz: 1", fm, { all: false }), (e) => e.code === "accept_forbidden");
      assert.equal(store.get("r.md"), SEED);
    });
  });
}

describe("round 2: an ordinary comment after a guarded value passes", () => {
  test("obsidian_write_note carries a record with comments, and a draft status with a comment", async () => {
    const seed = noteOf("verified:\n  - by: human:owner\n    at: x");
    const next = noteOf("verified: # c\n  - by: human:owner # the owner\n    at: x\nacceptance-status: draft # todo");
    const { store, call } = harness({ "n.md": seed });
    const res = await call("obsidian_write_note", { path: "n.md", content: next, overwrite: true });
    assert.notEqual(res.isError, true, res.content?.[0]?.text);
    assert.equal(store.get("n.md"), next);
  });
});

describe("normal notes still pass on the host roads", () => {
  const OK = [
    ["a note with no verified key", "title: A\nstatus: draft"],
    ["a backslash in some other key's value", 'title: "a\\\\b \\x41"'],
    ["a quoted key without a backslash", '"title": A'],
  ];
  for (const [name, fm] of OK) {
    test(name, async () => {
      const { store, call, backend } = harness({ "r.md": SEED });
      const res = await call("obsidian_write_note", { path: "n.md", content: noteOf(fm) });
      assert.notEqual(res.isError, true, res.content?.[0]?.text);
      assert.equal(store.get("n.md"), noteOf(fm));
      assert.equal(cliAcceptRefusal("create", { path: "x.md", content: noteOf(fm) }, parseYaml), null);
      const deps = { stringifyYaml: () => "", parseYaml, formatTs: () => "t", now: 0, mintUid: () => "u" };
      composeNote({ ...deps, frontmatter: {}, body: noteOf(fm), stamp: false, existing: null });
      await backend.replaceText("r.md", "zz: 1", fm, { all: false });
      assert.equal(store.get("r.md"), `---\n${fm}\n---\n\nbody ^b\n`);
    });
  }
});
