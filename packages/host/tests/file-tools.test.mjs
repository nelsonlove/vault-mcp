/**
 * file-tools.test.mjs — obsidian_write_file, obsidian_edit_file and obsidian_move_file on the live
 * host (#575), and obsidian_trash on a .base and a .canvas file. Built through the REAL server
 * wiring (buildMcpServer, so the guard, the kernel with if_rev and idempotency_key, the journal, the
 * allowlist, the write scope and the connection profile all apply) and called over a real MCP
 * client. The vault is an in-memory fake that behaves like Obsidian where these tools touch it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { installObsidianStub, TFile, TFolder } from "./obsidian-stub.mjs";

installObsidianStub();
const { buildMcpServer } = await import("../src/mcp/server.ts");
const { ObsidianBackend } = await import("../src/mcp/obsidian-backend.ts");
const { parseLinks } = await import("../src/mcp/link-rewrite.ts");
const { Kernel, WriteQueue, WriteJournal, IdempotencyStore, LockStore } = await import("../src/kernel/index.ts");
const { syncKindOf, STATUS_STRICT } = await import("../src/kernel/sync-guard.ts");
const { MCP_SURFACE_INVENTORY } = await import("../src/kernel/operations/inventory-mcp.ts");
const { FILE_TOOL_NAMES, READ_PROFILE_TOOLS, READ_MESSAGE_PROFILE_TOOLS } = await import("@vault-mcp/core");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const BASE = "# A made-up base\nfilters:\n  and:\n    - file.ext == \"md\"\nviews:\n  - type: table\n    name: Table # the main view\n    order: [file.name]\n  - type: cards\n    name: Cards\n";
const CANVAS = JSON.stringify({ nodes: [{ id: "n1", type: "text", text: "One", x: 0, y: 0, width: 100, height: 50 }, { id: "n2", type: "file", file: "Notes/Plan.md", x: 200, y: 0, width: 100, height: 50 }], edges: [{ id: "e1", fromNode: "n1", toNode: "n2" }] }, null, "\t");

/** An in-memory vault: stable TFile objects, folders, mtimes that move on every write, a link index. */
function fakeApp(initial) {
  const text = new Map(Object.entries(initial));
  const files = new Map();
  const folders = new Map();
  let clock = 1000;
  const trashed = [];
  const stamp = (f) => { f.stat = { mtime: clock++, ctime: 1, size: text.get(f.path).length }; };
  const folderOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const addFolders = (p) => { let d = folderOf(p); while (d) { if (!folders.has(d)) folders.set(d, new TFolder(d)); d = folderOf(d); } };
  const mk = (p) => { const f = new TFile(p); stamp(f); files.set(p, f); addFolders(p); return f; };
  for (const p of text.keys()) mk(p);
  const all = () => [...files.values()];
  const resolve = (linkpath, source) => {
    if (!linkpath) return null;
    if (/^\.\.?\//.test(linkpath)) {
      // A relative link resolves from the source's folder only, as in Obsidian.
      const parts = folderOf(source) ? folderOf(source).split("/") : [];
      for (const seg of linkpath.split("/")) { if (seg === "..") parts.pop(); else if (seg !== ".") parts.push(seg); }
      const p = parts.join("/");
      return files.get(p) ?? files.get(`${p}.md`) ?? null;
    }
    const exact = files.get(linkpath) ?? files.get(`${linkpath}.md`);
    if (exact) return exact;
    const name = linkpath.split("/").pop().toLowerCase();
    return all().find((f) => f.name.toLowerCase() === name || (f.extension === "md" && f.basename.toLowerCase() === name)) ?? null;
  };
  const cacheOf = (f) => {
    if (f.extension !== "md") return null;
    const links = [], embeds = [];
    for (const l of parseLinks(text.get(f.path))) (l.embed ? embeds : links).push({ link: l.linkpath + l.subpath, original: l.original, position: { start: { offset: l.start }, end: { offset: l.end } } });
    return { links, embeds };
  };
  const resolvedLinks = {};
  const reindex = () => {
    for (const k of Object.keys(resolvedLinks)) delete resolvedLinks[k];
    for (const f of all()) {
      if (f.extension !== "md") continue;
      resolvedLinks[f.path] = {};
      for (const l of [...cacheOf(f).links, ...cacheOf(f).embeds]) {
        const d = resolve(l.link.split("#")[0], f.path);
        if (d) resolvedLinks[f.path][d.path] = (resolvedLinks[f.path][d.path] ?? 0) + 1;
      }
    }
  };
  reindex();
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
      async rename(f, to) {
        const t = text.get(f.path); text.delete(f.path); files.delete(f.path);
        f.path = to; f.name = to.split("/").pop(); f.basename = f.name.replace(/\.[^.]+$/, "");
        text.set(to, t); files.set(to, f); addFolders(to);
      },
      async trash(f, system) { trashed.push({ path: f.path, system }); text.delete(f.path); files.delete(f.path); },
      async delete(f) { text.delete(f.path); files.delete(f.path); },
    },
    metadataCache: {
      initialized: true,
      resolvedLinks,
      unresolvedLinks: {},
      fileCache: {},
      getFileCache: cacheOf,
      getFirstLinkpathDest: resolve,
      fileToLinktext: (f, _source, omitMd) => (f.extension === "md" && omitMd ? f.basename : f.name),
      on: () => ({}),
    },
    workspace: { layoutReady: true, iterateAllLeaves: (cb) => cb({}), getActiveFile: () => null, on: () => ({}) },
    plugins: { plugins: {}, manifests: {}, enabledPlugins: new Set() },
    internalPlugins: { getPluginById: () => null },
    commands: { commands: {}, executeCommandById: () => true },
    fileManager: { async processFrontMatter() {} },
  };
  const mtime = (p) => files.get(p)?.stat.mtime;
  return { app, text, files, trashed, mtime, reindex };
}

/** The real server over an MCP client, with a real kernel whose rev probe reads the fake vault. */
async function harness(initial = {}, { settings = {}, profile } = {}) {
  const v = fakeApp(initial);
  const jfiles = new Map();
  const adapter = { async exists(p) { return jfiles.has(p); }, async mkdir() {}, async write(p, d) { jfiles.set(p, d); }, async append(p, d) { jfiles.set(p, (jfiles.get(p) ?? "") + d); } };
  const journal = new WriteJournal(adapter, "j", () => new Date("2026-10-18T12:00:00Z"));
  const probe = { uid: () => undefined, rev: (p) => v.mtime(p), record: () => undefined };
  const kernel = new Kernel(new WriteQueue(5000), journal, probe, new IdempotencyStore(), new LockStore());
  const ctx = {
    pluginVersion: "0.0.0", socketPath: "/tmp/none.sock", vaultName: "test", enabledPlugins: () => [],
    getSettings: () => ({ allowlist: [], readOnly: false, trustedReadOnlyPlugins: [], ...settings }),
    kernel,
  };
  const server = buildMcpServer(v.app, ctx, profile ? { profile } : {});
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await client.connect(a);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const records = () => (jfiles.get("j/2026-10.jsonl") ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { ...v, client, call, records, close: () => client.close() };
}

let n = 0;
const key = () => `key-${++n}`;
const errText = (r) => (r.isError ? r.content[0].text : "");
const data = (r) => r.structuredContent;

describe("obsidian_write_file", () => {
  test("creates a .base and a .canvas, and refuses a second create without overwrite", async () => {
    const h = await harness();
    try {
      let r = await h.call("obsidian_write_file", { path: "Boards/Tasks.base", content: BASE });
      assert.equal(r.isError, undefined, errText(r));
      assert.deepEqual(data(r), { path: "Boards/Tasks.base", created: true });
      r = await h.call("obsidian_write_file", { path: "Boards/Plan.canvas", content: CANVAS });
      assert.equal(r.isError, undefined, errText(r));
      assert.equal(h.text.get("Boards/Plan.canvas"), CANVAS);
      r = await h.call("obsidian_write_file", { path: "Boards/Plan.canvas", content: CANVAS });
      assert.equal(r.isError, true);
      assert.match(errText(r), /exists \(set overwrite=true/);
      const ok = h.records().filter((x) => x.op === "obsidian_write_file" && x.outcome === "ok");
      assert.equal(ok.length, 2, "each write is journaled like a note write");
    } finally { await h.close(); }
  });

  test("invalid YAML, a YAML list, invalid JSON and a canvas whose nodes is not an array are refused, and nothing is written", async () => {
    const h = await harness({ "Boards/Old.base": BASE });
    try {
      for (const [p, content] of [
        ["Boards/Bad.base", "views:\n  - name: A\n  name: [unclosed\n"],
        ["Boards/List.base", "- just\n- a list\n"],
        ["Boards/Dup.base", "views: []\nviews: []\n"],
        ["Boards/Bad.canvas", "{ nodes: [] }"],
        ["Boards/Shape.canvas", JSON.stringify({ nodes: {} })],
        ["Boards/NoId.canvas", JSON.stringify({ nodes: [{ type: "text" }] })],
        ["Boards/Dangling.canvas", JSON.stringify({ nodes: [{ id: "a" }], edges: [{ id: "e", fromNode: "a", toNode: "gone" }] })],
        ["Boards/Bomb.base", "a: &a [1,1,1,1,1,1,1,1,1]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: [*b,*b,*b,*b,*b,*b,*b,*b,*b]\n"],
        ["Boards/Merge.base", "views:\n  - <<: {name: Table}\n    type: cards\n"],
      ]) {
        const r = await h.call("obsidian_write_file", { path: p, content });
        assert.equal(r.isError, true, p);
        assert.match(errText(r), /^Error \[invalid_file\]/, p);
        assert.equal(h.text.has(p), false, `${p} was not written`);
      }
      // An overwrite with bad content leaves the old file as it was.
      const rev = data(await h.call("obsidian_read_note", { path: "Boards/Old.base" })).rev;
      const r = await h.call("obsidian_write_file", { path: "Boards/Old.base", content: "a: [", overwrite: true, if_rev: rev });
      assert.match(errText(r), /^Error \[invalid_file\]/);
      assert.equal(h.text.get("Boards/Old.base"), BASE);
    } finally { await h.close(); }
  });

  test("an overwrite needs if_rev; a stale rev is a rev_conflict and the newer text stays", async () => {
    const h = await harness({ "Boards/Plan.canvas": CANVAS });
    try {
      const next = JSON.stringify({ nodes: [], edges: [] });
      let r = await h.call("obsidian_write_file", { path: "Boards/Plan.canvas", content: next, overwrite: true });
      assert.match(errText(r), /^Error \[protection_required\]: 'obsidian_write_file' requires if_rev/);
      assert.match(errText(r), /To CREATE a new file, set overwrite: false/);
      const read = data(await h.call("obsidian_read_note", { path: "Boards/Plan.canvas" }));
      assert.equal(read.content, CANVAS, "obsidian_read_note reads the file as text");
      // Obsidian (the user, the Canvas view) changes the file after the read.
      await h.app.vault.modify(h.files.get("Boards/Plan.canvas"), JSON.stringify({ nodes: [{ id: "x", type: "text", text: "theirs" }] }));
      r = await h.call("obsidian_write_file", { path: "Boards/Plan.canvas", content: next, overwrite: true, if_rev: read.rev });
      assert.match(errText(r), /^Error \[rev_conflict\]/);
      assert.match(h.text.get("Boards/Plan.canvas"), /theirs/);
      const fresh = data(await h.call("obsidian_read_note", { path: "Boards/Plan.canvas" })).rev;
      r = await h.call("obsidian_write_file", { path: "Boards/Plan.canvas", content: next, overwrite: true, if_rev: fresh });
      assert.equal(r.isError, undefined, errText(r));
      assert.equal(h.text.get("Boards/Plan.canvas"), next);
    } finally { await h.close(); }
  });

  test("a create retried with the same idempotency_key is replayed, not refused as 'exists'", async () => {
    const h = await harness();
    try {
      const k = key();
      const r1 = await h.call("obsidian_write_file", { path: "Boards/New.base", content: BASE, idempotency_key: k });
      const r2 = await h.call("obsidian_write_file", { path: "Boards/New.base", content: BASE, idempotency_key: k });
      assert.equal(r1.isError, undefined, errText(r1));
      assert.equal(r2.isError, undefined, errText(r2));
      assert.deepEqual(data(r2), data(r1));
      assert.deepEqual(h.records().filter((x) => x.op === "obsidian_write_file").map((x) => x.outcome), ["ok", "deduped"]);
      const r3 = await h.call("obsidian_write_file", { path: "Boards/New.base", content: BASE + "\n", idempotency_key: k });
      assert.match(errText(r3), /^Error \[idempotency_mismatch\]/);
    } finally { await h.close(); }
  });

  test("path rules: only .base and .canvas, no hidden folder, no Sync-unsafe new name; an unknown argument is refused", async () => {
    const h = await harness();
    try {
      for (const [p, re] of [
        ["Notes/x.md", /^Error \[unsupported_file\]/],
        ["Notes/x.json", /^Error \[unsupported_file\]/],
        [".obsidian/x.base", /^Error \[unsupported_file\]/],
        ["Boards/.hidden/x.canvas", /^Error \[unsupported_file\]/],
        ["Boards/a:b.canvas", /^Error \[unsafe_name\]/],
        ["Boards/a#b.base", /^Error \[unsafe_name\]/],
      ]) {
        const r = await h.call("obsidian_write_file", { path: p, content: p.endsWith(".canvas") ? "{}" : "a: 1\n" });
        assert.match(errText(r), re, p);
        assert.equal(h.text.has(p), false, p);
      }
      const r = await h.call("obsidian_write_file", { path: "Boards/x.base", content: "a: 1\n", frontmatter: { a: 1 } });
      assert.equal(r.isError, true);
      assert.match(JSON.stringify(r.content), /nrecognized key/);
    } finally { await h.close(); }
  });

  test("a cut read handed back as content is refused", async () => {
    const h = await harness();
    try {
      const r = await h.call("obsidian_write_file", { path: "Boards/C.base", content: "a: 1\n[truncated: note is 200000 chars, showing first 100000]\n" });
      assert.match(errText(r), /^Error \[truncated_read\]/);
      assert.equal(h.text.has("Boards/C.base"), false);
    } finally { await h.close(); }
  });
});

describe("obsidian_edit_file", () => {
  test("upsert_view replaces one view by name and keeps the rest of the Base, comments included", async () => {
    const h = await harness({ "Boards/Tasks.base": BASE });
    try {
      const rev = data(await h.call("obsidian_read_note", { path: "Boards/Tasks.base" })).rev;
      const r = await h.call("obsidian_edit_file", { path: "Boards/Tasks.base", op: "upsert_view", item_json: JSON.stringify({ type: "cards", name: "Cards", limit: 10 }), if_rev: rev });
      assert.equal(r.isError, undefined, errText(r));
      assert.equal(data(r).action, "replaced");
      const out = h.text.get("Boards/Tasks.base");
      assert.match(out, /^# A made-up base\n/);
      assert.match(out, /name: Table # the main view/);
      assert.match(out, /limit: 10/);
    } finally { await h.close(); }
  });

  test("an edit needs if_rev; a stale one is a rev_conflict", async () => {
    const h = await harness({ "Boards/Plan.canvas": CANVAS });
    try {
      let r = await h.call("obsidian_edit_file", { path: "Boards/Plan.canvas", op: "remove_edge", key: "e1" });
      assert.match(errText(r), /^Error \[protection_required\]: 'obsidian_edit_file' requires if_rev/);
      const rev = data(await h.call("obsidian_read_note", { path: "Boards/Plan.canvas" })).rev;
      await h.app.vault.modify(h.files.get("Boards/Plan.canvas"), CANVAS.replace("One", "Uno"));
      r = await h.call("obsidian_edit_file", { path: "Boards/Plan.canvas", op: "remove_edge", key: "e1", if_rev: rev });
      assert.match(errText(r), /^Error \[rev_conflict\]/);
      assert.match(h.text.get("Boards/Plan.canvas"), /"e1"/);
    } finally { await h.close(); }
  });

  test("remove_node removes the node and its edges, keeps tab indentation; a result that would not parse is refused", async () => {
    const h = await harness({ "Boards/Plan.canvas": CANVAS });
    try {
      let rev = data(await h.call("obsidian_read_note", { path: "Boards/Plan.canvas" })).rev;
      let r = await h.call("obsidian_edit_file", { path: "Boards/Plan.canvas", op: "remove_node", key: "n2", if_rev: rev });
      assert.equal(r.isError, undefined, errText(r));
      assert.deepEqual(data(r).edges_removed, ["e1"]);
      const after = JSON.parse(h.text.get("Boards/Plan.canvas"));
      assert.deepEqual(after.nodes.map((x) => x.id), ["n1"]);
      assert.deepEqual(after.edges, []);
      assert.match(h.text.get("Boards/Plan.canvas"), /\n\t"nodes"/);
      // An item without an id: the edit is refused and the file is unchanged.
      rev = data(await h.call("obsidian_read_note", { path: "Boards/Plan.canvas" })).rev;
      const before = h.text.get("Boards/Plan.canvas");
      r = await h.call("obsidian_edit_file", { path: "Boards/Plan.canvas", op: "upsert_node", item_json: "{\"type\":\"text\"}", if_rev: rev });
      assert.match(errText(r), /^Error \[invalid_edit\]/);
      r = await h.call("obsidian_edit_file", { path: "Boards/Plan.canvas", op: "upsert_node", item_json: "{not json", if_rev: rev });
      assert.match(errText(r), /^Error \[invalid_file\]/);
      assert.equal(h.text.get("Boards/Plan.canvas"), before);
    } finally { await h.close(); }
  });
});

describe("obsidian_move_file", () => {
  test("a move needs an idempotency_key, rewrites links in notes to the canvas, and a retry is replayed", async () => {
    const h = await harness({ "Boards/Plan.canvas": CANVAS, "Notes/Index.md": "See ![[Plan.canvas]] and [[Boards/Plan.canvas|the board]].\n" });
    try {
      let r = await h.call("obsidian_move_file", { from: "Boards/Plan.canvas", to: "Archive/Plan 2026.canvas" });
      assert.match(errText(r), /^Error \[protection_required\]: 'obsidian_move_file' requires idempotency_key/);
      const k = key();
      r = await h.call("obsidian_move_file", { from: "Boards/Plan.canvas", to: "Archive/Plan 2026.canvas", idempotency_key: k });
      assert.equal(r.isError, undefined, errText(r));
      assert.equal(h.text.get("Archive/Plan 2026.canvas"), CANVAS, "the file's own text is not rewritten");
      assert.equal(h.text.has("Boards/Plan.canvas"), false);
      assert.equal(data(r).backlinks_files_touched, 1);
      assert.equal(data(r).link_check.ok, true, JSON.stringify(data(r).link_check));
      const idx = h.text.get("Notes/Index.md");
      assert.match(idx, /!\[\[Plan 2026\.canvas\]\]/);
      assert.equal(idx, "See ![[Plan 2026.canvas]] and [[Plan 2026.canvas|the board]].\n");
      const again = await h.call("obsidian_move_file", { from: "Boards/Plan.canvas", to: "Archive/Plan 2026.canvas", idempotency_key: k });
      assert.equal(again.isError, undefined, errText(again));
      assert.deepEqual(h.records().filter((x) => x.op === "obsidian_move_file").map((x) => x.outcome), ["ok", "deduped"]);
    } finally { await h.close(); }
  });

  test("the file's own text is never rewritten: a canvas text node's relative link stays as written (ownLinks: false)", async () => {
    const own = JSON.stringify({ nodes: [{ id: "t", type: "text", text: "see [[../Notes/Plan]]" }], edges: [] }, null, "\t");
    const h = await harness({ "Boards/Rel.canvas": own, "Notes/Plan.md": "# Plan\n" });
    try {
      const r = await h.call("obsidian_move_file", { from: "Boards/Rel.canvas", to: "Archive/Deep/Rel.canvas", idempotency_key: key() });
      assert.equal(r.isError, undefined, errText(r));
      assert.equal(h.text.get("Archive/Deep/Rel.canvas"), own);
    } finally { await h.close(); }
  });

  test("a move may not change the type, and refuses an existing destination without overwrite", async () => {
    const h = await harness({ "Boards/A.base": BASE, "Boards/B.base": BASE });
    try {
      let r = await h.call("obsidian_move_file", { from: "Boards/A.base", to: "Boards/A.canvas", idempotency_key: key() });
      assert.match(errText(r), /does not keep the extension/);
      r = await h.call("obsidian_move_file", { from: "Boards/A.base", to: "Boards/B.base", idempotency_key: key() });
      assert.match(errText(r), /destination exists/);
      r = await h.call("obsidian_move_file", { from: "Boards/A.base", to: "Boards/B.base", overwrite: true, idempotency_key: key() });
      assert.equal(r.isError, undefined, errText(r));
      assert.deepEqual(h.trashed, [{ path: "Boards/B.base", system: true }], "the replaced file went to the system trash");
    } finally { await h.close(); }
  });
});

describe("obsidian_move_file on attachment files (the operator's fileMoveExtensions list)", () => {
  const PDF = "%PDF-1.7 made-up bytes\n";
  const ZIP = "PK\u0003\u0004 made-up bytes";
  test("a PDF and a zip move between folders, keep their bytes, and links and embeds in notes are rewritten", async () => {
    const index = "Scan: ![[Scan.pdf]], page: ![[Inbox/Scan.pdf#page=2]], bundle: [[Inbox/Bundle.zip|the bundle]], md embed: ![scan](Inbox/Scan.pdf).\n";
    const h = await harness({ "Inbox/Scan.pdf": PDF, "Inbox/Bundle.zip": ZIP, "Notes/Index.md": index });
    try {
      const k = key();
      let r = await h.call("obsidian_move_file", { from: "Inbox/Scan.pdf", to: "Files/2026/Scan 2026.pdf", idempotency_key: k });
      assert.equal(r.isError, undefined, errText(r));
      assert.equal(h.text.get("Files/2026/Scan 2026.pdf"), PDF, "the file's bytes are not read or changed");
      assert.equal(h.text.has("Inbox/Scan.pdf"), false);
      assert.equal(data(r).link_check.ok, true, JSON.stringify(data(r).link_check));
      assert.equal(data(r).backlinks_updated, 3);
      r = await h.call("obsidian_move_file", { from: "Inbox/Bundle.zip", to: "Files/Bundle 2026.zip", idempotency_key: key() });
      assert.equal(r.isError, undefined, errText(r));
      assert.equal(h.text.get("Files/Bundle 2026.zip"), ZIP);
      const idx = h.text.get("Notes/Index.md");
      assert.match(idx, /!\[\[Scan 2026\.pdf\]\]/, idx);
      assert.match(idx, /!\[\[Scan 2026\.pdf#page=2\]\]/, idx);
      assert.match(idx, /\[\[Bundle 2026\.zip\|the bundle\]\]/, idx);
      assert.match(idx, /!\[scan\]\(Files\/2026\/Scan%202026\.pdf\)/, idx);
      assert.equal(idx.includes("Inbox/"), false, idx);
      const again = await h.call("obsidian_move_file", { from: "Inbox/Scan.pdf", to: "Files/2026/Scan 2026.pdf", idempotency_key: k });
      assert.equal(again.isError, undefined, errText(again));
      assert.deepEqual(h.records().filter((x) => x.op === "obsidian_move_file").map((x) => x.outcome), ["ok", "ok", "deduped"], "journaled, and a retry is replayed");
    } finally { await h.close(); }
  });

  test("a type off the list is refused (unsupported_file), and an empty list moves only .base and .canvas", async () => {
    const h = await harness({ "Inbox/run.exe": "x", "Inbox/Data.json": "{}" });
    try {
      for (const from of ["Inbox/run.exe", "Inbox/Data.json"]) {
        const r = await h.call("obsidian_move_file", { from, to: from.replace("Inbox/", "Files/"), idempotency_key: key() });
        assert.match(errText(r), /^Error \[unsupported_file\]: .*does not move here/, from);
      }
      assert.equal(h.text.has("Inbox/run.exe"), true);
    } finally { await h.close(); }
    const narrow = await harness({ "Inbox/Scan.pdf": PDF, "Boards/Plan.canvas": CANVAS }, { settings: { fileMoveExtensions: [] } });
    try {
      let r = await narrow.call("obsidian_move_file", { from: "Inbox/Scan.pdf", to: "Files/Scan.pdf", idempotency_key: key() });
      assert.match(errText(r), /^Error \[unsupported_file\]/);
      assert.equal(narrow.text.get("Inbox/Scan.pdf"), PDF);
      r = await narrow.call("obsidian_move_file", { from: "Boards/Plan.canvas", to: "Archive/Plan.canvas", idempotency_key: key() });
      assert.equal(r.isError, undefined, errText(r));
    } finally { await narrow.close(); }
    const custom = await harness({ "Inbox/Photo.heic": "x" }, { settings: { fileMoveExtensions: ["HEIC"] } });
    try {
      const r = await custom.call("obsidian_move_file", { from: "Inbox/Photo.heic", to: "Files/Photo.heic", idempotency_key: key() });
      assert.equal(r.isError, undefined, errText(r));
    } finally { await custom.close(); }
  });

  test("a rename may not change the extension, a note is refused (it moves with obsidian_move_note), and new names and hidden folders are checked", async () => {
    const h = await harness({ "Inbox/Scan.pdf": PDF, "Notes/Plan.md": "# Plan\n" });
    try {
      for (const to of ["Inbox/Scan.zip", "Inbox/Scan.PDF", "Inbox/Scan"]) {
        const r = await h.call("obsidian_move_file", { from: "Inbox/Scan.pdf", to, idempotency_key: key() });
        assert.match(errText(r), /^Error \[unsupported_file\]/, to);
      }
      let r = await h.call("obsidian_move_file", { from: "Notes/Plan.md", to: "Archive/Plan.md", idempotency_key: key() });
      assert.match(errText(r), /^Error \[unsupported_file\]: .*obsidian_move_note/);
      assert.equal(h.text.has("Notes/Plan.md"), true);
      r = await h.call("obsidian_move_file", { from: "Inbox/Scan.pdf", to: "Files/a:b.pdf", idempotency_key: key() });
      assert.match(errText(r), /^Error \[unsafe_name\]/);
      r = await h.call("obsidian_move_file", { from: "Inbox/Scan.pdf", to: ".hidden/Scan.pdf", idempotency_key: key() });
      assert.match(errText(r), /^Error \[unsupported_file\]/);
      r = await h.call("obsidian_move_file", { from: "Inbox/Scan.pdf", to: "../Scan.pdf", idempotency_key: key() });
      assert.equal(r.isError, true);
      assert.equal(h.text.get("Inbox/Scan.pdf"), PDF, "nothing moved");
    } finally { await h.close(); }
  });

  test("the path allowlist checks both ends of the move", async () => {
    const h = await harness({ "Inbox/Scan.pdf": PDF, "Other/Old.pdf": PDF }, { settings: { allowlist: ["Inbox", "Files"] } });
    try {
      let r = await h.call("obsidian_move_file", { from: "Other/Old.pdf", to: "Files/Old.pdf", idempotency_key: key() });
      assert.match(errText(r), /^Error \[out_of_allowlist\]/, "the source outside");
      r = await h.call("obsidian_move_file", { from: "Inbox/Scan.pdf", to: "Other/Scan.pdf", idempotency_key: key() });
      assert.match(errText(r), /^Error \[out_of_allowlist\]/, "the destination outside");
      assert.equal(h.text.get("Inbox/Scan.pdf"), PDF);
      assert.equal(h.text.get("Other/Old.pdf"), PDF);
      r = await h.call("obsidian_move_file", { from: "Inbox/Scan.pdf", to: "Files/Scan.pdf", idempotency_key: key() });
      assert.equal(r.isError, undefined, errText(r));
    } finally { await h.close(); }
    const scoped = await harness({ "Inbox/Scan.pdf": PDF }, { settings: { writeScope: { mode: "create-only", paths: ["**"] } } });
    try {
      const r = await scoped.call("obsidian_move_file", { from: "Inbox/Scan.pdf", to: "Files/Scan.pdf", idempotency_key: key() });
      assert.match(errText(r), /^Error \[write_scope\]/);
    } finally { await scoped.close(); }
  });

  test("only the move widens: obsidian_write_file and obsidian_edit_file still refuse a PDF; obsidian_trash takes one", async () => {
    const h = await harness({ "Inbox/Scan.pdf": PDF });
    try {
      let r = await h.call("obsidian_write_file", { path: "Inbox/New.pdf", content: PDF });
      assert.match(errText(r), /^Error \[unsupported_file\]/);
      assert.equal(h.text.has("Inbox/New.pdf"), false);
      r = await h.call("obsidian_write_file", { path: "Inbox/Scan.pdf", content: "x", overwrite: true, if_rev: h.mtime("Inbox/Scan.pdf") });
      assert.match(errText(r), /^Error \[unsupported_file\]/);
      r = await h.call("obsidian_edit_file", { path: "Inbox/Scan.pdf", op: "remove_node", key: "a", if_rev: h.mtime("Inbox/Scan.pdf") });
      assert.match(errText(r), /^Error \[unsupported_file\]/);
      assert.equal(h.text.get("Inbox/Scan.pdf"), PDF);
      const rev = data(await h.call("obsidian_read_note", { path: "Inbox/Scan.pdf" })).rev;
      assert.equal(rev, h.mtime("Inbox/Scan.pdf"), "the binary read gives the rev trash needs");
      r = await h.call("obsidian_trash", { path: "Inbox/Scan.pdf", if_rev: rev, idempotency_key: key() });
      assert.equal(r.isError, undefined, errText(r));
      assert.deepEqual(h.trashed, [{ path: "Inbox/Scan.pdf", system: true }]);
    } finally { await h.close(); }
  });
});

describe("attachments: no overwrite, a narrow link scan, a binary read (#594 review 1)", () => {
  const PDF = "%PDF-1.7 made-up bytes\n";
  test("a move never replaces an attachment: overwrite: true is refused, nothing is trashed, both files stay", async () => {
    const h = await harness({ "Inbox/Scan.pdf": "new", "Files/Scan.pdf": "original" });
    try {
      const r = await h.call("obsidian_move_file", { from: "Inbox/Scan.pdf", to: "Files/Scan.pdf", overwrite: true, idempotency_key: key() });
      assert.match(errText(r), /^Error \[overwrite_refused\]/);
      assert.equal(h.text.get("Files/Scan.pdf"), "original");
      assert.equal(h.text.get("Inbox/Scan.pdf"), "new");
      assert.deepEqual(h.trashed, []);
    } finally { await h.close(); }
  });

  test("the link scan matches an attachment by its full name: a note that only says 'scan' is not a candidate", async () => {
    const h = await harness({
      "Inbox/scan.pdf": PDF,
      "Notes/Prose.md": "I will scan the receipts. Scan again later.\n",
      "Notes/Other.md": "See [[scan]] for the scan note.\n",
      "Notes/Embeds.md": "![[scan.pdf]] and ![s](Inbox/scan.pdf)\n",
    });
    try {
      const r = await h.call("obsidian_move_file", { from: "Inbox/scan.pdf", to: "Files/scan 2.pdf", idempotency_key: key() });
      assert.equal(r.isError, undefined, errText(r));
      assert.equal(data(r).link_check.candidates, 1, JSON.stringify(data(r).link_check));
      assert.equal(data(r).link_check.ok, true);
      assert.equal(h.text.get("Notes/Embeds.md"), "![[scan 2.pdf]] and ![s](Files/scan%202.pdf)\n");
      assert.equal(h.text.get("Notes/Prose.md"), "I will scan the receipts. Scan again later.\n");
    } finally { await h.close(); }
  });

  test("obsidian_read_note on a binary file returns {path, rev, size, binary: true} and no content, with or without full", async () => {
    const h = await harness({ "Inbox/Scan.pdf": PDF, "Inbox/blob.dat": "ab\u0000cd", "Inbox/readme.txt": "hello", "Notes/Plan.md": "# Plan\n" });
    try {
      for (const full of [undefined, true]) {
        const r = await h.call("obsidian_read_note", { path: "Inbox/Scan.pdf", ...(full ? { full } : {}) });
        assert.equal(r.isError, undefined, errText(r));
        assert.deepEqual(data(r), { path: "Inbox/Scan.pdf", rev: h.mtime("Inbox/Scan.pdf"), size: PDF.length, binary: true });
        assert.equal(JSON.stringify(r.content).includes("made-up bytes"), false, "no content in the text block either");
      }
      assert.deepEqual(data(await h.call("obsidian_read_note", { path: "Inbox/blob.dat" })), { path: "Inbox/blob.dat", rev: h.mtime("Inbox/blob.dat"), size: 5, binary: true });
      assert.equal(data(await h.call("obsidian_read_note", { path: "Inbox/readme.txt" })).content, "hello");
      assert.equal(data(await h.call("obsidian_read_note", { path: "Notes/Plan.md" })).content, "# Plan\n");
    } finally { await h.close(); }
  });

  test("obsidian_doctor reports the list obsidian_move_file uses now", async () => {
    const h = await harness({}, { settings: { fileMoveExtensions: ["pdf", "zip"] } });
    try {
      assert.deepEqual(data(await h.call("obsidian_doctor", {})).file_move_extensions, ["pdf", "zip"]);
    } finally { await h.close(); }
  });
});

describe("obsidian_trash on a .base and a .canvas", () => {
  test("trash takes either file with if_rev and idempotency_key", async () => {
    const h = await harness({ "Boards/Tasks.base": BASE, "Boards/Plan.canvas": CANVAS });
    try {
      for (const p of ["Boards/Tasks.base", "Boards/Plan.canvas"]) {
        const rev = data(await h.call("obsidian_read_note", { path: p })).rev;
        let r = await h.call("obsidian_trash", { path: p, idempotency_key: key() });
        assert.match(errText(r), /^Error \[protection_required\]/, p);
        r = await h.call("obsidian_trash", { path: p, if_rev: rev, idempotency_key: key() });
        assert.equal(r.isError, undefined, errText(r));
        assert.deepEqual(data(r), { path: p, trashed: true });
        assert.equal(h.text.has(p), false, p);
      }
      assert.deepEqual(h.trashed.map((t) => t.path), ["Boards/Tasks.base", "Boards/Plan.canvas"]);
    } finally { await h.close(); }
  });
});

describe("the guards notes have", () => {
  test("the path allowlist refuses a file outside it, for each tool; read-only mode refuses all three", async () => {
    const h = await harness({ "Other/Plan.canvas": CANVAS }, { settings: { allowlist: ["Boards"] } });
    try {
      for (const [name, args] of [
        ["obsidian_write_file", { path: "Other/New.base", content: BASE }],
        ["obsidian_edit_file", { path: "Other/Plan.canvas", op: "remove_edge", key: "e1", if_rev: 1 }],
        ["obsidian_move_file", { from: "Other/Plan.canvas", to: "Boards/Plan.canvas", idempotency_key: key() }],
      ]) {
        const r = await h.call(name, args);
        assert.match(errText(r), /^Error \[out_of_allowlist\]/, name);
      }
      assert.equal(h.text.has("Other/New.base"), false);
      assert.equal(h.text.get("Other/Plan.canvas"), CANVAS);
    } finally { await h.close(); }
    const ro = await harness({}, { settings: { readOnly: true } });
    try {
      const r = await ro.call("obsidian_write_file", { path: "Boards/New.base", content: BASE });
      assert.match(errText(r), /^Error \[read_only\]/);
      assert.equal(ro.text.has("Boards/New.base"), false);
    } finally { await ro.close(); }
  });

  test("under a path allowlist a .base is not written, edited or moved (base_under_scope); a .canvas still is", async () => {
    const h = await harness({ "Boards/Tasks.base": BASE, "Boards/Plan.canvas": CANVAS }, { settings: { allowlist: ["Boards"] } });
    try {
      const rev = data(await h.call("obsidian_read_note", { path: "Boards/Tasks.base" })).rev;
      for (const [name, args] of [
        ["obsidian_write_file", { path: "Boards/Reach.base", content: "filters:\n  and:\n    - file.inFolder(\"Elsewhere\")\nviews:\n  - type: table\n    name: T\n" }],
        ["obsidian_write_file", { path: "Boards/Tasks.base", content: BASE, overwrite: true, if_rev: rev }],
        ["obsidian_edit_file", { path: "Boards/Tasks.base", op: "remove_view", key: "Cards", if_rev: rev }],
        ["obsidian_move_file", { from: "Boards/Tasks.base", to: "Boards/Moved.base", idempotency_key: key() }],
      ]) {
        const r = await h.call(name, args);
        assert.match(errText(r), /^Error \[base_under_scope\]: .*the path allowlist/, name);
      }
      assert.equal(h.text.has("Boards/Reach.base"), false);
      assert.equal(h.text.get("Boards/Tasks.base"), BASE);
      const c = await h.call("obsidian_write_file", { path: "Boards/New.canvas", content: CANVAS });
      assert.equal(c.isError, undefined, errText(c));
    } finally { await h.close(); }
    const open = await harness({ "Boards/Tasks.base": BASE });
    try {
      const r = await open.call("obsidian_write_file", { path: "Boards/Reach.base", content: BASE });
      assert.equal(r.isError, undefined, "with no allowlist a .base is written");
    } finally { await open.close(); }
  });

  test("a create-only write scope refuses all three (they are not note creates)", async () => {
    const h = await harness({ "Boards/Plan.canvas": CANVAS }, { settings: { writeScope: { mode: "create-only", paths: ["**"] } } });
    try {
      const r = await h.call("obsidian_write_file", { path: "Boards/New.base", content: BASE });
      assert.match(errText(r), /^Error \[write_scope\]/);
      assert.equal(h.text.has("Boards/New.base"), false);
    } finally { await h.close(); }
  });

  test("no profile but full offers them: read, read+inbox and read+message do not list them, and a call is not found", async () => {
    for (const name of FILE_TOOL_NAMES) {
      assert.equal(READ_PROFILE_TOOLS.includes(name), false, name);
      assert.equal(READ_MESSAGE_PROFILE_TOOLS.includes(name), false, name);
    }
    const full = await harness();
    try {
      const listed = (await full.client.listTools()).tools.map((t) => t.name);
      for (const name of FILE_TOOL_NAMES) assert.ok(listed.includes(name), name);
    } finally { await full.close(); }
    for (const profile of ["read", "read+inbox", "read+message"]) {
      const h = await harness({}, { profile });
      try {
        const listed = (await h.client.listTools()).tools.map((t) => t.name);
        for (const name of FILE_TOOL_NAMES) assert.equal(listed.includes(name), false, `${profile}: ${name}`);
        const r = await h.call("obsidian_write_file", { path: "Boards/New.base", content: BASE });
        assert.equal(r.isError, true, profile);
        assert.match(JSON.stringify(r.content), /not found/i, profile);
        assert.equal(h.text.has("Boards/New.base"), false, profile);
      } finally { await h.close(); }
    }
  });

  test("the Sync guard: a create or a move is a structure write, an overwrite or an edit is content; a move waits for Fully synced", () => {
    assert.equal(syncKindOf("obsidian_write_file", {}), "structure");
    assert.equal(syncKindOf("obsidian_write_file", { overwrite: false }), "structure");
    assert.equal(syncKindOf("obsidian_write_file", { overwrite: true }), "content");
    assert.equal(syncKindOf("obsidian_edit_file", { op: "upsert_view" }), "content");
    assert.equal(syncKindOf("obsidian_move_file", {}), "structure");
    assert.equal(syncKindOf("obsidian_trash", {}), "structure");
    assert.ok(STATUS_STRICT.has("obsidian_move_file"));
    assert.ok(STATUS_STRICT.has("obsidian_trash"));
    const rows = new Map(MCP_SURFACE_INVENTORY.map((r) => [r.tool, r]));
    for (const name of FILE_TOOL_NAMES) assert.equal(rows.get(name)?.readOnly, false, name);
  });

  test("guarded territories: as for a note, the host does not refuse the write, and a file write never reaches the governance provider's write hook", async () => {
    // A guarded territory is enforced by the observation capture (reads) and by the governance
    // provider, which reviews the NOTE writes the backend reports. A .base or .canvas write is
    // never reported, so the provider never retains or reviews one, inside a territory or not.
    const v = fakeApp({});
    const reported = [];
    const backend = new ObsidianBackend(v.app, (p) => p, (facts) => reported.push(facts.path));
    await backend.writeFile("Guarded area/Board.canvas", CANVAS, false);
    await backend.writeFile("Open area/Tasks.base", BASE, false);
    await backend.editFile("Guarded area/Board.canvas", { op: "remove_edge", key: "e1" });
    await backend.writeNote("Open area/Note.md", "# a note\n", false);
    assert.equal(v.text.get("Guarded area/Board.canvas").includes("e1"), false);
    assert.deepEqual(reported, ["Open area/Note.md"], "only the note write is reported");
  });
});
