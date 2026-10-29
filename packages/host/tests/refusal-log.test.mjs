/**
 * The refusal log (#618): with the `refusalLog` setting on, every refused write call is one journal
 * line with `outcome: "refused"`, its `code` and `codeFamily`, and no argument value. Off, the journal
 * is what it was before. Built through the REAL server wiring (buildMcpServer, the guard, the kernel)
 * over an MCP client, plus the guard alone for the stages a fake vault cannot reach (the Sync guard).
 * The notes, paths and markers are made up.
 */
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { installObsidianStub } from "./obsidian-stub.mjs";

installObsidianStub();
const { TFile, TFolder } = await import("obsidian");
const { buildMcpServer } = await import("../src/mcp/server.ts");
const { makeGuarded } = await import("../src/mcp/guarded.ts");
const { Kernel, WriteQueue, WriteJournal, IdempotencyStore, LockStore } = await import("../src/kernel/index.ts");
const { checkOverride, overridePaths } = await import("../src/local-settings.ts");
const VaultMcpPlugin = (await import("../src/main.ts")).default;
const { setDeclaredProtectedProperties, DEFAULT_PROTECTED_PROPERTIES, truncationTrailer, CHARACTER_LIMIT, refusalFamily, refusalCodeOf, refusalCodeOfThrown } = await import("@vault-mcp/core");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const silent = () => {};
beforeEach(() => setDeclaredProtectedProperties(DEFAULT_PROTECTED_PROPERTIES, silent));
after(() => setDeclaredProtectedProperties(DEFAULT_PROTECTED_PROPERTIES, silent));

// A distinct string put in every argument that can hold content; it must never reach the journal.
const MARK = "ZQX-REFUSAL-MARKER-41";
// A token-shaped value in an argument: it must never reach the journal either.
const TOKEN = "tok_live_9f8e7d6c5b4a3f2e1d0c";

/** An in-memory vault: stable TFile objects, folders, mtimes that move on every write. */
function fakeApp(initial, { leaves = true } = {}) {
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
      async append(f, c) { write(f, text.get(f.path) + c); },
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
    // `leaves: false` is a host with no workspace leaf: the headless gate refuses the app-only tools.
    workspace: { layoutReady: true, iterateAllLeaves: (cb) => { if (leaves) cb({}); }, getActiveFile: () => null, on: () => ({}) },
    plugins: { plugins: {}, manifests: {}, enabledPlugins: new Set() },
    internalPlugins: { getPluginById: () => null },
    commands: { commands: {}, executeCommandById: () => true },
    fileManager: { async processFrontMatter() {} },
  };
  const mtime = (p) => files.get(p)?.stat.mtime;
  return { app, text, mtime };
}

/** The real server over an MCP client, with a real kernel whose journal is held in memory. */
async function harness(initial = {}, { on = true, settings = {}, records = [], opts = {}, leaves = true } = {}) {
  const v = fakeApp(initial, { leaves });
  const jfiles = new Map();
  const adapter = { async exists(p) { return jfiles.has(p); }, async mkdir() {}, async write(p, d) { jfiles.set(p, d); }, async append(p, d) { jfiles.set(p, (jfiles.get(p) ?? "") + d); } };
  const journal = new WriteJournal(adapter, "j", () => new Date("2026-10-21T12:00:00Z"));
  const probe = { uid: () => undefined, rev: (p) => v.mtime(p), record: (p) => (records.includes(p) ? true : undefined) };
  const kernel = new Kernel(new WriteQueue(5000), journal, probe, new IdempotencyStore(), new LockStore());
  kernel.refusalLog = () => on;
  const ctx = {
    pluginVersion: "0.0.0", socketPath: "/nonexistent.sock", vaultName: "test", enabledPlugins: () => [],
    getSettings: () => ({ allowlist: [], readOnly: false, trustedReadOnlyPlugins: [], ...settings }),
    kernel,
  };
  const server = buildMcpServer(v.app, ctx, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await client.connect(a);
  const call = (name, args) => client.callTool({ name, arguments: args }).catch((e) => ({ thrown: String(e) }));
  // The journal appends are fire-and-forget; one macrotask lets the chain land.
  const raw = async () => { await new Promise((r) => setTimeout(r, 5)); return jfiles.get("j/2026-10.jsonl") ?? ""; };
  const lines = async () => (await raw()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { ...v, kernel, client, call, raw, lines, close: () => client.close() };
}

const errText = (r) => (r.isError ? r.content[0].text : r.thrown ?? "");
let keyN = 0;
const key = () => `k-${++keyN}`;

const NOTE = "---\ntitle: Plan\nstatus: draft\n---\n# Plan\n\nThe colour is blue.\n";
const LONG = "---\ntitle: Long\n---\n" + "x".repeat(CHARACTER_LIMIT + 10) + "\n";
const VAULT = { "Notes/Plan.md": NOTE, "Notes/Rec.md": NOTE, "Notes/Long.md": LONG, "Other/O.md": NOTE };

/** The keys a refused line may carry: what the journal keeps for a write, minus every argument value. */
const REFUSED_KEYS = new Set(["ts", "op", "target", "actor", "outcome", "code", "codeFamily", "durationMs", "queueWaitMs", "addressedAs"]);

function assertRefusedShape(line) {
  assert.equal(line.outcome, "refused");
  assert.equal(typeof line.code, "string");
  assert.equal(line.codeFamily, refusalFamily(line.code));
  for (const k of Object.keys(line)) assert.ok(REFUSED_KEYS.has(k), `a refused line carries '${k}'`);
  assert.equal(line.actor.transport, "mcp");
}

/**
 * One refused call per stage the host has, each with the marker in every content-bearing argument.
 * `expect` is the code; `stage` says where it refuses: `pre` (before the queue, unjournaled when
 * off) or `dequeue` (journaled `error`/`conflict` when off).
 */
const STAGES = [
  { name: "schema (strict write arguments)", tool: "obsidian_append_note", args: () => ({ path: "Notes/Plan.md", content: MARK, idempotency_key: key(), bogus: MARK }), expect: "input_validation", stage: "pre" },
  { name: "allowlist", settings: { allowlist: ["Notes/"] }, tool: "obsidian_append_note", args: () => ({ path: "Other/O.md", content: MARK, idempotency_key: key(), intent: MARK }), expect: "out_of_allowlist", stage: "pre" },
  { name: "read-only mode", settings: { readOnly: true }, tool: "obsidian_append_note", args: () => ({ path: "Notes/Plan.md", content: MARK, idempotency_key: key(), intent: MARK }), expect: "read_only", stage: "pre" },
  { name: "write scope", settings: { writeScope: { mode: "create-only", paths: ["Inbox/*.md"] } }, tool: "obsidian_append_note", args: () => ({ path: "Notes/Plan.md", content: MARK, idempotency_key: key(), intent: MARK }), expect: "write_scope", stage: "pre" },
  { name: "profile (its call-time write scope)", opts: { profile: "read+inbox" }, tool: "obsidian_write_note", args: () => ({ path: "Notes/New.md", content: MARK }), expect: "write_scope", stage: "pre" },
  { name: "required protection", tool: "obsidian_append_note", args: () => ({ path: "Notes/Plan.md", content: MARK, intent: MARK }), expect: "protection_required", stage: "pre" },
  { name: "uid addressing", tool: "obsidian_append_note", args: () => ({ path: "uid:nope", content: MARK, idempotency_key: key(), intent: MARK }), expect: "uid_unresolved", stage: "pre" },
  { name: "read-limit proof (a cut read handed back)", tool: "obsidian_append_note", args: () => ({ path: "Notes/Plan.md", content: `${MARK}\n${truncationTrailer(CHARACTER_LIMIT + 5, CHARACTER_LIMIT)}\n`, idempotency_key: key(), intent: MARK }), expect: "truncated_read", stage: "pre" },
  { name: "headless gate", leaves: false, tool: "obsidian_toggle_view_mode", args: () => ({ mode: "source" }), expect: "headless_unsupported", stage: "pre" },
  { name: "record guard", records: ["Notes/Rec.md"], tool: "obsidian_replace_text", args: (h) => ({ path: "Notes/Rec.md", old: "colour", new: MARK, if_rev: h.mtime("Notes/Rec.md"), idempotency_key: key(), intent: MARK }), expect: "record_immutable", stage: "dequeue" },
  { name: "if_rev conflict", tool: "obsidian_replace_text", args: () => ({ path: "Notes/Plan.md", old: "colour", new: MARK, if_rev: 1, idempotency_key: key(), intent: MARK }), expect: "rev_conflict", stage: "dequeue" },
  { name: "a tool's own refusal (no_match)", tool: "obsidian_replace_text", args: (h) => ({ path: "Notes/Plan.md", old: MARK, new: TOKEN, if_rev: h.mtime("Notes/Plan.md"), idempotency_key: key(), intent: MARK }), expect: "no_match", stage: "dequeue" },
  { name: "the accept guard (a protected property)", tool: "obsidian_manage_frontmatter", args: (h) => ({ path: "Notes/Plan.md", key: "verified", op: "set", value: MARK, if_rev: h.mtime("Notes/Plan.md"), intent: MARK }), expect: "accept_forbidden", stage: "any" },
  { name: "read-limit proof at dequeue (a whole overwrite of a long note)", tool: "obsidian_write_note", args: (h) => ({ path: "Notes/Long.md", content: MARK, overwrite: true, if_rev: h.mtime("Notes/Long.md"), intent: MARK }), expect: "truncated_read", stage: "dequeue" },
];

describe("refusalLog on: one refused line per refused call, at every stage", () => {
  for (const s of STAGES) {
    test(s.name, async () => {
      const h = await harness(VAULT, { on: true, settings: s.settings, records: s.records, opts: s.opts, leaves: s.leaves });
      const r = await h.call(s.tool, s.args(h));
      const text = errText(r);
      if (s.expect === "input_validation") assert.match(text, /Input validation error|Unrecognized key/i, text);
      else assert.match(text, new RegExp(`Error \\[${s.expect}\\]`), text);
      const refused = (await h.lines()).filter((l) => l.outcome === "refused");
      assert.equal(refused.length, 1, JSON.stringify(await h.lines()));
      assertRefusedShape(refused[0]);
      assert.equal(refused[0].code, s.expect);
      assert.equal(refused[0].op, s.tool);
      // Nothing else was journaled for the call: the refused line replaces, never adds.
      assert.equal((await h.lines()).length, 1);
      const raw = await h.raw();
      assert.ok(!raw.includes(MARK), `the content marker reached the journal: ${raw}`);
      assert.ok(!raw.includes(TOKEN), `a token reached the journal: ${raw}`);
      await h.close();
    });
  }

  test("an idempotency mismatch is one refused line, with no argument value", async () => {
    const h = await harness(VAULT);
    const k = key();
    const first = await h.call("obsidian_append_note", { path: "Notes/Plan.md", content: "one", idempotency_key: k });
    assert.equal(first.isError, undefined, errText(first));
    const r = await h.call("obsidian_append_note", { path: "Notes/Plan.md", content: MARK, idempotency_key: k, intent: MARK });
    assert.match(errText(r), /Error \[idempotency_mismatch\]/);
    const lines = await h.lines();
    assert.deepEqual(lines.map((l) => l.outcome), ["ok", "refused"]);
    assertRefusedShape(lines[1]);
    assert.equal(lines[1].code, "idempotency_mismatch");
    assert.equal(lines[1].codeFamily, "idempotency");
    assert.ok(!(await h.raw()).includes(MARK));
    await h.close();
  });

  test("the target is the path the call named, as the journal records it; a uid address keeps its resolved form", async () => {
    const h = await harness(VAULT, { settings: { allowlist: ["Notes/"] } });
    await h.call("obsidian_append_note", { path: "Other/O.md", content: "x", idempotency_key: key() });
    const [line] = await h.lines();
    assert.deepEqual(line.target, { path: "Other/O.md" });
    await h.close();
  });

  test("an obsidian_write_notes item refused before its guarded write (allowlist, accept guard) is one line each", async () => {
    const h = await harness(VAULT, { settings: { allowlist: ["Notes/"] } });
    const r = await h.call("obsidian_write_notes", {
      notes: [
        { path: "Other/New.md", body: MARK },
        { path: "Notes/New.md", frontmatter: { verified: [{ by: "human:x", at: "2026-10-01T00:00:00-04:00" }], note: MARK }, body: MARK },
      ],
      intent: MARK,
    });
    assert.ok(r.isError, errText(r));
    const refused = (await h.lines()).filter((l) => l.outcome === "refused");
    assert.deepEqual(refused.map((l) => l.code).sort(), ["accept_forbidden", "out_of_allowlist"]);
    for (const l of refused) { assertRefusedShape(l); assert.equal(l.op, "obsidian_write_notes"); }
    assert.ok(!(await h.raw()).includes(MARK));
    await h.close();
  });

  test("Code Mode: a target call that fails its schema is one refused line", async () => {
    const h = await harness(VAULT, { opts: { codeMode: true } });
    const r = await h.call("obsidian_call_tool", { name: "obsidian_append_note", args: { path: "Notes/Plan.md", content: MARK, bogus: 1, idempotency_key: key() } });
    assert.ok(r.isError, JSON.stringify(r));
    const refused = (await h.lines()).filter((l) => l.outcome === "refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].code, "input_validation");
    assert.equal(refused[0].op, "obsidian_append_note");
    assert.ok(!(await h.raw()).includes(MARK));
    await h.close();
  });

  test("an allowed call writes no refused line", async () => {
    const h = await harness(VAULT);
    const r = await h.call("obsidian_replace_text", { path: "Notes/Plan.md", old: "colour", new: "color", if_rev: h.mtime("Notes/Plan.md"), idempotency_key: key() });
    assert.equal(r.isError, undefined, errText(r));
    const lines = await h.lines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].outcome, "ok");
    assert.equal(lines[0].code, undefined);
    await h.close();
  });

  test("a read call is never journaled, refused or not", async () => {
    const h = await harness(VAULT, { settings: { allowlist: ["Notes/"] } });
    const r = await h.call("obsidian_read_note", { path: "Other/O.md" });
    assert.match(errText(r), /out_of_allowlist/);
    assert.equal((await h.raw()), "");
    await h.close();
  });

  test("a retry with the same idempotency key does not count the refusal twice", async () => {
    const h = await harness(VAULT);
    const args = { path: "Notes/Plan.md", old: "purple", new: "red", if_rev: h.mtime("Notes/Plan.md"), idempotency_key: key() };
    const one = await h.call("obsidian_replace_text", args);
    const two = await h.call("obsidian_replace_text", args);
    assert.match(errText(one), /Error \[no_match\]/);
    assert.match(errText(two), /Error \[no_match\]/);
    const lines = await h.lines();
    assert.deepEqual(lines.map((l) => l.outcome), ["refused", "deduped"]);
    await h.close();
  });

  test("the setting is read per call", async () => {
    let on = false;
    const h = await harness(VAULT);
    h.kernel.refusalLog = () => on;
    await h.call("obsidian_append_note", { path: "Notes/Plan.md", content: "x" });
    on = true;
    await h.call("obsidian_append_note", { path: "Notes/Plan.md", content: "x" });
    const lines = await h.lines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].code, "protection_required");
    await h.close();
  });
});

describe("refusalLog off: the journal is what it was before", () => {
  for (const s of STAGES) {
    test(s.name, async () => {
      const h = await harness(VAULT, { on: false, settings: s.settings, records: s.records, opts: s.opts, leaves: s.leaves });
      await h.call(s.tool, s.args(h));
      const lines = await h.lines();
      for (const l of lines) {
        assert.notEqual(l.outcome, "refused");
        assert.equal(l.code, undefined);
        assert.equal(l.codeFamily, undefined);
      }
      if (s.stage === "pre") assert.equal(lines.length, 0, JSON.stringify(lines));
      if (s.stage === "dequeue") {
        assert.equal(lines.length, 1, JSON.stringify(lines));
        assert.ok(["error", "conflict"].includes(lines[0].outcome));
        assert.ok(lines[0].argsDigest, "the pre-existing record keeps its digest");
      }
      await h.close();
    });
  }

  test("a fresh kernel has the log off", () => {
    assert.equal(new Kernel().refusalLogOn(), false);
  });
});

describe("the guard alone: the Sync guard", () => {
  function guardHarness(on) {
    const jfiles = new Map();
    const adapter = { async exists(p) { return jfiles.has(p); }, async mkdir() {}, async write(p, d) { jfiles.set(p, d); }, async append(p, d) { jfiles.set(p, (jfiles.get(p) ?? "") + d); } };
    const journal = new WriteJournal(adapter, "j", () => new Date("2026-10-21T12:00:00Z"));
    const kernel = new Kernel(new WriteQueue(5000), journal);
    kernel.refusalLog = () => on;
    const lines = async () => { await new Promise((r) => setTimeout(r, 5)); return (jfiles.get("j/2026-10.jsonl") ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l)); };
    return { kernel, lines, raw: async () => { await lines(); return jfiles.get("j/2026-10.jsonl") ?? ""; } };
  }
  const def = { title: "move", annotations: { readOnlyHint: false }, inputSchema: {} };
  const ACTOR = { transport: "mcp", connection: "c-1", session: "s-1" };

  for (const on of [true, false]) {
    test(`Sync guard refusal (${on ? "on" : "off"})`, async () => {
      const g = guardHarness(on);
      const guarded = makeGuarded({
        getSettings: () => ({ allowlist: [], readOnly: false }),
        kernel: g.kernel,
        actor: () => ACTOR,
        syncGuard: async () => ({ refuse: { code: "sync_behind", message: "behind" } }),
      });
      const r = await guarded(def, async () => ({ content: [{ type: "text", text: "moved" }] }), "obsidian_move_note")({ from: "A.md", to: "B.md", idempotency_key: "k", intent: MARK }, {});
      assert.match(r.content[0].text, /Error \[sync_behind\]/);
      const lines = await g.lines();
      if (!on) { assert.equal(lines.length, 0); return; }
      assert.equal(lines.length, 1);
      assertRefusedShape(lines[0]);
      assert.equal(lines[0].code, "sync_behind");
      assert.equal(lines[0].codeFamily, "sync");
      assert.deepEqual(lines[0].target, { path: "A.md", paths: ["A.md", "B.md"] });
      assert.equal(lines[0].actor.session, "s-1");
      assert.ok(!(await g.raw()).includes(MARK));
    });
  }
});

describe("the codes and the families (core)", () => {
  test("a coded error envelope is a refusal; a failure code or an uncoded error is not", () => {
    const env = (text) => ({ isError: true, content: [{ type: "text", text }] });
    assert.equal(refusalCodeOf(env("Error [no_match]: x")), "no_match");
    assert.equal(refusalCodeOf(env("Error [write_timeout]: x")), undefined);
    assert.equal(refusalCodeOf(env("Error [partial]: x")), undefined);
    assert.equal(refusalCodeOf(env("something broke")), undefined);
    assert.equal(refusalCodeOf({ content: [{ type: "text", text: "Error [no_match]: x" }] }), undefined, "not an error result");
    assert.equal(refusalCodeOfThrown(Object.assign(new Error("x"), { code: "rev_conflict" })), "rev_conflict");
    assert.equal(refusalCodeOfThrown(Object.assign(new Error("x"), { code: "probe_failed" })), undefined);
    assert.equal(refusalCodeOfThrown(new Error("Error [cache_mismatch]: x")), "cache_mismatch");
    assert.equal(refusalCodeOfThrown(new Error("plain")), undefined);
  });

  test("families name the guard stage; an unlisted code is a tool's own", () => {
    for (const [code, fam] of [["input_validation", "schema"], ["out_of_allowlist", "allowlist"], ["write_scope", "write_scope"], ["protection_required", "protection"], ["uid_unresolved", "address"], ["address_unresolved", "address"], ["truncated_read", "read_limit"], ["record_immutable", "record"], ["rev_conflict", "rev"], ["idempotency_mismatch", "idempotency"], ["accept_forbidden", "accept"], ["sync_behind", "sync"], ["h1_replace", "h1"], ["cache_mismatch", "cache"], ["profile_refused", "profile"], ["no_match", "tool"]]) {
      assert.equal(refusalFamily(code), fam, code);
    }
  });
});

describe("the setting: default off, and the machine-local settings override reads it", () => {
  const LOC = { path: "/opt/example/state/local/settings.json", source: "default" };
  function plugin(data, override) {
    const p = new VaultMcpPlugin();
    const state = { disk: data === undefined ? null : structuredClone(data) };
    p.loadData = async () => (state.disk === null ? null : structuredClone(state.disk));
    p.saveData = async (d) => { state.disk = structuredClone(d); };
    p.localSettings = override ? { state: "loaded", location: LOC, override, keys: overridePaths(override) } : { state: "absent", location: LOC };
    return { p, state };
  }

  test("a fresh install has it off; anything but a literal true is off", async () => {
    const fresh = plugin(undefined);
    await fresh.p.loadSettings();
    assert.equal(fresh.p.settings.refusalLog, false);
    for (const v of ["true", 1, null]) {
      const h = plugin({ refusalLog: v });
      await h.p.loadSettings();
      assert.equal(h.p.settings.refusalLog, false, String(v));
    }
  });

  test("the override's allowed keys include refusalLog (a boolean); a save keeps it out of data.json", async () => {
    const fresh = plugin(undefined);
    await fresh.p.loadSettings();
    // The override is checked against the plugin's default shape (DEFAULT_SETTINGS), which the fresh settings are.
    assert.deepEqual(checkOverride({ refusalLog: true }, fresh.p.settings), []);
    assert.match(checkOverride({ refusalLog: "yes" }, fresh.p.settings).join("\n"), /refusalLog must be a boolean/);
    const { p, state } = plugin({ readOnly: false }, { refusalLog: true });
    await p.loadSettings();
    assert.equal(p.settings.refusalLog, true);
    p.settings.readOnly = true;
    await p.saveSettings();
    assert.notEqual(state.disk.refusalLog, true, "the machine-local value never reaches data.json");
  });
});
