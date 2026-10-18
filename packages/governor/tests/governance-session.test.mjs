/**
 * governance-session.test.mjs — WP5 sessions, as the PROVIDER still owns them
 * after S3c.
 *
 * ── WHAT THE SPLIT TOOK, AND WHERE IT WENT ──────────────────────────────────
 *
 * Condition 7 says THE HOST MINTS. `openSession` is host code
 * (`packages/host/src/kernel/sessions/session.ts`), the lifecycle record is the
 * host's `sessions.jsonl` written by `createSessionLog`, and NO connection-
 * lifecycle hook was added to the seam — deliberately, because a provider that
 * never mints does not need one. So three describes that used to live here are
 * gone rather than reimplemented:
 *
 *   • the MINTING contract (a UUIDv7 id bound to vault/replica/actor/base
 *     state/scope, `expiresAt === openedAt + SESSION_TTL_MS`, no mandate at
 *     open, a continuation link that inherits nothing) — host's `openSession`.
 *     **NOT COVERED ANYWHERE as of 2026-09-08**: `packages/host/tests/
 *     seam.test.mjs` only CALLS `openSession` to build fixtures for
 *     `expiryRefusal`, and `packages/core/tests/` carries no session test at
 *     all. Named as a gap rather than dropped quietly; it cannot be written
 *     here, because importing `openSession` would be a cross-package reach into
 *     the host's tree.
 *   • the DEQUEUE check, behaviourally — a mutating call whose session refusal
 *     fires refuses with the coded error and the handler never runs, `null` is
 *     silence, an unknown code renders verbatim, and no refusal hook means no
 *     check. That is `makeGuarded`'s `sessionRefusal` option, host code. **ALSO
 *     NOT COVERED**: host `seam.test.mjs` proves `createGovernanceSeam`'s
 *     `refuseSession` in isolation (deny-wins, throwing-hook-fails-closed,
 *     null-is-silence) but nothing passes `sessionRefusal` into `makeGuarded`,
 *     so the composition — the thing that makes a revocation actually stop a
 *     write — is asserted nowhere.
 *   • the SOURCE PINS over `src/mcp/server.ts` (`openSession(`, the executor's
 *     session id, the journal actor, `expiryRefusal(session, now)`,
 *     `ctx.seam?.refuseSession(`, the absence of `ctx.sessions.get(`). That file
 *     belongs to another package; a scan reaching across the boundary would pin
 *     a claim this plugin does not own. Dropped. What guards those facts now is
 *     the host's own suite, which does not yet pin them either.
 *
 * ── WHAT STAYS, BECAUSE IT IS THIS PLUGIN'S ─────────────────────────────────
 *
 * The durable STORE and the revocation state a human's Revoke gesture writes.
 * Plus, new at S3c, the ID-KEYED AUTHORITY FOLD: because the provider no longer
 * witnesses session OPEN, `revoke` and `attachMandate` must work on an id with
 * no `opened` record, `revocationRefusal(id)` answers the seam, and
 * `mandateOf(id)` serves the write observer. `foldSessionEvents` is UNCHANGED
 * and still refuses to invent a session — every historical line in a live
 * `governance/sessions.jsonl` folds exactly as before, which is asserted below.
 *
 * The pure transitions (`closeSession` / `revokeSession` / `expireSession` /
 * `attachMandate` / `SessionNotLiveError`) are `@vault-mcp/core`'s, not this
 * plugin's. They are exercised here anyway, deliberately: the fold is DEFINED
 * over them, core ships no session test, and a contract that only its consumer
 * tests is better than one nothing tests. If core grows its own suite these move
 * there.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  isLive,
  livenessOf,
  closeSession,
  revokeSession,
  expireSession,
  attachMandate,
  SessionNotLiveError,
  SESSION_TTL_MS,
} from "@vault-mcp/core";
import {
  createSessionStore,
  foldSessionEvents,
  foldSessionAuthority,
} from "../src/kernel/sessions/session-store.ts";

const T0 = 1_700_000_000_000;

/**
 * A session RECORD, built as a literal.
 *
 * It is not minted with `openSession` because that function is the host's now,
 * and this file must not reach across the package boundary. The shape is
 * core's published `SessionV1`, which is what actually crosses: everything below
 * cares that the fold and the transitions handle a well-formed record, never how
 * the host arrived at one. `id` is a plain string here — `isUuidV7` is asserted
 * against the real thing in the host's tree, not manufactured here.
 */
let seq = 0;
function open(over = {}, at = T0) {
  const id = `0190${String(++seq).padStart(4, "0")}-0000-7000-8000-000000000000`;
  return {
    schema: "governor.session/v1",
    id,
    vaultId: "vault-1",
    replicaId: "install-abc",
    actor: { connection: "conn-1", clientClaim: "claude-code/1.0" },
    baseState: { journalHead: "2026-08.jsonl:1234" },
    scopeDigest: "d".repeat(64),
    openedAt: at,
    expiresAt: at + SESSION_TTL_MS,
    mandateId: null,
    continuedFrom: null,
    relatedSessions: [],
    status: "open",
    ...over,
  };
}

// ── the contract the fold is defined over (core's, exercised by its consumer) ─

describe("session liveness — decided at use, never by a writer", () => {
  test("open and unexpired is live; past expiry is not, with no writer needed", () => {
    const s = open();
    assert.ok(isLive(s, T0 + 1000));
    assert.ok(!isLive(s, T0 + SESSION_TTL_MS), "expiry boundary is exclusive");
    assert.equal(livenessOf(s, T0 + SESSION_TTL_MS), "expired");
    assert.equal(livenessOf(s, T0 + 1), "open");
  });

  test("closed and revoked are never live, regardless of clock", () => {
    const s = open();
    assert.ok(!isLive(closeSession(s), T0 + 1));
    assert.ok(!isLive(revokeSession(s, "operator request"), T0 + 1));
  });
});

describe("session transitions are one-way", () => {
  test("closing a closed session refuses with the typed error", () => {
    const closed = closeSession(open());
    assert.throws(() => closeSession(closed), SessionNotLiveError);
  });

  test("a revoked session stays revoked — revoke is idempotent, nothing resurrects", () => {
    const revoked = revokeSession(open(), "compromised");
    assert.equal(revokeSession(revoked, "again").status, "revoked");
    assert.equal(revoked.revokedReason, "compromised");
    assert.throws(() => closeSession(revoked), SessionNotLiveError);
  });

  test("expiry is explicit and refuses before its time", () => {
    const s = open();
    assert.throws(() => expireSession(s, T0 + 10));
    assert.equal(expireSession(s, T0 + SESSION_TTL_MS).status, "expired");
  });

  test("a mandate binds SET-ONCE on a record, and only to a live one", () => {
    const s = open();
    assert.equal(attachMandate(s, "m-1").mandateId, "m-1");
    assert.throws(() => attachMandate(attachMandate(s, "m-1"), "m-2"));
    assert.throws(() => attachMandate(closeSession(s), "m-1"), SessionNotLiveError);
  });
});

// ── the durable store ────────────────────────────────────────────────────────

function memoryIo() {
  const lines = [];
  return {
    lines,
    async appendLine(line) {
      lines.push(line);
    },
    async readLines() {
      return [...lines];
    },
  };
}

describe("session store — append-only events, folded state", () => {
  test("open → get returns the session; close advances it durably", async () => {
    const io = memoryIo();
    const store = createSessionStore(io);
    const s = open();
    await store.open(s, T0);
    assert.deepEqual(await store.get(s.id), s);

    await store.close(s.id, T0 + 100);
    assert.equal((await store.get(s.id)).status, "closed");

    // Every mutation is an APPENDED event — nothing rewritten.
    assert.equal(io.lines.length, 2);
    assert.match(io.lines[0], /"opened"/);
    assert.match(io.lines[1], /"closed"/);
  });

  test("a fresh store instance folds the same state from the same lines — restart survives", async () => {
    const io = memoryIo();
    const store = createSessionStore(io);
    const s = open();
    await store.open(s, T0);
    await store.revoke(s.id, "operator", T0 + 5);

    const rebooted = createSessionStore(io);
    const after = await rebooted.get(s.id);
    assert.equal(after.status, "revoked");
    assert.equal(after.revokedReason, "operator");
    assert.deepEqual(await rebooted.revocationRefusal(s.id), {
      code: "session_revoked",
      detail: `this connection's session (${s.id}) was revoked in the review pane: operator. Reconnect to open a new session.`,
    });
  });

  test("markExpired records the observed expiry once; terminal states are left alone", async () => {
    const io = memoryIo();
    const store = createSessionStore(io);
    const s = open();
    await store.open(s, T0);
    await store.markExpired(s.id, T0 + SESSION_TTL_MS + 1);
    assert.equal((await store.get(s.id)).status, "expired");
    await store.markExpired(s.id, T0 + SESSION_TTL_MS + 2); // idempotent no-op
    assert.equal(io.lines.filter((l) => l.includes("expired")).length, 1);
  });

  test("duplicate open refuses; close on an unknown id still refuses", async () => {
    // `close` and `markExpired` remain RECORD operations — they fold a session
    // forward and have nothing to say about an id no record exists for. Only
    // `revoke` and `attachMandate` dropped their existence check at S3c, and the
    // next describe is why.
    const store = createSessionStore(memoryIo());
    const s = open();
    await store.open(s, T0);
    await assert.rejects(() => store.open(s, T0));
    await assert.rejects(() => store.close("no-such-id", T0), SessionNotLiveError);
  });
});

describe("session store — the fold survives garbage", () => {
  test("an unparseable line is skipped without losing prior sessions", () => {
    const s = open();
    const m = foldSessionEvents([JSON.stringify({ kind: "opened", at: T0, session: s }), "{corrupt", ""]);
    assert.equal(m.get(s.id)?.status, "open");
  });

  test("an event for an unknown session is ignored, never invented", () => {
    const m = foldSessionEvents([JSON.stringify({ kind: "closed", at: T0, sessionId: "ghost" })]);
    assert.equal(m.size, 0);
  });

  test("colliding history keeps the stronger state — a close after a revoke does not downgrade", () => {
    const s = open();
    const m = foldSessionEvents([
      JSON.stringify({ kind: "opened", at: T0, session: s }),
      JSON.stringify({ kind: "revoked", at: T0 + 1, sessionId: s.id, reason: "r" }),
      JSON.stringify({ kind: "closed", at: T0 + 2, sessionId: s.id }),
    ]);
    assert.equal(m.get(s.id)?.status, "revoked");
  });
});

// ── S3c: the id-keyed authority fold ─────────────────────────────────────────
//
// The provider stopped witnessing session OPEN when the host took the lifecycle
// record, and no lifecycle hook was added to the seam. What survives without a
// record is exactly two facts about an ID: was it revoked, and what mandate is
// bound to it. Both fold here.
//
// THE COST, asserted rather than asserted-away: `revoke` and `attachMandate` no
// longer verify the session is open, so the `sessionAttachWarning` for an attach
// to an already-expired session cannot fire any more. That is named in
// session-store.ts's header and pinned negatively below.

describe("authority fold — revocation and mandate binding, keyed by id alone", () => {
  test("revoke on an id with NO opened record works, and revocationRefusal reports it", async () => {
    // The whole point. Before S3c this refused `SessionNotLiveError`, which
    // after the split would have made EVERY revocation a no-op the moment the
    // two plugins separated — a human's Revoke gesture landing on nothing.
    const io = memoryIo();
    const store = createSessionStore(io);
    assert.equal(await store.get("s-unseen"), null, "the store really has no record for this id");

    await store.revoke("s-unseen", "operator pulled the plug", T0);
    const refusal = await store.revocationRefusal("s-unseen");
    assert.equal(refusal.code, "session_revoked");
    assert.match(refusal.detail, /s-unseen/);
    assert.match(refusal.detail, /operator pulled the plug/);
    assert.match(refusal.detail, /Reconnect to open a new session/);
    assert.equal(io.lines.length, 1, "one appended event, and no invented `opened`");
    assert.equal(await store.get("s-unseen"), null, "the RECORD fold still refuses to invent a session");
  });

  test("an unrevoked id is silence — null, never an allow", async () => {
    const store = createSessionStore(memoryIo());
    assert.equal(await store.revocationRefusal("never-heard-of-it"), null);
  });

  test("a second revoke is idempotent — permanent, and the first reason wins", async () => {
    const io = memoryIo();
    const store = createSessionStore(io);
    await store.revoke("s-1", "first reason", T0);
    await store.revoke("s-1", "second reason", T0 + 10);
    assert.equal(io.lines.length, 1, "nothing appended for the second call");
    assert.match((await store.revocationRefusal("s-1")).detail, /first reason/);
  });

  test("attachMandate binds SET-ONCE on an unseen id; a second attach refuses", async () => {
    const io = memoryIo();
    const store = createSessionStore(io);
    await store.attachMandate("s-unseen", "m-1", T0);
    assert.equal(await store.mandateOf("s-unseen"), "m-1");
    await assert.rejects(() => store.attachMandate("s-unseen", "m-2", T0 + 1), SessionNotLiveError);
    assert.equal(io.lines.length, 1, "the refused attach wrote nothing");
    assert.equal(await store.mandateOf("s-unseen"), "m-1", "the first binding stands");
  });

  test("attachMandate on a session that DOES have a record keeps the full kernel check", async () => {
    // A historical session — one opened before the split — still runs the
    // record transition first, so a closed session refuses before anything is
    // appended.
    const io = memoryIo();
    const store = createSessionStore(io);
    const s = open();
    await store.open(s, T0);
    await store.close(s.id, T0 + 1);
    await assert.rejects(() => store.attachMandate(s.id, "m-1", T0 + 2), SessionNotLiveError);
    assert.equal(io.lines.length, 2, "opened + closed only — the refused attach appended nothing");
  });

  test("THE NAMED LOSS: an attach to an unseen id that is really EXPIRED cannot be refused", async () => {
    // Stated in session-store.ts's header and pinned here so it stays a known
    // cost rather than becoming a surprise. With no record, "expired" is not a
    // fact this store holds — the attach succeeds. It is safe on the provider's
    // own prior ruling (mandate fit binds by SESSION ID; the record "is
    // provenance, not a gate"), and what is actually gone is the
    // `sessionAttachWarning`, never the grant's meaning.
    const store = createSessionStore(memoryIo());
    await store.attachMandate("long-dead-session", "m-9", T0);
    assert.equal(await store.mandateOf("long-dead-session"), "m-9");
  });

  test("mandateOf prefers the id-keyed binding and falls back to a folded record", async () => {
    // Both directions matter: after the split only `mandated` events are
    // written, but a mandate attached BEFORE it lives on the session record and
    // must still resolve — that is what the write observer's producer stamp
    // reads.
    const recordOnly = open({ mandateId: "m-from-record" });
    const store = createSessionStore({
      lines: [],
      appendLine: async () => {},
      readLines: async () => [JSON.stringify({ kind: "opened", at: T0, session: recordOnly })],
    });
    assert.equal(await store.mandateOf(recordOnly.id), "m-from-record", "the folded record still answers");

    const both = open({ mandateId: "m-from-record" });
    const withEvent = createSessionStore({
      lines: [],
      appendLine: async () => {},
      readLines: async () => [
        JSON.stringify({ kind: "opened", at: T0, session: both }),
        JSON.stringify({ kind: "mandated", at: T0 + 1, sessionId: both.id, mandateId: "m-from-event" }),
      ],
    });
    assert.equal(await withEvent.mandateOf(both.id), "m-from-event", "the id-keyed binding wins");
    assert.equal(await store.mandateOf("nothing-at-all"), null);
  });

  test("foldSessionAuthority is total over garbage and keyed by id, not by record", () => {
    const { revoked, mandates } = foldSessionAuthority([
      "{not json",
      "",
      JSON.stringify({ kind: "revoked", at: T0, sessionId: "a", reason: "first" }),
      JSON.stringify({ kind: "revoked", at: T0 + 1, sessionId: "a", reason: "second" }),
      JSON.stringify({ kind: "revoked", at: T0, sessionId: "", reason: "empty id" }),
      JSON.stringify({ kind: "mandated", at: T0, sessionId: "b", mandateId: "m-1" }),
      JSON.stringify({ kind: "mandated", at: T0 + 1, sessionId: "b", mandateId: "m-2" }),
      JSON.stringify({ kind: "mandated", at: T0, sessionId: "c", mandateId: "" }),
      JSON.stringify({ kind: "closed", at: T0, sessionId: "d" }),
    ]);
    assert.deepEqual([...revoked.keys()], ["a"], "an empty session id is not an id");
    assert.equal(revoked.get("a").revokedReason, "first", "first revocation wins — permanence");
    assert.deepEqual([...mandates.entries()], [["b", "m-1"]], "set once; an empty mandate id binds nothing");
  });

  test("a HISTORICAL sessions.jsonl folds through foldSessionEvents exactly as before", () => {
    // The compatibility half of the S3c change: the authority fold is a SECOND,
    // weaker read of the same log, not a replacement. A pre-split file — one
    // that really does carry `opened` lines — must still reconstruct records.
    const s = open();
    const historical = [
      JSON.stringify({ kind: "opened", at: T0, session: s }),
      JSON.stringify({ kind: "mandated", at: T0 + 1, sessionId: s.id, mandateId: "m-legacy" }),
      JSON.stringify({ kind: "revoked", at: T0 + 2, sessionId: s.id, reason: "a human said so" }),
    ];
    const records = foldSessionEvents(historical);
    const rec = records.get(s.id);
    assert.equal(rec.status, "revoked");
    assert.equal(rec.revokedReason, "a human said so");
    assert.equal(rec.mandateId, "m-legacy", "the record fold still applies the mandate transition");

    // …and the two folds agree about the same file.
    const { revoked, mandates } = foldSessionAuthority(historical);
    assert.equal(revoked.get(s.id).revokedReason, "a human said so");
    assert.equal(mandates.get(s.id), "m-legacy");
  });
});

// ── the wiring, pinned at the source ─────────────────────────────────────────

describe("session wiring — pinned, because unwired machinery is the known failure mode", async () => {
  const fs = await import("node:fs");
  const main = () => fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

  test("main.ts wires the durable store over the provider's own sessions.jsonl", () => {
    const src = main();
    assert.match(src, /createSessionStore\(/);
    assert.match(src, /governance\/sessions\.jsonl/);
    // The `journalHead: () => journalHeadMarker()` pin that used to sit here
    // moved WITH the code: the base-state head marker is part of minting, and
    // the host mints. It is in the host's main.ts, not this one.
    assert.ok(!src.includes("journalHeadMarker"), "minting, and its base-state marker, is the host's");
  });

  test("the seam's refusal hook is answered from the STORE, where a human's Revoke lands", () => {
    // The property S2 established and S3c had to preserve across a plugin
    // boundary: checking a closure-captured session object would never see a
    // store-level revoke, so only wall-clock expiry could ever refuse. The host
    // keeps the expiry floor over its own record; the provider answers
    // revocation from the store. This pin is the provider's half — the host's
    // half is a source fact in another package and is pinned nowhere today.
    const src = main();
    assert.match(src, /sessionRefusal: sessionRefusalFrom\(sessionStore\)/, "the provider registers the seam's refusal hook, over the store");
    const hook = fs.readFileSync(new URL("../src/wiring/session-refusal.ts", import.meta.url), "utf8");
    assert.match(hook, /store\.revocationRefusal\(sessionId\)/, "and answers it from the store");
    assert.match(src, /registerGovernance\(this, \{/, "through the seam, not through a host context object");
  });

  test("the write observer's mandate stamp reads the ID-KEYED binding, not a session record", () => {
    // The other half of the S3c fold, wired: the producer asks for
    // `mandateOf(id)` rather than for a session record it can no longer expect
    // to exist.
    assert.match(main(), /mandateId: await sessionStore\.mandateOf\(id\)/);
  });

  test("VACUITY: the source scan reads a real file and would notice a missing pin", () => {
    // Instrument discipline — a scan that silently reads "" passes every
    // `assert.match` it is given only because it never runs one that fails.
    const src = main();
    assert.ok(src.length > 5000, "main.ts was actually read");
    assert.ok(!/sessionStore\.revocationRefusalTYPO\(/.test(src), "control: a pin that should NOT match does not");
    assert.ok(!src.includes("createSessionLog("), "the host's lifecycle log factory is not in this plugin");
  });
});
