/**
 * full-read.test.mjs — the host's half of #443, through the REAL makeGuarded
 * with a REAL kernel (so if_rev is honoured), the real ObsidianBackend and
 * registerFsTools, wired as server.ts wires them: one WholeReads per
 * connection, told by the read tool, consulted by the guard (with the note's
 * current rev) and by the backend's replace rule.
 *
 * The two cases the rear admiral named: a whole read followed by a change
 * from Obsidian itself must still be refused (the rev moved), and a remembered
 * rev must not carry over to another path.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { installObsidianStub, TFile } from "./obsidian-stub.mjs";

installObsidianStub();
const { ObsidianBackend } = await import("../src/mcp/obsidian-backend.ts");
const { makeGuarded } = await import("../src/mcp/guarded.ts");
const { Kernel, WriteQueue, WriteJournal, IdempotencyStore, LockStore } = await import("../src/kernel/index.ts");
const { registerFsTools, CHARACTER_LIMIT, WholeReads, wholeReadToken } = await import("@vault-mcp/core");

const ACTOR = { transport: "mcp", client: "claude-code/1.0.0", connection: "conn-1" };
const OPEN_SETTINGS = { readOnly: false, allowlist: [] };
const LONG = 150_000;
const BODY = "---\ntitle: Big\n---\n# Big\n\n" + "x".repeat(LONG - 40) + "\n\n## Tail\n";

function fixture() {
  const store = new Map([["Big.md", BODY], ["Other.md", BODY.replace("Big", "Other")], ["Small.md", "# Small"]]);
  const mtimes = new Map([["Big.md", 1700], ["Other.md", 1700], ["Small.md", 1700]]);
  const fileOf = (p) => {
    if (!store.has(p)) return null;
    const f = new TFile(p, mtimes.get(p));
    f.stat.size = store.get(p).length;
    return f;
  };
  const bump = (p) => mtimes.set(p, mtimes.get(p) + 1);
  const app = {
    vault: {
      getAbstractFileByPath: fileOf,
      read: async (f) => store.get(f.path) ?? "",
      cachedRead: async (f) => store.get(f.path) ?? "",
      create: async (p, c) => { store.set(p, c); mtimes.set(p, 1700); },
      modify: async (f, c) => { store.set(f.path, c); bump(f.path); },
      append: async (f, c) => { store.set(f.path, (store.get(f.path) ?? "") + c); bump(f.path); },
      createFolder: async () => {},
      getMarkdownFiles: () => [...store.keys()].map(fileOf),
    },
    metadataCache: {
      resolvedLinks: {},
      getFileCache: (f) => {
        const text = store.get(f.path) ?? "";
        const headings = [];
        const re = /^(#+) (.+)$/gm; let m;
        while ((m = re.exec(text))) headings.push({ heading: m[2], level: m[1].length, position: { start: { offset: m.index }, end: { offset: m.index + m[0].length } } });
        return { headings };
      },
    },
    fileManager: { processFrontMatter: async () => {} },
  };
  const wholeReads = new WholeReads();
  const probe = { uid: () => undefined, rev: (p) => mtimes.get(p), record: () => undefined };
  const files = new Map();
  const adapter = { files, async exists(p) { return files.has(p); }, async mkdir() {}, async write(p, d) { files.set(p, d); }, async append(p, d) { files.set(p, (files.get(p) ?? "") + d); } };
  const journal = new WriteJournal(adapter, "dir/journal", () => new Date("2026-09-30T12:00:00Z"));
  const kernel = new Kernel(new WriteQueue(1000), journal, probe, new IdempotencyStore(), new LockStore());
  const guarded = makeGuarded({
    getSettings: () => OPEN_SETTINGS,
    kernel,
    actor: () => ACTOR,
    wholeReads,
    noteStat: (p) => (store.has(p) ? { mtime: mtimes.get(p), size: store.get(p).length } : undefined),
    noteLength: async (p) => store.get(p)?.length,
  });
  const backend = new ObsidianBackend(app, () => null);
  const handlers = new Map();
  const server = {
    registerTool(name, meta, handler) { handlers.set(name, guarded(meta, handler, name)); return { name, meta }; },
    call(name, args) { return handlers.get(name)(args, {}); },
  };
  registerFsTools(server, backend, {
    rev: (p) => probe.rev(p),
    wholeToken: (p) => (store.has(p) ? { token: wholeReadToken(mtimes.get(p), store.get(p).length), rev: mtimes.get(p) } : undefined),
    onWholeRead: (p, token) => wholeReads.remember(p, token),
    onCutRead: (p) => wholeReads.forget(p),
  });
  return { server, store, mtimes, bump };
}

let n = 0;
const key = () => `k-${++n}`;
const errText = (res) => (res.isError ? res.content[0].text : "");

describe("a whole read is the proof a whole-note overwrite needs", () => {
  test("full: true serves the whole note with its rev; an overwrite conditioned on that rev lands, and the tail is the caller's", async () => {
    const { server, store } = fixture();
    const read = (await server.call("obsidian_read_note", { path: "Big.md", full: true })).structuredContent;
    assert.equal(read.whole, true);
    assert.equal(read.content, BODY);
    assert.equal(read.rev, 1700);
    const rewritten = BODY.replace("# Big", "# Big (rewritten)").replace("## Tail\n", "## Tail\n\nmore\n");
    const res = await server.call("obsidian_write_note", { path: "Big.md", content: rewritten, overwrite: true, if_rev: read.rev, idempotency_key: key() });
    assert.equal(res.isError, undefined, errText(res));
    assert.equal(store.get("Big.md"), rewritten);
  });

  test("a whole read followed by a change from Obsidian itself is still refused: the rev moved", async () => {
    const { server, store, bump } = fixture();
    const read = (await server.call("obsidian_read_note", { path: "Big.md", full: true })).structuredContent;
    // Obsidian (the user, another plugin) edits the note: content and rev move.
    store.set("Big.md", BODY + "\nedited in Obsidian\n"); bump("Big.md");
    const res = await server.call("obsidian_write_note", { path: "Big.md", content: BODY.replace("# Big", "# Big (stale rewrite)"), overwrite: true, if_rev: read.rev, idempotency_key: key() });
    assert.equal(res.isError, true);
    // At dequeue the kernel's own if_rev check answers first (rev_conflict);
    // had it not, the rule would (truncated_read). Either way: refused.
    assert.match(errText(res), /^Error \[(rev_conflict|truncated_read)\]/);
    assert.match(store.get("Big.md"), /edited in Obsidian/, "the edit from Obsidian is intact");
  });

  test("an edit that keeps the mtime (a coarse-mtime volume) still spends the proof: the size moved", async () => {
    const { server, store } = fixture();
    const read = (await server.call("obsidian_read_note", { path: "Big.md", full: true })).structuredContent;
    store.set("Big.md", BODY + "\nsame tick\n"); // the mtime stays 1700
    const res = await server.call("obsidian_write_note", { path: "Big.md", content: BODY.replace("# Big", "# Big (stale)"), overwrite: true, if_rev: read.rev, idempotency_key: key() });
    assert.equal(res.isError, true);
    assert.match(errText(res), /^Error \[truncated_read\]/);
    assert.match(store.get("Big.md"), /same tick/);
  });

  test("a cut read served after the whole read forgets the proof", async () => {
    const { server, store } = fixture();
    const read = (await server.call("obsidian_read_note", { path: "Big.md", full: true })).structuredContent;
    const cut = (await server.call("obsidian_read_note", { path: "Big.md" })).structuredContent;
    assert.equal(cut.truncated, true);
    const res = await server.call("obsidian_write_note", { path: "Big.md", content: BODY.replace("# Big", "# Big (from which read?)"), overwrite: true, if_rev: read.rev, idempotency_key: key() });
    assert.equal(res.isError, true);
    assert.match(errText(res), /^Error \[truncated_read\]/);
    assert.equal(store.get("Big.md"), BODY);
  });

  test("a remembered rev never carries over to another path", async () => {
    const { server, store } = fixture();
    const read = (await server.call("obsidian_read_note", { path: "Big.md", full: true })).structuredContent;
    // Other.md sits at the same rev value; it was never read whole.
    const res = await server.call("obsidian_write_note", { path: "Other.md", content: "# Other (rewritten)\n", overwrite: true, if_rev: read.rev, idempotency_key: key() });
    assert.equal(res.isError, true);
    assert.match(errText(res), /^Error \[truncated_read\]/);
    assert.match(store.get("Other.md"), /^---\ntitle: Other/);
  });

  test("a cut read's rev proves nothing, even with if_rev", async () => {
    const { server, store } = fixture();
    const read = (await server.call("obsidian_read_note", { path: "Big.md" })).structuredContent;
    assert.equal(read.truncated, true);
    const stripped = read.content.replace(/\n\n\[truncated:[^\n]*$/, "") + "\n\nmore than a trailer of new text, appended after the cut.\n";
    const res = await server.call("obsidian_write_note", { path: "Big.md", content: stripped, overwrite: true, if_rev: read.rev, idempotency_key: key() });
    assert.equal(res.isError, true);
    assert.match(errText(res), /^Error \[truncated_read\]/);
    assert.equal(store.get("Big.md"), BODY);
  });

  test("the proof is spent by the write: the next overwrite needs a new whole read", async () => {
    const { server, store, mtimes } = fixture();
    const read = (await server.call("obsidian_read_note", { path: "Big.md", full: true })).structuredContent;
    const first = await server.call("obsidian_write_note", { path: "Big.md", content: BODY.replace("# Big", "# Big 1"), overwrite: true, if_rev: read.rev, idempotency_key: key() });
    assert.equal(first.isError, undefined, errText(first));
    const second = await server.call("obsidian_write_note", { path: "Big.md", content: BODY.replace("# Big", "# Big 2"), overwrite: true, if_rev: mtimes.get("Big.md"), idempotency_key: key() });
    assert.equal(second.isError, true, "the current rev was never served whole");
    assert.match(errText(second), /^Error \[truncated_read\]/);
    assert.match(store.get("Big.md"), /^---\ntitle: Big\n---\n# Big 1/);
  });

  test("a keyed retry of a proven overwrite that landed is replayed, not refused", async () => {
    const { server, store } = fixture();
    const read = (await server.call("obsidian_read_note", { path: "Big.md", full: true })).structuredContent;
    const args = { path: "Big.md", content: BODY.replace("# Big", "# Big (once)"), overwrite: true, if_rev: read.rev, idempotency_key: "retry-key" };
    const first = await server.call("obsidian_write_note", args);
    assert.equal(first.isError, undefined, errText(first));
    const retry = await server.call("obsidian_write_note", args);
    assert.equal(retry.isError, undefined, "the retry is the kernel's replay: " + errText(retry));
    assert.deepEqual(retry.structuredContent ?? JSON.parse(retry.content[0].text), first.structuredContent ?? JSON.parse(first.content[0].text));
    assert.match(store.get("Big.md"), /# Big \(once\)/);
  });

  test("a replace past the limit lands after a whole read, conditioned on its rev, and not otherwise", async () => {
    const { server, store } = fixture();
    const cut = (await server.call("obsidian_read_note", { path: "Big.md" })).structuredContent;
    const refused = await server.call("obsidian_patch_note", { path: "Big.md", anchor_type: "heading", anchor: "Big", op: "replace", content: "whole rewrite", if_rev: cut.rev, idempotency_key: key() });
    assert.equal(refused.isError, true);
    assert.match(errText(refused), /^Error \[truncated_read\]/);
    const read = (await server.call("obsidian_read_note", { path: "Big.md", full: true })).structuredContent;
    // `whole_section`: the H1's section is the whole note, replaced on purpose (#601).
    const ok = await server.call("obsidian_patch_note", { path: "Big.md", anchor_type: "heading", anchor: "Big", op: "replace", content: "whole rewrite", whole_section: true, if_rev: read.rev, idempotency_key: key() });
    assert.equal(ok.isError, undefined, errText(ok));
    assert.match(store.get("Big.md"), /# Big\n\nwhole rewrite\n$/);
  });

  test("a short note is unaffected: overwritten with its rev as always", async () => {
    const { server, store } = fixture();
    const read = (await server.call("obsidian_read_note", { path: "Small.md" })).structuredContent;
    const res = await server.call("obsidian_write_note", { path: "Small.md", content: "# S", overwrite: true, if_rev: read.rev, idempotency_key: key() });
    assert.equal(res.isError, undefined, errText(res));
    assert.equal(store.get("Small.md"), "# S");
  });
});
