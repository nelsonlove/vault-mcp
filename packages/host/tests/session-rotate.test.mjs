/**
 * session-rotate.test.mjs — AN EXPIRED SESSION ON AN OPEN CONNECTION ROTATES.
 *
 * The defect: a fixed 24-hour TTL, counted from the socket connect, and one
 * session per connection. A Claude Code session holds its bridge connection for
 * days, so after the TTL every mutation refused with `session_not_live` and
 * nothing ever closed the connection — every write failed until the MCP server
 * was restarted by hand.
 *
 * The fix (`src/kernel/sessions/connection-session.ts`): on a call whose
 * session has EXPIRED, mark it expired, open a NEW session `continuedFrom` the
 * old id, and run the call under the new one. Pinned here:
 *
 *   • the rotation, its log lines, and the journal actor naming the new id;
 *   • no resurrect: the old record stays expired, and its id still refuses;
 *   • a REVOKED session (provider refusal, or the host's own record) never
 *     rotates, and keeps refusing;
 *   • concurrent calls share one rotation;
 *   • the refusal texts tell an agent not to write vault files directly.
 *
 * Every rotation test is paired with a case that makes the property false
 * (live session, revoked session), so a green run cannot come from an
 * assertion that never ran.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createConnectionSession } from "../src/kernel/sessions/connection-session.ts";
import { openSession, expiryRefusal, revokeSession, SESSION_TTL_MS } from "../src/kernel/sessions/session.ts";
import { createGovernanceSeam } from "../src/mcp/seam.ts";
import { makeGuarded } from "../src/mcp/guarded.ts";
import { createOperationExecutor } from "../src/kernel/operations/executor.ts";
import { createActionRegistry } from "../src/kernel/operations/registry.ts";
import { NO_DIRECT_WRITES } from "@vault-mcp/core";
import { Kernel, WriteJournal, WriteQueue, IdempotencyStore, LockStore } from "../src/kernel/index.ts";
import { DISCONNECT_REASON } from "../bridge/bridge.ts";

const T0 = 1_700_000_000_000;
const NO_DIRECT = "Do not write vault files directly; stop and retry, then report to your superior.";
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** A connection session over a fake clock and an in-memory lifecycle log. */
function fixture({ refuse, firstMint } = {}) {
  let now = T0;
  const lines = [];
  const log = {
    open: async (s, at) => { lines.push({ kind: "opened", at, session: s }); },
    close: async (id, at) => { lines.push({ kind: "closed", at, sessionId: id }); },
    markExpired: async (id, at) => { lines.push({ kind: "expired", at, sessionId: id }); },
  };
  let mints = 0;
  const mint = (continuedFrom, at) => {
    mints++;
    const s = openSession(
      { vaultId: "v", replicaId: "r", actor: { connection: "c-1", clientClaim: null }, journalHead: null, scopeDigest: "d", continuedFrom },
      at
    );
    return mints === 1 && firstMint ? firstMint(s) : s;
  };
  const conn = createConnectionSession({ log, mint, ...(refuse ? { refuse } : {}), now: () => now });
  return { conn, lines, set: (t) => { now = t; }, mints: () => mints };
}

const AFTER_TTL = T0 + SESSION_TTL_MS + 1;

describe("an expired session on an open connection rotates", () => {
  test("refresh opens a NEW session, continuedFrom the old id, and logs expired then opened", async () => {
    const f = fixture();
    const old = f.conn.current();
    f.set(AFTER_TTL);
    await f.conn.refresh();
    const now = f.conn.current();
    assert.notEqual(now.id, old.id, "a new session, not the old one revived");
    assert.equal(now.continuedFrom, old.id, "the link names the expired session");
    assert.equal(now.status, "open");
    assert.equal(now.openedAt, AFTER_TTL);
    assert.equal(now.expiresAt, AFTER_TTL + SESSION_TTL_MS, "its own TTL, from its own open");
    assert.equal(now.mandateId, null, "a link carries no mandate");
    assert.deepEqual(
      f.lines.map((l) => [l.kind, l.sessionId ?? l.session.id]),
      [["opened", old.id], ["expired", old.id], ["opened", now.id]]
    );
    assert.equal(f.lines[2].session.continuedFrom, old.id, "the opened line carries the link");
    assert.equal(await f.conn.refusal(), null, "the call then runs: nothing refuses the new session");
  });

  test("MUTATION CHECK: a LIVE session does not rotate", async () => {
    const f = fixture();
    const old = f.conn.current();
    f.set(T0 + SESSION_TTL_MS - 1);
    await f.conn.refresh();
    assert.equal(f.conn.current().id, old.id);
    assert.equal(f.lines.length, 1, "only the first open");
  });

  test("no resurrect: the old record stays expired, and its id still refuses", async () => {
    const f = fixture();
    const old = f.conn.current();
    f.set(AFTER_TTL);
    await f.conn.refresh();
    assert.equal(old.status, "open", "the old record object is never mutated");
    const r = expiryRefusal(old, AFTER_TTL);
    assert.equal(r.code, "session_not_live");
    assert.equal(r.status, "expired", "the old id is still expired, whatever the connection does next");
  });

  test("the close names the session current AT CLOSE", async () => {
    const f = fixture();
    f.set(AFTER_TTL);
    await f.conn.refresh();
    const now = f.conn.current();
    f.conn.close();
    await Promise.resolve();
    assert.deepEqual(f.lines.at(-1), { kind: "closed", at: AFTER_TTL, sessionId: now.id });
  });

  test("a CLOSED connection never rotates, even for a call still in flight", async () => {
    const f = fixture();
    const old = f.conn.current();
    f.set(AFTER_TTL);
    f.conn.close();
    await f.conn.refresh();
    assert.equal(f.conn.current().id, old.id, "no session opened after the close");
    assert.equal(f.mints(), 1);
    const r = await f.conn.refusal();
    assert.equal(r.code, "session_not_live", "the call refuses instead");
  });

  test("a close DURING the rotation's provider check also stops it", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const f = fixture({ refuse: async () => { await gate; return null; } });
    f.set(AFTER_TTL);
    const p = f.conn.refresh();
    f.conn.close();
    release();
    await p;
    assert.equal(f.mints(), 1);
  });

  test("the rotation asks the provider with purpose \"rotate\", the dequeue check with \"dequeue\"", async () => {
    const asked = [];
    const f = fixture({ refuse: async (id, purpose) => { asked.push(purpose); return null; } });
    f.set(AFTER_TTL);
    await f.conn.refresh();
    await f.conn.refusal();
    assert.deepEqual(asked, ["rotate", "dequeue"]);
  });

  test("two concurrent calls share ONE rotation", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const f = fixture({ refuse: async () => { await gate; return null; } });
    f.set(AFTER_TTL);
    const a = f.conn.refresh();
    const b = f.conn.refresh();
    release();
    await Promise.all([a, b]);
    assert.equal(f.mints(), 2, "the first session and exactly one successor");
    assert.equal(f.lines.filter((l) => l.kind === "opened").length, 2);
  });
});

describe("a revoked session never rotates", () => {
  test("a provider refusal of the OLD id (revocation) keeps the old session, and the call refuses", async () => {
    const { seam, consult } = createGovernanceSeam();
    let revoked = null;
    seam.registerSessionRefusal(
      "gov",
      async (id) => (id !== null && id === revoked ? { code: "session_revoked", detail: `session ${id} was revoked` } : null),
      { purposes: ["rotate"] }
    );
    const f = fixture({ refuse: (id) => consult.refuseSession(id) });
    const old = f.conn.current();
    revoked = old.id;
    f.set(AFTER_TTL);
    await f.conn.refresh();
    assert.equal(f.conn.current().id, old.id, "no new session was opened");
    assert.equal(f.mints(), 1);
    assert.equal(f.lines.filter((l) => l.kind === "opened").length, 1);
    const r = await f.conn.refusal();
    assert.equal(r.code, "session_not_live", "the expired-and-revoked session keeps refusing");
    // And it keeps refusing on every later call, too.
    await f.conn.refresh();
    assert.equal(f.conn.current().id, old.id);
  });

  test("a provider hook that THROWS does not rotate either (fail closed)", async () => {
    const f = fixture({ refuse: async () => { throw new Error("store unreadable"); } });
    const old = f.conn.current();
    f.set(AFTER_TTL);
    await f.conn.refresh();
    assert.equal(f.conn.current().id, old.id);
  });

  test("a session the HOST's own record says is revoked does not rotate", async () => {
    const f = fixture({ firstMint: (s) => revokeSession(s, "a human said so") });
    const old = f.conn.current();
    f.set(AFTER_TTL);
    await f.conn.refresh();
    assert.equal(f.conn.current().id, old.id);
    const r = await f.conn.refusal();
    assert.equal(r.status, undefined, "the refusal is the coded shape only");
    assert.equal(r.code, "session_not_live");
    assert.match(r.detail, /is revoked/);
  });

  test("a revocation of a LIVE session still refuses through the provider (unchanged)", async () => {
    const f = fixture({ refuse: async (id) => ({ code: "session_revoked", detail: `revoked ${id}` }) });
    await f.conn.refresh();
    const r = await f.conn.refusal();
    assert.equal(r.code, "session_revoked");
  });
});

describe("a store read error refuses a rotation, but not a call", () => {
  // The governor answers the seam's hook from its session store. At dequeue a
  // store read error is silence (the host's expiry floor still holds); before a
  // ROTATION it must refuse, because a rotation needs a positive "not revoked".
  test("the governor's hook: read error ⇒ refusal for \"rotate\", silence for \"dequeue\"", async () => {
    const { sessionRefusalFrom } = await import("../../governor/src/wiring/session-refusal.ts");
    const hook = sessionRefusalFrom({ revocationRefusal: async () => { throw new Error("sessions.jsonl unreadable"); } });
    const r = await hook("s-1", "rotate");
    assert.equal(r.code, "session_store_unreadable");
    assert.equal(await hook("s-1", "dequeue"), null, "the normal call path is unchanged");
    assert.equal(await hook("s-1"), null, "an older host passes no purpose: unchanged too");
  });

  test("the governor's hook still refuses a REVOKED id for both purposes", async () => {
    const { sessionRefusalFrom } = await import("../../governor/src/wiring/session-refusal.ts");
    const hook = sessionRefusalFrom({ revocationRefusal: async (id) => ({ code: "session_revoked", detail: id }) });
    assert.equal((await hook("s-1", "rotate")).code, "session_revoked");
    assert.equal((await hook("s-1", "dequeue")).code, "session_revoked");
  });

  test("end to end through the seam: a store read error means NO rotation", async () => {
    const { sessionRefusalFrom } = await import("../../governor/src/wiring/session-refusal.ts");
    const { seam, consult } = createGovernanceSeam();
    seam.registerSessionRefusal("gov", sessionRefusalFrom({ revocationRefusal: async () => { throw new Error("unreadable"); } }), { purposes: ["rotate"] });
    const f = fixture({ refuse: (id, purpose) => consult.refuseSession(id, purpose) });
    const old = f.conn.current();
    f.set(AFTER_TTL);
    await f.conn.refresh();
    assert.equal(f.conn.current().id, old.id, "the possibly-revoked session was not rotated");
    assert.equal(f.mints(), 1);
  });

  test("MUTATION CHECK: the same seam with a readable store rotates", async () => {
    const { sessionRefusalFrom } = await import("../../governor/src/wiring/session-refusal.ts");
    const { seam, consult } = createGovernanceSeam();
    seam.registerSessionRefusal("gov", sessionRefusalFrom({ revocationRefusal: async () => null }), { purposes: ["rotate"] });
    const f = fixture({ refuse: (id, purpose) => consult.refuseSession(id, purpose) });
    f.set(AFTER_TTL);
    await f.conn.refresh();
    assert.equal(f.mints(), 2);
  });
});

describe("a provider must DECLARE the rotate check before a session rotates", () => {
  // An older governor build, or a third-party provider, ignores `purpose` and
  // may return silence on a store failure. The host cannot tell that silence
  // from "not revoked", so it rotates only past hooks that declare "rotate".
  test("a provider that does not declare it: no rotation, and the expiry refusal (with the new text) stays", async () => {
    const { seam, consult } = createGovernanceSeam();
    seam.registerSessionRefusal("old-governor", async () => null);
    const f = fixture({ refuse: (id, purpose) => consult.refuseSession(id, purpose) });
    const old = f.conn.current();
    f.set(AFTER_TTL);
    await f.conn.refresh();
    assert.equal(f.conn.current().id, old.id, "no rotation");
    assert.equal(f.mints(), 1);
    const r = await f.conn.refusal();
    assert.equal(r.code, "session_not_live");
    assert.ok(r.detail.includes(NO_DIRECT), r.detail);
  });

  test("MUTATION CHECK: the same provider, declaring it, lets the session rotate", async () => {
    const { seam, consult } = createGovernanceSeam();
    seam.registerSessionRefusal("governor", async () => null, { purposes: ["rotate"] });
    const f = fixture({ refuse: (id, purpose) => consult.refuseSession(id, purpose) });
    f.set(AFTER_TTL);
    await f.conn.refresh();
    assert.equal(f.mints(), 2);
  });

  test("one declaring and one non-declaring provider: no rotation (every hook must declare)", async () => {
    const { seam, consult } = createGovernanceSeam();
    seam.registerSessionRefusal("governor", async () => null, { purposes: ["rotate"] });
    seam.registerSessionRefusal("third-party", async () => null);
    assert.equal((await consult.refuseSession("s-1", "rotate")).code, "session_rotation_unsupported");
  });

  test("no provider at all: rotation proceeds (the host's floor has no revocation)", async () => {
    const { consult } = createGovernanceSeam();
    const f = fixture({ refuse: (id, purpose) => consult.refuseSession(id, purpose) });
    f.set(AFTER_TTL);
    await f.conn.refresh();
    assert.equal(f.mints(), 2);
  });

  test("a malformed declaration is refused at registration", () => {
    const { seam } = createGovernanceSeam();
    assert.throws(() => seam.registerSessionRefusal("p", async () => null, { purposes: "rotate" }), TypeError);
  });

  test("the governor declares the rotate check, pinned at the source", async () => {
    const fs = await import("node:fs");
    const main = fs.readFileSync(new URL("../../governor/src/main.ts", import.meta.url), "utf8");
    assert.match(main, /sessionRefusalPurposes: \["rotate"\]/);
  });
});

describe("through the write path: the call succeeds under the new session", () => {
  function fixtureKernel() {
    const files = new Map();
    const adapter = {
      async exists(p) { return files.has(p); },
      async mkdir() {},
      async read(p) { return files.get(p) ?? ""; },
      async write(p, data) { files.set(p, data); },
      async append(p, data) { files.set(p, (files.get(p) ?? "") + data); },
    };
    const journal = new WriteJournal(adapter, "dir/journal", () => new Date("2026-08-20T12:00:00Z"));
    const records = [];
    const append = journal.append.bind(journal);
    journal.append = (r) => { records.push(r); return append(r); };
    return { kernel: new Kernel(new WriteQueue(), journal, undefined, new IdempotencyStore(), new LockStore()), records };
  }

  function noteWriteRegistry() {
    const registry = createActionRegistry();
    registry.register({
      id: "note.write",
      version: 1,
      title: "Write a note",
      postcondition: "Replace the content of one note.",
      owner: "core",
      distribution: "public-default",
      modes: ["proposal-mutation"],
      changeClasses: ["content"],
      observations: { defaultCapture: "ephemeral", supportsProposal: false },
      effects: { direct: ["note-content"], discovered: "none" },
      authority: { governorOnly: false, automaticAdmission: "never" },
      scope: { argumentKeys: ["path"], resolvesAddresses: true, enumeration: "not-applicable", whenScoped: "available" },
      retention: { operation: "durable-for-mutation" },
      inputs: ["path", "content"],
      native: true,
    });
    registry.bind({ kind: "mcp", id: "obsidian_write_note", action: "note.write", actionVersion: 1 });
    registry.validate();
    return registry;
  }

  function wired(f, { refresh = true, executor = false, handler, syncGuard } = {}) {
    const { kernel, records } = fixtureKernel();
    let ran = 0;
    const operations = [];
    const closed = [];
    const guarded = makeGuarded({
      ...(syncGuard ? { syncGuard } : {}),
      getSettings: () => ({ readOnly: false, allowlist: [] }),
      kernel,
      actor: () => ({ transport: "mcp", connection: "c-1", session: f.conn.current().id }),
      sessionRefusal: (id) => f.conn.refusal(id),
      ...(refresh ? { sessionRefresh: () => f.conn.refresh() } : {}),
      ...(executor
        ? {
            executor: createOperationExecutor({
              registry: noteWriteRegistry(),
              actor: () => ({ binding: "c-1", clientClaim: null }),
              sessionId: () => f.conn.current().id,
              propose: (operation) => { operations.push(operation.sessionId); },
              onClose: (operation) => { closed.push(operation.sessionId); },
            }),
          }
        : {}),
    });
    const call = guarded(
      { annotations: RW, inputSchema: {} },
      handler ?? (async () => { ran++; return { content: [{ type: "text", text: "wrote" }] }; }),
      "obsidian_write_note"
    );
    return { call, records, ran: () => ran, operations, closed };
  }

  test("a rotation by a concurrent call INSIDE an awaited guard cannot split one call across two sessions", async () => {
    const f = fixture();
    const s1 = f.conn.current();
    let release;
    const gate = new Promise((r) => { release = r; });
    // Call A is parked in the Sync guard (an await between the executor
    // building its operation and the call reaching the queue).
    const w = wired(f, {
      executor: true,
      syncGuard: async (_name, args) => { if (args.path === "a.md") await gate; return null; },
    });
    const a = w.call({ path: "a.md" });
    await new Promise((r) => setTimeout(r, 5));
    // S1 expires, and call B rotates the connection to S2 while A waits.
    f.set(AFTER_TTL);
    const resB = await w.call({ path: "b.md" });
    assert.equal(resB.isError, undefined);
    const s2 = f.conn.current();
    assert.equal(s2.continuedFrom, s1.id);
    release();
    const resA = await a;
    // A's operation, A's journal actor and A's dequeue check all name S1: one
    // session id everywhere, so A refuses (S1 is expired) instead of running
    // under S2's check while its operation names S1.
    assert.deepEqual(w.closed, [s2.id, s1.id], "B's operation names S2, A's names S1");
    const recA = w.records.find((r) => r.target?.path === "a.md");
    assert.equal(recA.actor.session, s1.id, "A's journal names S1 too");
    assert.equal(resA.isError, true);
    assert.match(resA.content.map((c) => c.text).join("\n"), /session_not_live/);
    const recB = w.records.find((r) => r.target?.path === "b.md");
    assert.equal(recB.actor.session, s2.id);
  });

  test("the operation record, the journal actor and the observer all name the NEW session", async () => {
    const f = fixture();
    const old = f.conn.current();
    const w = wired(f, { executor: true });
    f.set(AFTER_TTL);
    const res = await w.call({ path: "a.md" });
    assert.equal(res.isError, undefined);
    const now = f.conn.current();
    assert.notEqual(now.id, old.id);
    assert.deepEqual(w.operations, [now.id], "the operation (and so the write observer) names the new session");
    assert.equal(w.records[0].actor.session, now.id, "the journal names the new session");
  });

  test("a call QUEUED under a session that expires and rotates meanwhile refuses once; its retry runs under the new one", async () => {
    const f = fixture();
    const s1 = f.conn.current();
    // Call A is enqueued under live S1 and parked inside the queue (the kernel
    // serializes, so a first write that blocks holds A behind it).
    let unblock;
    const blocker = new Promise((r) => { unblock = r; });
    const w = wired(f, {
      handler: async (args) => {
        if (args.path === "block.md") await blocker;
        return { content: [{ type: "text", text: "wrote" }] };
      },
    });
    const first = w.call({ path: "block.md" });
    const a = w.call({ path: "a.md" });
    await new Promise((r) => setTimeout(r, 5));
    // S1 expires, and call B rotates the connection to S2.
    f.set(AFTER_TTL);
    const b = w.call({ path: "b.md" });
    await new Promise((r) => setTimeout(r, 5));
    const s2 = f.conn.current();
    assert.equal(s2.continuedFrom, s1.id, "B rotated the connection");
    unblock();
    await first;
    const resA = await a;
    assert.equal(resA.isError, true, "A was enqueued under S1, which is expired: it must not run under S2's check");
    assert.match(resA.content.map((c) => c.text).join("\n"), /session_not_live/);
    assert.ok(resA.content.map((c) => c.text).join("\n").includes(NO_DIRECT), "with the new text");
    const recA = w.records.find((r) => r.target?.path === "a.md");
    assert.equal(recA.actor.session, s1.id, "A is journaled under S1, the session it was refused for");
    const resB = await b;
    assert.equal(resB.isError, undefined, "B runs under S2");
    const retry = await w.call({ path: "a.md" });
    assert.equal(retry.isError, undefined, "A's retry runs under S2");
    assert.equal(w.records.at(-1).actor.session, s2.id);
  });

  test("an expired session rotates and the write lands, journaled under the NEW session id", async () => {
    const f = fixture();
    const old = f.conn.current();
    const w = wired(f);
    f.set(AFTER_TTL);
    const res = await w.call({ path: "a.md" });
    assert.equal(res.isError, undefined, "the call succeeds");
    assert.equal(w.ran(), 1);
    const now = f.conn.current();
    assert.equal(now.continuedFrom, old.id);
    assert.equal(w.records.length, 1);
    assert.equal(w.records[0].actor.session, now.id, "the journal names the session the write ran under");
    assert.notEqual(w.records[0].actor.session, old.id);
  });

  test("MUTATION CHECK: without the refresh hook the same call refuses, as before the fix", async () => {
    const f = fixture();
    const w = wired(f, { refresh: false });
    f.set(AFTER_TTL);
    const res = await w.call({ path: "a.md" });
    assert.equal(res.isError, true);
    assert.match(res.content.map((c) => c.text).join("\n"), /session_not_live/);
    assert.equal(w.ran(), 0);
  });
});

describe("the refusal texts say: do not write vault files directly", () => {
  test("the host's expiry refusal carries the instruction", () => {
    const s = openSession({ vaultId: "v", replicaId: "r", actor: { connection: "c", clientClaim: null }, journalHead: null, scopeDigest: "d" }, T0);
    const r = expiryRefusal(s, AFTER_TTL);
    assert.ok(r.detail.includes(NO_DIRECT), r.detail);
  });

  test("the bridge's disconnect message carries the instruction", () => {
    assert.ok(DISCONNECT_REASON.includes(NO_DIRECT), DISCONNECT_REASON);
  });

  test("the bridge's copy and core's NO_DIRECT_WRITES are the same text", () => {
    assert.equal(NO_DIRECT_WRITES, NO_DIRECT);
    assert.ok(DISCONNECT_REASON.endsWith(NO_DIRECT_WRITES), "the bridge copies core's text exactly");
  });
});
