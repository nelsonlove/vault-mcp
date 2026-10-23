/**
 * replace-text.test.mjs — obsidian_replace_text on the live host, built through the REAL server
 * wiring (buildMcpServer: the guard, the kernel with if_rev, idempotency_key, the record guard and
 * the journal, the allowlist, the write scope) and called over a real MCP client. The vault is an
 * in-memory fake that behaves like Obsidian where this tool touches it. The notes are made up.
 *
 * The review question this file answers: can this road bypass a guard that obsidian_patch_note or
 * obsidian_manage_frontmatter enforces? Each refusal is asserted with the note left as it was.
 */
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { installObsidianStub, TFile, TFolder } from "./obsidian-stub.mjs";

installObsidianStub();
const { buildMcpServer } = await import("../src/mcp/server.ts");
const { Kernel, WriteQueue, WriteJournal, IdempotencyStore, LockStore } = await import("../src/kernel/index.ts");
const { syncKindOf } = await import("../src/kernel/sync-guard.ts");
const { MCP_SURFACE_INVENTORY } = await import("../src/kernel/operations/inventory-mcp.ts");
const { CHARACTER_LIMIT, DEFAULT_PROTECTED_PROPERTIES, setDeclaredProtectedProperties, READ_PROFILE_TOOLS } = await import("@vault-mcp/core");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const silent = () => {};
beforeEach(() => setDeclaredProtectedProperties(DEFAULT_PROTECTED_PROPERTIES, silent));
after(() => setDeclaredProtectedProperties(DEFAULT_PROTECTED_PROPERTIES, silent));

/** An in-memory vault: stable TFile objects, folders, mtimes that move on every write. */
function fakeApp(initial) {
  const text = new Map(Object.entries(initial));
  const files = new Map();
  const folders = new Map();
  let clock = 1000;
  const stamp = (f) => { f.stat = { mtime: clock++, ctime: 1, size: text.get(f.path).length }; };
  const folderOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const addFolders = (p) => { let d = folderOf(p); while (d) { if (!folders.has(d)) folders.set(d, new TFolder(d)); d = folderOf(d); } };
  const mk = (p) => { const f = new TFile(p); stamp(f); files.set(p, f); addFolders(p); return f; };
  for (const p of text.keys()) mk(p);
  const all = () => [...files.values()];
  const write = (f, t) => { text.set(f.path, t); stamp(f); };
  const app = {
    vault: {
      adapter: { basePath: "/nonexistent-vault" },
      configDir: ".obsidian",
      getName: () => "test",
      getMarkdownFiles: () => all().filter((f) => f.extension === "md"),
      getFiles: all,
      getAllLoadedFiles: () => [...all(), ...folders.values()],
      getAbstractFileByPath: (p) => files.get(p) ?? folders.get(p) ?? null,
      getRoot: () => new TFolder("", [...folders.values()]),
      on: () => ({}),
      read: async (f) => text.get(f.path),
      cachedRead: async (f) => text.get(f.path),
      async create(p, c) { text.set(p, c); return mk(p); },
      async modify(f, c) { write(f, c); },
      async process(f, fn) { const next = fn(text.get(f.path)); if (next !== text.get(f.path)) write(f, next); return next; },
      async createFolder(p) { folders.set(p, new TFolder(p)); },
    },
    metadataCache: {
      initialized: true,
      resolvedLinks: {},
      unresolvedLinks: {},
      getFileCache: () => ({ links: [], embeds: [] }),
      getFirstLinkpathDest: () => null,
      fileToLinktext: (f) => f.basename,
      on: () => ({}),
    },
    workspace: { layoutReady: true, iterateAllLeaves: (cb) => cb({}), getActiveFile: () => null, on: () => ({}) },
    plugins: { plugins: {}, manifests: {}, enabledPlugins: new Set() },
    internalPlugins: { getPluginById: () => null },
    commands: { commands: {}, executeCommandById: () => true },
    fileManager: { async processFrontMatter() {} },
  };
  const mtime = (p) => files.get(p)?.stat.mtime;
  return { app, text, mtime };
}

/** The real server over an MCP client, with a real kernel whose rev and record probes read the fake vault. */
async function harness(initial = {}, { settings = {}, records = [] } = {}) {
  const v = fakeApp(initial);
  const jfiles = new Map();
  const adapter = { async exists(p) { return jfiles.has(p); }, async mkdir() {}, async write(p, d) { jfiles.set(p, d); }, async append(p, d) { jfiles.set(p, (jfiles.get(p) ?? "") + d); } };
  const journal = new WriteJournal(adapter, "j", () => new Date("2026-10-21T12:00:00Z"));
  const probe = { uid: () => undefined, rev: (p) => v.mtime(p), record: (p) => (records.includes(p) ? true : undefined) };
  const kernel = new Kernel(new WriteQueue(5000), journal, probe, new IdempotencyStore(), new LockStore());
  const ctx = {
    pluginVersion: "0.0.0", socketPath: "/nonexistent.sock", vaultName: "test", enabledPlugins: () => [],
    getSettings: () => ({ allowlist: [], readOnly: false, trustedReadOnlyPlugins: [], ...settings }),
    kernel,
  };
  const server = buildMcpServer(v.app, ctx, {});
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await client.connect(a);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const recordsOf = () => (jfiles.get("j/2026-10.jsonl") ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { ...v, client, call, records: recordsOf, close: () => client.close() };
}

const errText = (r) => (r.isError ? r.content[0].text : "");
let keyN = 0;
const key = () => `k-${++keyN}`;
const T = "obsidian_replace_text";

const NOTE = "---\ntitle: Plan\nstatus: draft\n---\n# Plan\n\nThe colour is blue.\nThe sky is blue.\n";

describe("obsidian_replace_text — good paths", () => {
  test("one match: replaced, the rest kept; spans, count and the new rev returned; journaled as its own op", async () => {
    const h = await harness({ "Notes/Plan.md": NOTE });
    const rev = h.mtime("Notes/Plan.md");
    const r = await h.call(T, { path: "Notes/Plan.md", old: "colour is blue", new: "colour is green", if_rev: rev, idempotency_key: key(), intent: "fix the colour" });
    assert.equal(r.isError, undefined, errText(r));
    assert.equal(h.text.get("Notes/Plan.md"), NOTE.replace("colour is blue", "colour is green"));
    const s = r.structuredContent;
    assert.equal(s.count, 1);
    assert.equal(s.frontmatter_touched, false);
    assert.equal(s.line_endings, "lf");
    assert.equal(s.spans.length, 1);
    assert.equal(s.spans[0].line, 7);
    assert.equal(s.spans[0].offset, NOTE.indexOf("colour is blue"));
    assert.match(s.spans[0].before, /The colour is blue\./);
    assert.match(s.spans[0].after, /The colour is green\./);
    assert.equal(s.rev, h.mtime("Notes/Plan.md"));
    assert.notEqual(s.rev, rev);
    const rec = h.records().filter((x) => x.op === T);
    assert.equal(rec.length, 1);
    assert.equal(rec[0].outcome, "ok");
    assert.equal(rec[0].target.path, "Notes/Plan.md");
    assert.equal(rec[0].revBefore, rev);
    assert.equal(rec[0].revAfter, s.rev);
    assert.equal(rec[0].intent, "fix the colour");
    // Note text never lands in the journal, however short.
    assert.equal(rec[0].argsDigest.old, "<14 chars>");
    assert.equal(rec[0].argsDigest.new, "<15 chars>");
    await h.close();
  });

  test("all: true replaces every match; spans for each; the new text may be empty", async () => {
    const h = await harness({ "Notes/Plan.md": NOTE });
    const r = await h.call(T, { path: "Notes/Plan.md", old: "blue", new: "", all: true, if_rev: h.mtime("Notes/Plan.md"), idempotency_key: key() });
    assert.equal(r.isError, undefined, errText(r));
    assert.equal(h.text.get("Notes/Plan.md"), NOTE.replaceAll("blue", ""));
    assert.equal(r.structuredContent.count, 2);
    assert.deepEqual(r.structuredContent.spans.map((x) => x.line), [7, 8]);
    await h.close();
  });

  test("a replace inside the frontmatter that keeps it valid goes through, and says so", async () => {
    const h = await harness({ "Notes/Plan.md": NOTE });
    const r = await h.call(T, { path: "Notes/Plan.md", old: "status: draft", new: "status: active", if_rev: h.mtime("Notes/Plan.md"), idempotency_key: key() });
    assert.equal(r.isError, undefined, errText(r));
    assert.equal(r.structuredContent.frontmatter_touched, true);
    assert.match(h.text.get("Notes/Plan.md"), /^---\ntitle: Plan\nstatus: active\n---\n/);
    await h.close();
  });

  test("CRLF note: an LF `old` that spans lines finds nothing and says why; the CRLF form is replaced", async () => {
    const crlf = "# Plan\r\nline one\r\nline two\r\n";
    const h = await harness({ "Notes/Win.md": crlf });
    let r = await h.call(T, { path: "Notes/Win.md", old: "one\nline", new: "1\nline", if_rev: h.mtime("Notes/Win.md"), idempotency_key: key() });
    assert.match(errText(r), /^Error \[no_match\]: .*0 times.*CRLF line endings/);
    assert.equal(h.text.get("Notes/Win.md"), crlf);
    r = await h.call(T, { path: "Notes/Win.md", old: "one\r\nline", new: "1\r\nline", if_rev: h.mtime("Notes/Win.md"), idempotency_key: key() });
    assert.equal(r.isError, undefined, errText(r));
    assert.equal(r.structuredContent.line_endings, "crlf");
    assert.equal(h.text.get("Notes/Win.md"), "# Plan\r\nline 1\r\nline two\r\n");
    await h.close();
  });

  test("a retry with the same key replays the first result and writes once", async () => {
    const h = await harness({ "Notes/Plan.md": NOTE });
    const args = { path: "Notes/Plan.md", old: "sky", new: "sea", if_rev: h.mtime("Notes/Plan.md"), idempotency_key: key() };
    const r1 = await h.call(T, args);
    assert.equal(r1.isError, undefined, errText(r1));
    const after1 = h.text.get("Notes/Plan.md");
    const mtime1 = h.mtime("Notes/Plan.md");
    const r2 = await h.call(T, args);
    assert.equal(r2.isError, undefined, errText(r2));
    assert.deepEqual(r2.structuredContent, r1.structuredContent);
    assert.equal(h.text.get("Notes/Plan.md"), after1);
    assert.equal(h.mtime("Notes/Plan.md"), mtime1, "no second write");
    const outcomes = h.records().filter((x) => x.op === T).map((x) => x.outcome);
    assert.deepEqual(outcomes, ["ok", "deduped"]);
    // The same key with different arguments is a mismatch, never a silent replay.
    const r3 = await h.call(T, { ...args, new: "lake" });
    assert.match(errText(r3), /^Error \[idempotency_mismatch\]/);
    await h.close();
  });
});

describe("obsidian_replace_text — refusals (nothing written)", () => {
  test("0 matches and many matches without all name the count", async () => {
    const h = await harness({ "Notes/Plan.md": NOTE });
    let r = await h.call(T, { path: "Notes/Plan.md", old: "purple", new: "red", if_rev: h.mtime("Notes/Plan.md"), idempotency_key: key() });
    assert.match(errText(r), /^Error \[no_match\]: 'Notes\/Plan\.md': `old` was found 0 times/);
    r = await h.call(T, { path: "Notes/Plan.md", old: "blue", new: "red", if_rev: h.mtime("Notes/Plan.md"), idempotency_key: key() });
    assert.match(errText(r), /^Error \[many_matches\]: .*found 2 times \(at lines 7, 8\).*all: true/);
    assert.equal(h.text.get("Notes/Plan.md"), NOTE);
    await h.close();
  });

  test("an empty `old`, or `old` equal to `new`, is refused", async () => {
    const h = await harness({ "Notes/Plan.md": NOTE });
    let r = await h.call(T, { path: "Notes/Plan.md", old: "", new: "x", if_rev: h.mtime("Notes/Plan.md"), idempotency_key: key() });
    assert.equal(r.isError, true);
    r = await h.call(T, { path: "Notes/Plan.md", old: "sky", new: "sky", if_rev: h.mtime("Notes/Plan.md"), idempotency_key: key() });
    assert.match(errText(r), /^Error \[invalid_replace\]/);
    assert.equal(h.text.get("Notes/Plan.md"), NOTE);
    await h.close();
  });

  test("a stale rev is a rev conflict, journaled", async () => {
    const h = await harness({ "Notes/Plan.md": NOTE });
    const stale = h.mtime("Notes/Plan.md") - 1;
    const r = await h.call(T, { path: "Notes/Plan.md", old: "sky", new: "sea", if_rev: stale, idempotency_key: key() });
    assert.match(errText(r), /^Error \[rev_conflict\]/);
    assert.equal(h.text.get("Notes/Plan.md"), NOTE);
    assert.deepEqual(h.records().filter((x) => x.op === T).map((x) => x.outcome), ["conflict"]);
    await h.close();
  });

  test("a missing idempotency_key, or a missing if_rev, is protection_required before the queue", async () => {
    const h = await harness({ "Notes/Plan.md": NOTE });
    let r = await h.call(T, { path: "Notes/Plan.md", old: "sky", new: "sea", if_rev: h.mtime("Notes/Plan.md") });
    assert.match(errText(r), /^Error \[protection_required\]: 'obsidian_replace_text' requires idempotency_key \(protection 'both'/);
    r = await h.call(T, { path: "Notes/Plan.md", old: "sky", new: "sea", idempotency_key: key() });
    assert.match(errText(r), /^Error \[protection_required\]: 'obsidian_replace_text' requires if_rev \(protection 'both'/);
    r = await h.call(T, { path: "Notes/Plan.md", old: "sky", new: "sea" });
    assert.match(errText(r), /requires if_rev and idempotency_key/);
    assert.equal(h.text.get("Notes/Plan.md"), NOTE);
    assert.equal(h.records().length, 0, "refused before the queue: not journaled");
    await h.close();
  });

  test("a verified entry cannot be changed, removed or added by a replace", async () => {
    const rec = "---\nverified:\n  - by: human:pat\n    at: 2026-09-25T05:08:39-04:00\ntitle: T\n---\nbody\n";
    const h = await harness({ "Notes/V.md": rec, "Notes/Plain.md": "---\ntitle: P\n---\nbody\n" });
    for (const [old, nw] of [
      ["human:pat", "human:sam"],
      ["2026-09-25T05:08:39-04:00", "2026-09-26T05:08:39-04:00"],
      ["verified:\n  - by: human:pat\n    at: 2026-09-25T05:08:39-04:00\n", ""],
    ]) {
      const r = await h.call(T, { path: "Notes/V.md", old, new: nw, if_rev: h.mtime("Notes/V.md"), idempotency_key: key() });
      assert.match(errText(r), /^Error \[accept_forbidden\]: .*verification field 'verified'/, `${old} → ${nw}`);
    }
    assert.equal(h.text.get("Notes/V.md"), rec);
    const r = await h.call(T, { path: "Notes/Plain.md", old: "title: P", new: "title: P\nverified:\n  - by: human:pat", if_rev: h.mtime("Notes/Plain.md"), idempotency_key: key() });
    assert.match(errText(r), /^Error \[accept_forbidden\]: .*introduce the verification field 'verified'/);
    assert.equal(h.text.get("Notes/Plain.md"), "---\ntitle: P\n---\nbody\n");
    await h.close();
  });

  test("the acceptance keys cannot be set by a replace", async () => {
    const h = await harness({ "Notes/Plan.md": NOTE });
    for (const nw of ["acceptance-status: accepted", "accepted-by: someone", "accepted_on: 2026-10-21"]) {
      const r = await h.call(T, { path: "Notes/Plan.md", old: "status: draft", new: nw, if_rev: h.mtime("Notes/Plan.md"), idempotency_key: key() });
      assert.match(errText(r), /^Error \[accept_forbidden\]/, nw);
    }
    assert.equal(h.text.get("Notes/Plan.md"), NOTE);
    await h.close();
  });

  test("a declared protected property cannot be introduced, changed or removed", async () => {
    setDeclaredProtectedProperties([...DEFAULT_PROTECTED_PROPERTIES, { key: "review-tier", grade: "agent-forbidden" }], silent);
    const note = "---\ntitle: T\nreview-tier: low\n---\nbody\n";
    const h = await harness({ "Notes/P.md": note, "Notes/Q.md": NOTE });
    for (const [old, nw] of [["review-tier: low", "review-tier: high"], ["review-tier: low\n", ""]]) {
      const r = await h.call(T, { path: "Notes/P.md", old, new: nw, if_rev: h.mtime("Notes/P.md"), idempotency_key: key() });
      assert.match(errText(r), /^Error \[accept_forbidden\]: .*protected property 'review-tier'/, old);
    }
    const r = await h.call(T, { path: "Notes/Q.md", old: "status: draft", new: "auto-accept: all", if_rev: h.mtime("Notes/Q.md"), idempotency_key: key() });
    assert.match(errText(r), /^Error \[accept_forbidden\]: .*protected property 'auto-accept'/);
    assert.equal(h.text.get("Notes/P.md"), note);
    assert.equal(h.text.get("Notes/Q.md"), NOTE);
    await h.close();
  });

  test("the frontmatter guard: no fence edits, no crossing, no early close, no broken YAML, no new block", async () => {
    const h = await harness({ "Notes/Plan.md": NOTE, "Notes/Bare.md": "Hello\nworld\n", "Notes/Bom.md": "﻿---\na: 1\n---\nbody\n" });
    const cases = [
      ["Notes/Plan.md", "---\ntitle", "title", /touches a frontmatter fence/],
      ["Notes/Plan.md", "draft\n---\n# Plan", "draft\n# Plan", /touches a frontmatter fence/],
      ["Notes/Plan.md", "---\n# Plan", "--- \n# Plan", /touches a frontmatter fence/],
      ["Notes/Plan.md", "status: draft", "status: draft\n---\nmore", /closing fence/],
      ["Notes/Plan.md", "status: draft", "status: [draft", /would not parse as YAML/],
      ["Notes/Plan.md", "status: draft", "- draft", /would not parse as YAML properties/],
      ["Notes/Plan.md", "title: Plan", "title: Plan\ntitle: Again", /would not parse as YAML/],
      ["Notes/Bare.md", "Hello\n", "---\ntags: x\n---\nHello\n", /would give it a frontmatter block/],
      ["Notes/Bom.md", "﻿---", "---", /byte-order mark/],
    ];
    for (const [p, old, nw, re] of cases) {
      const before = h.text.get(p);
      const r = await h.call(T, { path: p, old, new: nw, if_rev: h.mtime(p), idempotency_key: key() });
      assert.match(errText(r), /^Error \[(frontmatter_edit|invalid_replace)\]/, `${p}: ${JSON.stringify(old)}`);
      assert.match(errText(r), re, `${p}: ${JSON.stringify(old)}`);
      assert.equal(h.text.get(p), before, p);
    }
    await h.close();
  });

  test("outside the path allowlist: refused before the queue", async () => {
    const h = await harness({ "Notes/Plan.md": NOTE, "Open/Ok.md": "one\n" }, { settings: { allowlist: ["Open"] } });
    let r = await h.call(T, { path: "Notes/Plan.md", old: "sky", new: "sea", if_rev: h.mtime("Notes/Plan.md"), idempotency_key: key() });
    assert.match(errText(r), /out_of_allowlist|outside the allowlist/i);
    assert.equal(h.text.get("Notes/Plan.md"), NOTE);
    r = await h.call(T, { path: "Open/Ok.md", old: "one", new: "two", if_rev: h.mtime("Open/Ok.md"), idempotency_key: key() });
    assert.equal(r.isError, undefined, errText(r));
    await h.close();
  });

  test("read-only mode and a create-only write scope refuse it", async () => {
    let h = await harness({ "Notes/Plan.md": NOTE }, { settings: { readOnly: true } });
    let r = await h.call(T, { path: "Notes/Plan.md", old: "sky", new: "sea", if_rev: h.mtime("Notes/Plan.md"), idempotency_key: key() });
    assert.equal(r.isError, true);
    assert.equal(h.text.get("Notes/Plan.md"), NOTE);
    await h.close();
    h = await harness({ "Notes/Plan.md": NOTE }, { settings: { writeScope: { mode: "create-only", paths: ["**"] } } });
    r = await h.call(T, { path: "Notes/Plan.md", old: "sky", new: "sea", if_rev: h.mtime("Notes/Plan.md"), idempotency_key: key() });
    assert.match(errText(r), /^Error \[write_scope\]/);
    assert.equal(h.text.get("Notes/Plan.md"), NOTE);
    await h.close();
  });

  test("a record note is refused at dequeue (record_immutable), journaled", async () => {
    const h = await harness({ "Records/R.md": NOTE }, { records: ["Records/R.md"] });
    const r = await h.call(T, { path: "Records/R.md", old: "sky", new: "sea", if_rev: h.mtime("Records/R.md"), idempotency_key: key() });
    assert.match(errText(r), /^Error \[record_immutable\]/);
    assert.equal(h.text.get("Records/R.md"), NOTE);
    assert.deepEqual(h.records().filter((x) => x.op === T).map((x) => x.outcome), ["error"]);
    await h.close();
  });

  test("a missing note is not created", async () => {
    const h = await harness({});
    const r = await h.call(T, { path: "Notes/None.md", old: "a", new: "b", if_rev: 1, idempotency_key: key() });
    assert.equal(r.isError, true);
    assert.equal(h.text.has("Notes/None.md"), false);
    await h.close();
  });

  test("a truncated read: `new` carrying the read trailer is refused", async () => {
    const h = await harness({ "Notes/Plan.md": NOTE });
    const r = await h.call(T, { path: "Notes/Plan.md", old: "sky", new: "sky\n[truncated: note is 200000 chars, showing first 100000]", if_rev: h.mtime("Notes/Plan.md"), idempotency_key: key() });
    assert.match(errText(r), /^Error \[truncated_read\]/);
    assert.equal(h.text.get("Notes/Plan.md"), NOTE);
    await h.close();
  });

  test("a long note: a match past the read limit is refused, unless a whole read on this connection proves the rev", async () => {
    const long = "# Long\n\nhead marker\n" + "x".repeat(CHARACTER_LIMIT + 50) + "\ntail marker\n";
    const h = await harness({ "Notes/Long.md": long });
    // A match inside the first part needs no proof.
    let r = await h.call(T, { path: "Notes/Long.md", old: "head marker", new: "head mark", if_rev: h.mtime("Notes/Long.md"), idempotency_key: key() });
    assert.equal(r.isError, undefined, errText(r));
    // Past the limit: refused with the way out, nothing written.
    const before = h.text.get("Notes/Long.md");
    r = await h.call(T, { path: "Notes/Long.md", old: "tail marker", new: "tail mark", if_rev: h.mtime("Notes/Long.md"), idempotency_key: key() });
    assert.match(errText(r), /^Error \[truncated_read\]: .*past what a cut read showed/);
    assert.equal(h.text.get("Notes/Long.md"), before);
    // A cut read proves nothing; a whole read does, at its rev.
    const whole = await h.call("obsidian_read_note", { path: "Notes/Long.md", full: true });
    assert.equal(whole.isError, undefined, errText(whole));
    r = await h.call(T, { path: "Notes/Long.md", old: "tail marker", new: "tail mark", if_rev: whole.structuredContent.rev, idempotency_key: key() });
    assert.equal(r.isError, undefined, errText(r));
    assert.ok(h.text.get("Notes/Long.md").endsWith("\ntail mark\n"));
    assert.equal(h.text.get("Notes/Long.md").length, long.length - 4, "the whole note kept, tail included");
    await h.close();
  });
});

describe("obsidian_replace_text — surface", () => {
  test("listed with a strict schema; if_rev and idempotency_key are REQUIRED in its schema", async () => {
    const h = await harness({});
    const tool = (await h.client.listTools()).tools.find((t) => t.name === T);
    assert.ok(tool, "registered");
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.match(tool.inputSchema.properties.if_rev.description, /^REQUIRED/);
    assert.match(tool.inputSchema.properties.idempotency_key.description, /^REQUIRED/);
    const r = await h.call(T, { path: "Notes/A.md", old: "a", new: "b", regex: true, if_rev: 1, idempotency_key: key() });
    assert.equal(r.isError, true, "an unnamed argument is refused");
    await h.close();
  });

  test("inventory row: protection both, Sync kind content; outside the read profile", () => {
    const row = MCP_SURFACE_INVENTORY.find((r) => r.tool === T);
    assert.equal(row.protection, "both");
    assert.equal(syncKindOf(T, {}), "content");
    assert.equal(READ_PROFILE_TOOLS.includes(T), false);
  });
});
