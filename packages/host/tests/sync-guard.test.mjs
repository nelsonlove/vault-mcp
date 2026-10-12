// The Sync guard (kernel/sync-guard.ts): 01.43, Nelson's pick A of 2026-10-12,
// on "Make vault-mcp check Obsidian Sync before a write, behind a setting".
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSyncGuard,
  DEFAULT_SYNC_GUARD,
  MAX_WAIT_SECONDS,
  judgeSync,
  STALE_SERVER_MS,
  syncKindOf,
  decideSync,
  readSyncSnapshot,
  createSyncGuard,
  SYNC_BEHIND,
  SYNC_UNKNOWN,
} from "../src/kernel/sync-guard.ts";
import { MCP_SURFACE_INVENTORY } from "../src/kernel/operations/inventory-mcp.ts";
import { Kernel, WriteQueue, WriteJournal, IdempotencyStore, LockStore } from "../src/kernel/index.ts";
import { makeGuarded, withSyncWarning } from "../src/mcp/guarded.ts";

const NOW = 1_800_000_000_000;
const synced = (over = {}) => ({ state: "fields", fields: { ready: true, error: null, pause: false, syncStatus: "Fully synced", pendingPaths: [], socketOpen: true, lastMessageTs: NOW - 1000, ...over } });
// Behind for every write: the socket to the Sync server is closed.
const behind = () => synced({ socketOpen: false });

describe("settings", () => {
  test("ships off, refuse, 30 s, warn on unknown", () => {
    assert.deepEqual({ ...DEFAULT_SYNC_GUARD }, { enabled: false, mode: "refuse", waitSeconds: 30, onUnknown: "warn" });
    assert.deepEqual(normalizeSyncGuard(undefined), { ...DEFAULT_SYNC_GUARD });
  });
  test("a hand-edited value is coerced, never a crash; enabled only on a literal true; the wait is clamped", () => {
    assert.deepEqual(normalizeSyncGuard({ enabled: "yes", mode: "nope", waitSeconds: "5", onUnknown: 3 }), { ...DEFAULT_SYNC_GUARD });
    assert.equal(normalizeSyncGuard({ enabled: true }).enabled, true);
    assert.equal(normalizeSyncGuard({ waitSeconds: -4 }).waitSeconds, 0);
    assert.equal(normalizeSyncGuard({ waitSeconds: 1e9 }).waitSeconds, MAX_WAIT_SECONDS);
    assert.equal(normalizeSyncGuard({ mode: "warn", onUnknown: "refuse" }).mode, "warn");
    assert.equal(normalizeSyncGuard({ mode: "warn", onUnknown: "refuse" }).onUnknown, "refuse");
  });
});

describe("judgeSync — what behind means", () => {
  test("synced when ready, no error, not paused, connected, with a fresh server message and nothing pending at the write's paths", () => {
    assert.deepEqual(judgeSync(synced(), NOW), { kind: "synced" });
    assert.deepEqual(judgeSync({ state: "off" }, NOW), { kind: "off" });
  });
  test("each cause of behind", () => {
    for (const [over, re] of [
      [{ ready: false }, /not ready/],
      [{ error: true }, /error/],
      [{ pause: true }, /paused/],
      [{ socketOpen: false }, /disconnected/],
      [{ lastMessageTs: NOW - STALE_SERVER_MS - 1 }, /no message from the Sync server/],
    ]) {
      const v = judgeSync(synced(over), NOW);
      assert.equal(v.kind, "behind", JSON.stringify(over));
      assert.match(v.status, re);
    }
  });
  test("#528: the status text is not judged: Indexing and Uploading are synced while connected", () => {
    for (const st of ["Indexing...", "Uploading a.md", "Downloading b.md", "anything new"]) {
      assert.deepEqual(judgeSync(synced({ syncStatus: st }), NOW, ["X.md"]), { kind: "synced" }, st);
    }
  });
  test("#528: a pending server change counts only at the write's own paths (the note, a folder holding it, or a note under a target folder)", () => {
    const s = synced({ pendingPaths: ["A/B.md", "Busy/Other.md", "Dir"] });
    assert.equal(judgeSync(s, NOW, ["A/B.md"]).kind, "behind");
    assert.match(judgeSync(s, NOW, ["A/B.md"]).status, /A\/B\.md/);
    assert.equal(judgeSync(s, NOW, ["A"]).kind, "behind", "a folder target holding a pending note");
    assert.equal(judgeSync(s, NOW, ["Dir/New.md"]).kind, "behind", "a pending folder holding the target");
    assert.equal(judgeSync(s, NOW, ["Busy/Mine.md"]).kind, "synced", "a pending note beside the target does not count");
    assert.equal(judgeSync(s, NOW, ["AB.md"]).kind, "synced", "a name that only starts the same does not count");
    assert.equal(judgeSync(s, NOW).kind, "synced", "with no targets (the doctor's reading) pending changes are not judged");
  });
  test("error counts only as a literal true (it is a boolean, false when well; measured 2026-10-12)", () => {
    assert.deepEqual(judgeSync(synced({ error: false }), NOW), { kind: "synced" });
    assert.deepEqual(judgeSync(synced({ error: "stale" }), NOW), { kind: "synced" });
  });
  test("a missing or changed field is unknown, and names the field", () => {
    const v = judgeSync(synced({ pendingPaths: undefined, socketOpen: undefined, lastMessageTs: "x" }), NOW);
    assert.equal(v.kind, "unknown");
    assert.match(v.why, /newServerFiles/);
    assert.match(v.why, /server\.socket/);
    assert.match(v.why, /server\.lastMessageTs/);
    assert.equal(judgeSync(synced({ syncStatus: undefined }), NOW).kind, "synced", "the status text is optional now");
  });
});

describe("the kind of each write, from the inventory", () => {
  test("the note's tools: structure kinds and content kinds", () => {
    for (const t of ["obsidian_move_note", "obsidian_move_notes", "obsidian_assign_address", "obsidian_refile_address", "obsidian_renumber_address", "obsidian_delete_note", "obsidian_trash", "obsidian_create_note_from_template", "obsidian_base_create", "obsidian_periodic_note"]) {
      assert.equal(syncKindOf(t, {}), "structure", t);
    }
    for (const t of ["obsidian_patch_note", "obsidian_manage_frontmatter", "obsidian_rename_heading", "obsidian_append_note", "obsidian_append_at_heading"]) {
      assert.equal(syncKindOf(t, {}), "content", t);
    }
  });
  test("write_note: a create is structure, an overwrite is content; a write_notes item without if_rev is a create", () => {
    assert.equal(syncKindOf("obsidian_write_note", { overwrite: false }), "structure");
    assert.equal(syncKindOf("obsidian_write_note", {}), "structure");
    assert.equal(syncKindOf("obsidian_write_note", { overwrite: true }), "content");
    assert.equal(syncKindOf("obsidian_write_notes", { create_only: true }), "structure");
    assert.equal(syncKindOf("obsidian_write_notes", { create_only: false }), "content");
  });
  test("a read, a non-note write and an unknown tool are not checked", () => {
    assert.equal(syncKindOf("obsidian_read_note", {}), null);
    assert.equal(syncKindOf("obsidian_claim_scope", {}), null);
    assert.equal(syncKindOf("no_such_tool", {}), null);
  });
  test("only mutating rows carry a kind", () => {
    for (const r of MCP_SURFACE_INVENTORY) if (r.syncKind !== undefined) assert.equal(r.readOnly, false, r.tool);
  });
});

// A fake clock: sleep advances it, so a wait costs no wall time.
function clock(states) {
  let t = NOW;
  let i = 0;
  const sleeps = [];
  return {
    sleeps,
    deps: (settings) => ({
      settings: normalizeSyncGuard({ enabled: true, ...settings }),
      read: () => states[Math.min(i++, states.length - 1)],
      now: () => t,
      sleep: async (ms) => { sleeps.push(ms); t += ms; },
      pollMs: 1000,
    }),
  };
}

describe("decideSync", () => {
  test("off, a tool it does not check, Sync off, or synced: nothing to say", async () => {
    assert.equal(await decideSync("obsidian_move_note", {}, { ...clock([behind()]).deps({}), settings: { ...DEFAULT_SYNC_GUARD } }), null);
    assert.equal(await decideSync("obsidian_read_note", {}, clock([behind()]).deps({})), null);
    assert.equal(await decideSync("obsidian_move_note", {}, clock([{ state: "off" }]).deps({})), null);
    assert.equal(await decideSync("obsidian_move_note", {}, clock([synced()]).deps({})), null);
  });
  test("refuse: a structure write waits the whole wait, then is refused with sync_behind and the status", async () => {
    const c = clock([behind()]);
    const d = await decideSync("obsidian_move_note", {}, c.deps({ waitSeconds: 5 }));
    assert.equal(d.refuse.code, SYNC_BEHIND);
    assert.match(d.refuse.message, /disconnected/);
    assert.match(d.refuse.message, /Nothing was written/);
    assert.equal(c.sleeps.reduce((a, b) => a + b, 0), 5000);
  });
  test("a write that catches up during the wait goes on with nothing to say", async () => {
    const c = clock([behind(), behind(), synced()]);
    assert.equal(await decideSync("obsidian_trash", {}, c.deps({})), null);
    assert.equal(c.sleeps.length, 2);
  });
  test("mode wait: waits, then goes on with a warning", async () => {
    const d = await decideSync("obsidian_move_note", {}, clock([behind()]).deps({ mode: "wait", waitSeconds: 2 }));
    assert.match(d.warn, /behind after waiting 2 s/);
  });
  test("mode warn: no wait at all, only a warning", async () => {
    const c = clock([behind()]);
    const d = await decideSync("obsidian_move_note", {}, c.deps({ mode: "warn" }));
    assert.match(d.warn, /behind \(disconnected/);
    assert.equal(c.sleeps.length, 0);
  });
  test("a content write always waits, then warns, in every mode", async () => {
    for (const mode of ["refuse", "wait", "warn"]) {
      const c = clock([behind()]);
      const d = await decideSync("obsidian_append_note", {}, c.deps({ mode, waitSeconds: 1 }));
      assert.ok(d.warn, mode);
      assert.ok(c.sleeps.length > 0, `${mode}: waited`);
    }
  });
  test("unknown state: warn by default, refuse with sync_unknown when set", async () => {
    const u = { state: "unknown", why: "the Sync plugin is on but has no instance" };
    assert.match((await decideSync("obsidian_move_note", {}, clock([u]).deps({}))).warn, /cannot read/);
    const r = await decideSync("obsidian_move_note", {}, clock([u]).deps({ onUnknown: "refuse" }));
    assert.equal(r.refuse.code, SYNC_UNKNOWN);
    assert.equal((await decideSync("obsidian_move_note", {}, clock([u]).deps({}))).code, SYNC_UNKNOWN, "the warning carries its own code");
  });
});

describe("createSyncGuard — one wait for a burst, not one per call", () => {
  test("after a wait runs out, the next calls within waitSeconds are judged at once; a synced call clears the hold", async () => {
    let t = NOW;
    let state = behind();
    const sleeps = [];
    const guard = createSyncGuard(() => ({
      settings: normalizeSyncGuard({ enabled: true, waitSeconds: 10 }),
      read: () => state,
      now: () => t,
      sleep: async (ms) => { sleeps.push(ms); t += ms; },
      pollMs: 1000,
    }));
    assert.equal((await guard("obsidian_write_notes", { create_only: true })).refuse.code, SYNC_BEHIND);
    const waited = sleeps.length;
    assert.ok(waited > 0);
    assert.equal((await guard("obsidian_write_notes", { create_only: true })).refuse.code, SYNC_BEHIND);
    assert.ok((await guard("obsidian_append_note", {})).warn);
    assert.equal(sleeps.length, waited, "no second wait inside the hold");
    state = synced();
    assert.equal(await guard("obsidian_move_note", {}), null);
    state = behind();
    await guard("obsidian_move_note", {});
    assert.ok(sleeps.length > waited, "a synced call cleared the hold, so the next one waits again");
  });
});

describe("readSyncSnapshot — only the named fields", () => {
  test("no Sync plugin, or one that is off: off", () => {
    assert.deepEqual(readSyncSnapshot({}), { state: "off" });
    assert.deepEqual(readSyncSnapshot({ internalPlugins: { plugins: { sync: { enabled: false, instance: {} } } } }), { state: "off" });
  });
  test("on with no instance: unknown; a throwing getter: unknown", () => {
    assert.equal(readSyncSnapshot({ internalPlugins: { plugins: { sync: { enabled: true } } } }).state, "unknown");
    const app = { internalPlugins: { plugins: { sync: { enabled: true, get instance() { throw new Error("secret-key-material"); } } } } };
    const s = readSyncSnapshot(app);
    assert.equal(s.state, "unknown");
    assert.doesNotMatch(JSON.stringify(s), /secret/);
  });
  test("copies the named fields and nothing else: never the key or the salt, only each pending change's path", () => {
    const inst = { ready: true, error: null, pause: false, syncStatus: "Indexing...", newServerFiles: [{ path: "a.md", hash: "HASH-1", device: "MacBook Air" }, { path: "b/c.md" }], server: { lastMessageTs: NOW, socket: { readyState: 1 } }, key: "KEY-BYTES", salt: "SALT-BYTES", deviceName: "MacBook Pro" };
    const s = readSyncSnapshot({ internalPlugins: { plugins: { sync: { enabled: true, instance: inst } } } });
    assert.deepEqual(s, { state: "fields", fields: { ready: true, error: null, pause: false, syncStatus: "Indexing...", pendingPaths: ["a.md", "b/c.md"], socketOpen: true, lastMessageTs: NOW } });
    assert.doesNotMatch(JSON.stringify(s), /KEY|SALT|HASH|MacBook/);
  });
  test("no socket, or one that is not open, is socketOpen false", () => {
    const base = { ready: true, error: false, pause: false, syncStatus: "x", newServerFiles: [], key: "K" };
    const read = (server) => readSyncSnapshot({ internalPlugins: { plugins: { sync: { enabled: true, instance: { ...base, server } } } } }).fields.socketOpen;
    assert.equal(read({ lastMessageTs: NOW }), false);
    assert.equal(read({ lastMessageTs: NOW, socket: null }), false);
    assert.equal(read({ lastMessageTs: NOW, socket: { readyState: 3 } }), false);
  });
});

// ── through the guard ─────────────────────────────────────────────────────────
function kernelHarness() {
  const files = new Map();
  const adapter = { async exists(p) { return files.has(p); }, async mkdir() {}, async write(p, d) { files.set(p, d); }, async append(p, d) { files.set(p, (files.get(p) ?? "") + d); } };
  const journal = new WriteJournal(adapter, "j", () => new Date("2026-10-12T12:00:00Z"));
  const kernel = new Kernel(new WriteQueue(1000), journal, { uid: () => undefined, rev: () => undefined }, new IdempotencyStore(), new LockStore());
  const records = () => (files.get("j/2026-10.jsonl") ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { kernel, records };
}
const RW = { annotations: { readOnlyHint: false } };
const ACTOR = { transport: "mcp", client: "t", connection: "c" };
const tick = () => new Promise((r) => setTimeout(r, 5));
const okHandler = (flag) => async () => { flag.ran = true; return { content: [{ type: "text", text: "ok" }], structuredContent: { moved: true } }; };

describe("makeGuarded with the Sync guard", () => {
  test("a refusal returns the coded error before the queue: the handler never runs and nothing is journaled", async () => {
    const { kernel, records } = kernelHarness();
    const g = makeGuarded({
      getSettings: () => ({ readOnly: false, allowlist: [] }), kernel, actor: () => ACTOR,
      syncGuard: async () => ({ refuse: { code: SYNC_BEHIND, message: "behind" } }),
    });
    const flag = { ran: false };
    const res = await g(RW, okHandler(flag), "obsidian_move_note")({ from: "A.md", to: "B.md", idempotency_key: "k1", if_rev: 1 }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[sync_behind\]: behind/);
    assert.equal(flag.ran, false);
    await tick();
    assert.deepEqual(records(), []);
  });
  test("a warning goes on the result and on the journal record; the write runs", async () => {
    const { kernel, records } = kernelHarness();
    const g = makeGuarded({
      getSettings: () => ({ readOnly: false, allowlist: [] }), kernel, actor: () => ACTOR,
      syncGuard: async () => ({ warn: "Sync is behind", code: SYNC_BEHIND }),
    });
    const flag = { ran: false };
    const res = await g(RW, okHandler(flag), "obsidian_append_note")({ path: "A.md", content: "x", idempotency_key: "k2" }, {});
    assert.equal(flag.ran, true);
    assert.equal(res.structuredContent.sync_warning, "Sync is behind");
    assert.match(res.content.at(-1).text, /^Warning \[sync_behind\]: Sync is behind/);
    await tick();
    assert.equal(records().at(-1).syncWarning, "Sync is behind");
  });
  test("the guard is consulted after the protection check: a call missing its protection is refused for that, not for Sync", async () => {
    const { kernel } = kernelHarness();
    let asked = 0;
    const g = makeGuarded({
      getSettings: () => ({ readOnly: false, allowlist: [] }), kernel, actor: () => ACTOR,
      syncGuard: async () => { asked++; return { refuse: { code: SYNC_BEHIND, message: "behind" } }; },
    });
    const res = await g(RW, okHandler({}), "obsidian_append_note")({ path: "A.md", content: "x" }, {});
    assert.match(res.content[0].text, /protection_required/);
    assert.equal(asked, 0);
  });
  test("a retry whose idempotency key the kernel holds steps past the guard and is replayed", async () => {
    const { kernel } = kernelHarness();
    let asked = 0;
    let refuse = false;
    const g = makeGuarded({
      getSettings: () => ({ readOnly: false, allowlist: [] }), kernel, actor: () => ACTOR,
      syncGuard: async () => { asked++; return refuse ? { refuse: { code: SYNC_BEHIND, message: "behind" } } : null; },
    });
    const flag = { ran: false };
    const args = { from: "A.md", to: "B.md", idempotency_key: "k-retry" };
    const first = await g(RW, okHandler(flag), "obsidian_move_note")(args, {});
    assert.equal(first.isError, undefined);
    refuse = true;
    const again = await g(RW, okHandler(flag), "obsidian_move_note")(args, {});
    assert.equal(asked, 1, "the retry was not put to the Sync guard");
    assert.notEqual(again.isError, true, "replayed, not refused for Sync");
  });
  test("withSyncWarning: no warning, no envelope or an error result pass through; the code is the warning's own", () => {
    const r = { content: [{ type: "text", text: "ok" }] };
    const w = { text: "w", code: SYNC_UNKNOWN };
    assert.equal(withSyncWarning(r, undefined), r);
    assert.equal(withSyncWarning("x", w), "x");
    const err = { isError: true, content: [{ type: "text", text: "Error" }] };
    assert.equal(withSyncWarning(err, w), err);
    assert.match(withSyncWarning(r, w).content[1].text, /^Warning \[sync_unknown\]: w/);
  });
});

describe("#528: decideSync judges pending changes at the call's own paths", () => {
  const deps = (state) => ({ settings: normalizeSyncGuard({ enabled: true, waitSeconds: 0 }), read: () => state, now: () => NOW, sleep: async () => {} });
  test("a move whose source has a server change waiting is refused; one elsewhere goes on", async () => {
    const s = synced({ syncStatus: "Indexing...", pendingPaths: ["Inbox/A.md"] });
    assert.equal((await decideSync("obsidian_move_note", { from: "Inbox/A.md", to: "Done/A.md" }, deps(s))).refuse.code, SYNC_BEHIND);
    assert.equal(await decideSync("obsidian_move_note", { from: "Inbox/B.md", to: "Done/B.md" }, deps(s)), null);
  });
  test("a create while Sync says Indexing and is connected goes on with nothing to say", async () => {
    assert.equal(await decideSync("obsidian_write_note", { path: "New/N.md", overwrite: false }, deps(synced({ syncStatus: "Indexing...", pendingPaths: ["Other/X.md"] }))), null);
  });
});
