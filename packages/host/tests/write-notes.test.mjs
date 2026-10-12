/**
 * write-notes.test.mjs — obsidian_write_notes end-to-end through the REAL kernel
 * (slice B1). The dispatcher is driven with a real Kernel (write queue + journal
 * + if_rev + idempotency) and a fake in-memory vault, so these assertions prove
 * the invariants against the actual machinery, not a re-implementation:
 *
 *   • per-item journal records (Stewardship sees each note individually)
 *   • an if_rev conflict on one item leaves the others untouched
 *   • idempotency dedupe replays instead of re-writing
 *   • stamp mints uid/created/modified and adds no acceptance-status (#519), end-to-end on disk
 *   • the accept-forbidden guard rejects an item WITHOUT dispatching (no record)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ok } from "../src/mcp/helpers.ts";
import { makeGuarded, resolveGuardedPath } from "../src/mcp/guarded.ts";
import { Kernel, WriteQueue, WriteJournal, IdempotencyStore, LockStore, UidIndex } from "../src/kernel/index.ts";
import { makeRegistry, DEFAULT_SCHEMES } from "../src/kernel/scheme/registry.ts";
import { registerWriteNotesTool, batchItemWriter } from "../src/mcp/tools-write-notes.ts";
import { parseYaml } from "./obsidian-stub.mjs";
import { CHARACTER_LIMIT, WholeReads, wholeReadToken } from "@vault-mcp/core";

const ACTOR = { transport: "mcp", client: "claude-code/1.0.0", connection: "conn-1" };
const OPEN_SETTINGS = { readOnly: false, allowlist: [] };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const fakeYaml = (obj) => Object.entries(obj).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n";
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function fakeAdapter() {
  const files = new Map();
  const dirs = new Set();
  return {
    files,
    async exists(p) { return files.has(p) || dirs.has(p); },
    async mkdir(p) { dirs.add(p); },
    async write(p, d) { files.set(p, d); },
    async append(p, d) { files.set(p, (files.get(p) ?? "") + d); },
  };
}

/**
 * A harness: a real Kernel over a fake vault (path → {content, rev}) whose rev
 * is a monotonic clock bumped on each write, plus the guarded single-writer and
 * the registered obsidian_write_notes handler.
 *
 * `settings` (readOnly/allowlist), `uidSource` ({paths, uidOf}) and
 * `schemes`/`schemeNotes` are all optional so the SAME harness can pin the
 * plain-path behavior (nothing passed — byte-identical to before) and the
 * uid:/jd: address-form-independence + allowlist-ordering fixes (Findings 3
 * and 5), by wiring the identical resolveGuardedPath/guardedOpts server.ts
 * wires — not a reimplementation of resolution for the test's own sake.
 */
function harness({ existing = new Map(), settings = OPEN_SETTINGS, uidSource, schemes, schemeNotes, wholeReads, syncGuard } = {}) {
  const vault = new Map();        // path -> { content, rev }
  const existingFm = new Map();   // path -> parsed frontmatter (metadata cache stand-in)
  let clock = 100;
  for (const [path, { rev, content, frontmatter }] of existing) {
    vault.set(path, { content: content ?? "", rev });
    if (frontmatter) existingFm.set(path, frontmatter);
    clock = Math.max(clock, rev);
  }

  const writeCalls = [];
  function writeNote(path, content, overwrite) {
    writeCalls.push(path);
    const existed = vault.has(path);
    if (existed && !overwrite) throw new Error(`exists: ${path}`);
    clock += 1;
    vault.set(path, { content, rev: clock });
    return { path, created: !existed };
  }

  const probe = { uid: () => undefined, rev: (path) => vault.get(path)?.rev };
  const adapter = fakeAdapter();
  const journal = new WriteJournal(adapter, "dir/journal", () => new Date("2026-08-08T12:00:00Z"));
  const kernel = new Kernel(new WriteQueue(1000), journal, probe, new IdempotencyStore(), new LockStore());
  const uids = uidSource
    ? (() => {
        const index = new UidIndex(uidSource);
        index.rebuild();
        return index;
      })()
    : undefined;
  // The SAME opts object backs both `guarded` (guardedWrite's own dispatch)
  // and `resolveTarget` (tools-write-notes.ts's pre-compose resolve) — exactly
  // how server.ts wires guardedOpts, so a test that wires uid/scheme
  // addressing here is testing the real interception, not a stand-in for it.
  const guardedOpts = {
    getSettings: () => settings,
    kernel,
    actor: () => ACTOR,
    // The whole-note-overwrite rule (#441) reads the note's length here; the
    // proof of a whole read (#443) its memory and the note's stat.
    noteLength: async (path) => vault.get(path)?.content.length,
    ...(wholeReads ? { wholeReads, noteStat: (path) => (vault.has(path) ? { mtime: vault.get(path).rev, size: vault.get(path).content.length } : undefined) } : {}),
    ...(uids ? { uids } : {}),
    ...(schemes ? { schemes: () => schemes, schemeNotes: () => schemeNotes ?? [] } : {}),
    ...(syncGuard ? { syncGuard } : {}),
  };
  const guarded = makeGuarded(guardedOpts);
  const guardedWrite = guarded(
    { annotations: RW, inputSchema: {} },
    // The REAL per-item writer server.ts uses, over this harness's vault.
    batchItemWriter((path, content, overwrite) => writeNote(path, content, overwrite), (path) => vault.has(path)),
    "obsidian_write_notes"
  );

  let handler;
  registerWriteNotesTool((_name, _def, h) => { handler = h; }, guardedWrite, {
    resolveTarget: (path) => resolveGuardedPath(path, guardedOpts),
    readExistingFrontmatter: (path) => existingFm.get(path),
    revOf: (path) => vault.get(path)?.rev,
    stringifyYaml: fakeYaml,
    parseYaml,
    mintUid: (ms) => `uid-${ms}`,
    formatTs: (ms) => `TS(${ms})`,
    now: () => 42,
  });

  const records = () => (adapter.files.get("dir/journal/2026-08.jsonl") ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const call = (args) => handler(args, {});
  return { call, vault, records, writeCalls, kernel };
}

const structured = (res) => JSON.parse(res.content[0].text);

describe("obsidian_write_notes — batch happy path", () => {
  test("writes every item and journals one record per note", async () => {
    const { call, vault, records } = harness();
    const res = await call({
      notes: [
        { path: "Inbox/A.md", frontmatter: { name: "A" }, body: "aaa" },
        { path: "Inbox/B.md", frontmatter: { name: "B" }, body: "bbb" },
        { path: "Inbox/C.md", body: "ccc" },
      ],
      stamp: false,
    });
    const body = structured(res);
    assert.equal(body.count, 3);
    assert.equal(body.error_count, 0);
    assert.equal(res.isError, undefined);
    assert.deepEqual(body.written.map((w) => w.path), ["Inbox/A.md", "Inbox/B.md", "Inbox/C.md"]);
    for (const w of body.written) {
      assert.equal(w.created, true);
      assert.equal(typeof w.rev, "number", "each written item reports its post-write rev");
    }
    assert.equal(vault.get("Inbox/A.md").content, `---\nname: "A"\n---\naaa`);

    await tick();
    const recs = records();
    assert.equal(recs.length, 3, "each note gets its OWN journal record");
    assert.ok(recs.every((r) => r.op === "obsidian_write_notes"));
    assert.deepEqual(recs.map((r) => r.target.path).sort(), ["Inbox/A.md", "Inbox/B.md", "Inbox/C.md"]);
    assert.ok(recs.every((r) => r.outcome === "ok"));
  });
});

describe("obsidian_write_notes — a cut read is one item's refusal, by its own code (#441)", () => {
  test("the item is refused at the interception, before the queue; the other item writes", async () => {
    // The refusal is makeGuarded's own (cutReadError over the item's
    // `content`), not the writer's: the fake writer carries no guard.
    const { call, vault, records, writeCalls } = harness();
    const cut = "# Big\n\nxxx\n\n[truncated: note is 150000 chars, showing first 100000]";
    const res = await call({
      notes: [
        { path: "Inbox/Cut.md", body: cut },
        { path: "Inbox/OK.md", body: "ok" },
      ],
      stamp: false,
    });
    const body = structured(res);
    assert.equal(body.count, 1);
    assert.equal(body.error_count, 1);
    assert.equal(body.errors[0].path, "Inbox/Cut.md");
    assert.equal(body.errors[0].code, "truncated_read");
    assert.match(body.errors[0].error, /cut read/);
    assert.equal(vault.has("Inbox/Cut.md"), false, "nothing landed for the cut item");
    assert.equal(writeCalls.includes("Inbox/Cut.md"), false, "the writer was never reached for the cut item");
    assert.equal(vault.get("Inbox/OK.md").content, "ok");
    await tick();
    assert.equal(records().some((r) => r.target.path === "Inbox/Cut.md"), false, "a pre-queue refusal is not journaled");
  });
});

describe("obsidian_write_notes — a whole-note overwrite of a long note is one item's refusal, at dequeue (#441, #443)", () => {
  test("the item reports truncated_read from the guard at dequeue; the writer is never reached; the other item writes; the refusal is journaled", async () => {
    // The refusal is makeGuarded's own, decided inside the kernel's queued
    // closure (#443: after the idempotency claim and the if_rev check), not
    // the writer's: the fake writer carries no guard.
    const long = "# Long\n" + "x".repeat(CHARACTER_LIMIT + 5000);
    const { call, vault, records } = harness({ existing: new Map([["Inbox/Long.md", { rev: 500, content: long }]]) });
    const res = await call({
      notes: [
        { path: "Inbox/Long.md", body: "# Long (stripped)\n" + "x".repeat(1000), if_rev: 500 },
        { path: "Inbox/OK.md", body: "ok" },
      ],
      stamp: false,
    });
    const body = structured(res);
    assert.equal(body.error_count, 1);
    assert.equal(body.errors[0].path, "Inbox/Long.md");
    assert.equal(body.errors[0].code, "truncated_read");
    assert.match(body.errors[0].error, /never overwritten whole over MCP/);
    assert.equal(vault.get("Inbox/Long.md").content, long, "the long note is untouched");
    assert.equal(vault.get("Inbox/OK.md").content, "ok");
    await tick();
    const rec = records().find((r) => r.target.path === "Inbox/Long.md");
    assert.equal(rec?.outcome, "error", "decided at dequeue, so journaled");
  });

  test("an overwrite item with if_rev on a long note is refused by the rule, but without if_rev the protection refusal comes first", async () => {
    const long = "# Long\n" + "x".repeat(CHARACTER_LIMIT + 5000);
    const { call } = harness({ existing: new Map([["Inbox/Long.md", { rev: 500, content: long }]]) });
    // obsidian_write_notes marks an item without if_rev create-only; the
    // single-writer shape (overwrite without if_rev) is pinned through the
    // guarded writer directly, below, in truncated-read.test.mjs's host fixture.
    const res = await call({ notes: [{ path: "Inbox/Long.md", body: "# x", if_rev: 500 }], stamp: false });
    assert.equal(structured(res).errors[0].code, "truncated_read");
  });

  test("an item conditioned on a remembered whole read lands: the proof reaches the batch road (#443)", async () => {
    const long = "# Long\n" + "x".repeat(CHARACTER_LIMIT + 5000);
    const wholeReads = new WholeReads();
    wholeReads.remember("Inbox/Long.md", wholeReadToken(500, long.length));
    const { call, vault } = harness({ existing: new Map([["Inbox/Long.md", { rev: 500, content: long }]]), wholeReads });
    const res = await call({ notes: [{ path: "Inbox/Long.md", body: "# Long (rewritten whole)\n" + "y".repeat(CHARACTER_LIMIT + 10), if_rev: 500 }], stamp: false });
    const body = structured(res);
    assert.equal(body.error_count, 0, JSON.stringify(body.errors));
    assert.match(vault.get("Inbox/Long.md").content, /^# Long \(rewritten whole\)/);
  });

  test("a create-only item (no if_rev) on an existing long note is the protection refusal, not this rule", async () => {
    const long = "# Long\n" + "x".repeat(CHARACTER_LIMIT + 5000);
    const { call, vault } = harness({ existing: new Map([["Inbox/Long.md", { rev: 500, content: long }]]) });
    const res = await call({ notes: [{ path: "Inbox/Long.md", body: "# New" }], stamp: false });
    const body = structured(res);
    assert.equal(body.errors[0].code, "protection_required");
    assert.equal(vault.get("Inbox/Long.md").content, long);
  });
});

describe("obsidian_write_notes — if_rev conflict isolates to one item", () => {
  test("a stale if_rev fails only its item; the rest still write and journal", async () => {
    const existing = new Map([["Notes/X.md", { rev: 100, content: "old" }]]);
    const { call, vault, records } = harness({ existing });
    const res = await call({
      notes: [
        { path: "Notes/X.md", frontmatter: { name: "X" }, body: "new", if_rev: 999 }, // stale → conflict
        { path: "Notes/Y.md", frontmatter: { name: "Y" }, body: "yyy" },              // unaffected
      ],
      stamp: false,
    });
    const body = structured(res);
    assert.equal(body.count, 1);
    assert.equal(body.error_count, 1);
    assert.equal(body.errors[0].path, "Notes/X.md");
    assert.equal(body.errors[0].code, "rev_conflict");
    assert.equal(vault.get("Notes/X.md").content, "old", "the conflicting note must be untouched");
    assert.equal(body.written[0].path, "Notes/Y.md");
    assert.equal(vault.get("Notes/Y.md").content, `---\nname: "Y"\n---\nyyy`);

    await tick();
    const recs = records();
    const x = recs.find((r) => r.target.path === "Notes/X.md");
    const y = recs.find((r) => r.target.path === "Notes/Y.md");
    assert.equal(x.outcome, "conflict", "the stale item is journaled as a conflict");
    assert.equal(y.outcome, "ok");
  });
});

describe("obsidian_write_notes — idempotency dedupe", () => {
  test("a repeat call with the same key replays instead of writing again", async () => {
    const { call, vault, records, writeCalls } = harness();
    const item = { path: "Once/N.md", frontmatter: { name: "N" }, body: "v1", idempotency_key: "K1" };

    const first = structured(await call({ notes: [item], stamp: false }));
    assert.equal(first.count, 1);
    const revAfterFirst = vault.get("Once/N.md").rev;

    const second = structured(await call({ notes: [item], stamp: false }));
    assert.equal(second.count, 1, "the replay still reports success");
    assert.equal(vault.get("Once/N.md").rev, revAfterFirst, "the note must not be re-written");
    assert.equal(writeCalls.filter((p) => p === "Once/N.md").length, 1, "the underlying write ran exactly once");

    await tick();
    const recs = records();
    const deduped = recs.filter((r) => r.outcome === "deduped");
    assert.equal(deduped.length, 1, "the replay is journaled as deduped");
    assert.ok(deduped[0].dedupeOf, "the deduped record names the original it replayed");
  });
});

describe("obsidian_write_notes — stamp end-to-end", () => {
  test("stamp mints uid + created/modified, adds no acceptance-status (#519), and orders the block", async () => {
    const { call, vault, records } = harness();
    const res = await call({
      notes: [{ path: "Stamp/S.md", frontmatter: { name: "S" }, body: "hi" }],
      stamp: true,
    });
    const body = structured(res);
    assert.equal(body.count, 1);
    assert.equal(body.stamped, true);
    assert.equal(body.written[0].stamped, true);

    const content = vault.get("Stamp/S.md").content;
    // canonical order: name, uid, created, modified; no acceptance-status (#519)
    assert.match(content, /^---\nname: "S"\nuid: "uid-42"\ncreated: "TS\(42\)"\nmodified: "TS\(42\)"\n---\nhi$/);

    await tick();
    const recs = records();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].op, "obsidian_write_notes");
    assert.equal(recs[0].outcome, "ok");
  });

  test("#519: a stamped create WITHOUT frontmatter gets uid/created/modified and no acceptance-status", async () => {
    const { call, vault } = harness();
    const body = structured(await call({ notes: [{ path: "Stamp/Bare.md", body: "x" }], stamp: true }));
    assert.equal(body.count, 1);
    const content = vault.get("Stamp/Bare.md").content;
    assert.match(content, /^---\nuid: "uid-42"\ncreated: "TS\(42\)"\nmodified: "TS\(42\)"\n---\nx$/);
    assert.doesNotMatch(content, /acceptance-status/);
  });

  test("#519: a stamped create WITH frontmatter keeps the payload's keys and adds no acceptance-status", async () => {
    const { call, vault } = harness();
    await call({ notes: [{ path: "Stamp/Fm.md", frontmatter: { title: "T", tags: ["a"] }, body: "y" }], stamp: true });
    const content = vault.get("Stamp/Fm.md").content;
    assert.match(content, /title: "T"/);
    assert.match(content, /uid: "uid-42"/);
    assert.doesNotMatch(content, /acceptance-status/);
  });

  test("#519: the payload's own non-accepted acceptance-status is still written as given; accepted is still refused", async () => {
    const { call, vault } = harness();
    await call({ notes: [{ path: "Stamp/Own.md", frontmatter: { "acceptance-status": "draft" }, body: "z" }], stamp: true });
    assert.match(vault.get("Stamp/Own.md").content, /acceptance-status: "draft"/);
    const bad = structured(await call({ notes: [{ path: "Stamp/Bad.md", frontmatter: { "accepted-by": "me" }, body: "z" }], stamp: true }));
    assert.equal(bad.errors[0].code, "accept_forbidden");
  });

  test("stamp preserves an existing uid and acceptance-status (never overwritten)", async () => {
    const existing = new Map([
      ["Keep/K.md", { rev: 100, content: "old", frontmatter: { uid: "KEEP-UID", created: "2019-01-01T00:00:00", "acceptance-status": "accepted" } }],
    ]);
    const { call, vault } = harness({ existing });
    await call({ notes: [{ path: "Keep/K.md", frontmatter: { name: "K" }, body: "rewritten", if_rev: 100 }], stamp: true }); // an overwrite needs its token (01.33.5)
    const content = vault.get("Keep/K.md").content;
    assert.match(content, /uid: "KEEP-UID"/, "existing uid preserved");
    assert.match(content, /created: "2019-01-01T00:00:00"/, "existing created preserved");
    assert.match(content, /acceptance-status: "accepted"/, "existing acceptance-status preserved, not reset to proposed");
    assert.match(content, /modified: "TS\(42\)"/, "modified is refreshed to now");
  });

  // Finding 3 — before the fix, readExistingFrontmatter was keyed on the
  // caller's RAW `path` argument. For a uid:/jd:-addressed item that key is
  // never in the metadata cache (it is indexed by real path), so the lookup
  // silently missed: the stamped write treated an EXISTING note as new,
  // minted a fresh uid, reset `created`, and demoted `acceptance-status:
  // accepted` to `proposed`. tools-write-notes.ts now resolves the item's
  // path FIRST (WriteNotesDeps.resolveTarget, guarded.ts's
  // resolveGuardedPath) and keys the existing-frontmatter read — and the
  // guarded dispatch itself — on the RESOLVED path, so address form cannot
  // change what a stamped write preserves.
  test("uid:-addressed stamp preserves uid/created/acceptance — byte-identical to the same write by plain path", async () => {
    const path = "Keep/ByUid.md";
    const existing = new Map([
      [path, { rev: 100, content: "old", frontmatter: { uid: "KEEP-UID", created: "2019-01-01T00:00:00", "acceptance-status": "accepted" } }],
    ]);
    const uidSource = { paths: () => [path], uidOf: (p) => (p === path ? "KEEP-UID" : undefined) };

    const plain = harness({ existing, uidSource });
    await plain.call({ notes: [{ path, frontmatter: { name: "K" }, body: "rewritten", if_rev: 100 }], stamp: true });
    const plainContent = plain.vault.get(path).content;

    const byUid = harness({ existing, uidSource });
    const res = await byUid.call({ notes: [{ path: "uid:KEEP-UID", frontmatter: { name: "K" }, body: "rewritten", if_rev: 100 }], stamp: true });
    const byUidContent = byUid.vault.get(path).content;

    assert.equal(structured(res).error_count, 0);
    assert.equal(byUidContent, plainContent, "uid:-addressed stamped write is byte-identical to the plain-path write");
    assert.match(byUidContent, /uid: "KEEP-UID"/, "existing uid preserved, not re-minted");
    assert.match(byUidContent, /created: "2019-01-01T00:00:00"/, "existing created preserved, not reset");
    assert.match(byUidContent, /acceptance-status: "accepted"/, "existing acceptance-status preserved — no silent demotion to proposed");
    assert.equal(typeof structured(res).written[0].rev, "number", "rev is reported off the RESOLVED path too");
  });

  test("jd:-addressed stamp preserves uid/created/acceptance the same way", async () => {
    const path = "00-09 System/06 Agent tooling/06.11 Vault MCP.md";
    const existing = new Map([
      [path, { rev: 100, content: "old", frontmatter: { uid: "JD-UID", created: "2019-02-02T00:00:00", "acceptance-status": "accepted" } }],
    ]);
    const schemes = makeRegistry(DEFAULT_SCHEMES);
    const { call, vault } = harness({ existing, schemes, schemeNotes: [path] });
    const res = await call({ notes: [{ path: "jd:06.11", frontmatter: { name: "V" }, body: "rewritten", if_rev: 100 }], stamp: true });
    const content = vault.get(path).content;
    assert.equal(structured(res).error_count, 0);
    assert.match(content, /uid: "JD-UID"/, "existing uid preserved");
    assert.match(content, /created: "2019-02-02T00:00:00"/, "existing created preserved");
    assert.match(content, /acceptance-status: "accepted"/, "existing acceptance-status preserved — no silent demotion");
  });

  // Demotion rule (matches the shared accept-guard convention —
  // acceptTransitionReason, see write-notes-compose.ts): stamping's SILENT
  // default (payload omits acceptance-status) must PRESERVE an existing
  // accepted-family value — pinned above via uid:/jd: addressing, the exact
  // case the bug broke. An EXPLICIT, TYPED non-accepted value in the payload
  // is a different case — a caller's own content edit — and the shared rule
  // does not refuse it (only introducing/changing INTO the accepted family is
  // blocked); stamping honors it exactly like any other payload value.
  test("an EXPLICIT typed demotion in the payload is honored (matches the shared rule; not itself refused)", async () => {
    const existing = new Map([
      ["Keep/Typed.md", { rev: 100, content: "old", frontmatter: { uid: "T-UID", "acceptance-status": "accepted" } }],
    ]);
    const { call, vault } = harness({ existing });
    const res = await call({
      notes: [{ path: "Keep/Typed.md", frontmatter: { name: "T", "acceptance-status": "proposed" }, body: "edited", if_rev: 100 }],
      stamp: true,
    });
    assert.equal(structured(res).error_count, 0, "a typed, explicit non-accepted value is never refused");
    assert.match(vault.get("Keep/Typed.md").content, /acceptance-status: "proposed"/);
  });
});

describe("obsidian_write_notes — allowlist refusal runs before the accept-transition check (Finding 5)", () => {
  test("a hidden note's refusal is IDENTICAL whether or not the payload carries an acceptance-family field", async () => {
    const settings = { readOnly: false, allowlist: ["Visible"] };
    const clean = harness({ settings });
    const withAccept = harness({ settings });

    const resClean = await clean.call({
      notes: [{ path: "Hidden/Note.md", frontmatter: { name: "N" }, body: "x" }],
      stamp: true,
    });
    const resAccept = await withAccept.call({
      notes: [{ path: "Hidden/Note.md", frontmatter: { name: "N", "acceptance-status": "accepted" }, body: "x" }],
      stamp: true,
    });

    const bodyClean = structured(resClean);
    const bodyAccept = structured(resAccept);

    assert.equal(bodyClean.errors[0].code, "out_of_allowlist");
    assert.equal(
      bodyAccept.errors[0].code,
      "out_of_allowlist",
      "the allowlist refusal fires FIRST — never accept_forbidden for a note this session cannot see"
    );
    assert.equal(
      bodyAccept.errors[0].error,
      bodyClean.errors[0].error,
      "identical refusal text regardless of the payload's acceptance-family content — no error differential to probe with"
    );
    assert.doesNotMatch(bodyAccept.errors[0].error, /accept/i, "no accept-specific marker text leaks for a hidden note");

    // Neither item ever dispatched: no queue slot taken, no journal record.
    await tick();
    assert.equal(clean.writeCalls.length, 0);
    assert.equal(withAccept.writeCalls.length, 0);
    assert.equal(clean.records().length, 0);
    assert.equal(withAccept.records().length, 0);
  });

  test("read-only mode refuses before the accept-transition check too", async () => {
    const settings = { readOnly: true, allowlist: [] };
    const { call } = harness({ settings });
    const res = await call({
      notes: [{ path: "Anything.md", frontmatter: { "accepted-by": "nelson" }, body: "x" }],
      stamp: false,
    });
    const body = structured(res);
    assert.equal(body.errors[0].code, "read_only");
    assert.doesNotMatch(body.errors[0].error, /accept/i);
  });

  test("a VISIBLE note with an acceptance-family field still gets accept_forbidden, unaffected by the reordering", async () => {
    const settings = { readOnly: false, allowlist: ["Visible"] };
    const { call } = harness({ settings });
    const res = await call({
      notes: [{ path: "Visible/Bad.md", frontmatter: { "acceptance-status": "accepted" }, body: "x" }],
      stamp: false,
    });
    const body = structured(res);
    assert.equal(body.errors[0].code, "accept_forbidden");
  });
});

describe("obsidian_write_notes — accept-forbidden guard", () => {
  for (const [label, frontmatter] of [
    ["acceptance-status: accepted", { "acceptance-status": "accepted" }],
    ["accepted-by", { name: "N", "accepted-by": "nelson" }],
    ["accepted-on", { name: "N", "accepted-on": "2026-08-09" }],
  ]) {
    test(`rejects ${label} without dispatching, other items proceed`, async () => {
      const { call, vault, records, writeCalls } = harness();
      const res = await call({
        notes: [
          { path: "Bad/Reject.md", frontmatter, body: "x" },
          { path: "Good/Ok.md", frontmatter: { name: "OK" }, body: "y" },
        ],
        stamp: true,
      });
      const body = structured(res);
      assert.equal(body.error_count, 1);
      assert.equal(body.errors[0].path, "Bad/Reject.md");
      assert.equal(body.errors[0].code, "accept_forbidden");
      assert.equal(vault.has("Bad/Reject.md"), false, "a rejected item must never be written");
      assert.equal(writeCalls.includes("Bad/Reject.md"), false);
      assert.equal(body.count, 1);
      assert.equal(vault.has("Good/Ok.md"), true, "the clean item still writes");

      await tick();
      const recs = records();
      assert.equal(recs.some((r) => r.target.path === "Bad/Reject.md"), false, "a rejected item takes no journal record");
      assert.equal(recs.filter((r) => r.target.path === "Good/Ok.md").length, 1);
    });
  }

  test("rejects a body-injected accepted fence (S2) per-item; sibling proceeds", async () => {
    const { call, vault, writeCalls } = harness();
    const res = await call({
      notes: [
        { path: "Bad/Inject.md", body: "---\nacceptance-status: accepted\n---\nsneaky" },
        { path: "Good/Clean.md", frontmatter: { name: "C" }, body: "y" },
      ],
      stamp: false,
    });
    const body = structured(res);
    assert.equal(body.error_count, 1);
    assert.equal(body.errors[0].path, "Bad/Inject.md");
    assert.equal(body.errors[0].code, "accept_forbidden");
    assert.equal(writeCalls.includes("Bad/Inject.md"), false, "a rejected item never dispatches");
    assert.equal(body.count, 1);
    assert.equal(vault.has("Good/Clean.md"), true);
  });

  for (const [label, frontmatter] of [
    ["array value-type [accepted]", { "acceptance-status": ["accepted"] }],
    ["map value-type {value: accepted}", { "acceptance-status": { value: "accepted" } }],
  ]) {
    test(`rejects the ${label} form (S3)`, async () => {
      const { call } = harness();
      const res = await call({ notes: [{ path: "Bad/Type.md", frontmatter, body: "x" }], stamp: false });
      const body = structured(res);
      assert.equal(body.error_count, 1);
      assert.equal(body.errors[0].code, "accept_forbidden");
    });
  }

  test("ALLOWS preserving an existing accepted under stamp (no laundering block on a legitimate edit)", async () => {
    const existing = new Map([
      ["Keep/Acc.md", { rev: 100, content: "old", frontmatter: { "acceptance-status": "accepted" } }],
    ]);
    const { call, vault } = harness({ existing });
    const res = await call({ notes: [{ path: "Keep/Acc.md", frontmatter: { name: "A" }, body: "edited", if_rev: 100 }], stamp: true });
    const body = structured(res);
    assert.equal(body.error_count, 0, "carrying an existing accepted forward is allowed");
    assert.equal(body.count, 1);
    assert.match(vault.get("Keep/Acc.md").content, /acceptance-status: "accepted"/);
  });

  test("a total-failure batch carries the MCP error flag", async () => {
    const { call } = harness();
    const res = await call({
      notes: [{ path: "Bad/Only.md", frontmatter: { accepted: true }, body: "x" }],
      stamp: false,
    });
    assert.equal(res.isError, true);
    const body = structured(res);
    assert.equal(body.count, 0);
    assert.equal(body.error_count, 1);
    assert.equal(body.errors[0].code, "accept_forbidden");
  });
});

describe("obsidian_write_notes — B2 batch intent", () => {
  test("a batch-level intent lands on every per-item journal record", async () => {
    const { call, records } = harness();
    const res = await call({
      notes: [
        { path: "Inbox/A.md", frontmatter: { name: "A" }, body: "aaa" },
        { path: "Inbox/B.md", frontmatter: { name: "B" }, body: "bbb" },
      ],
      intent: "seed the inbox pair for the 03.12 migration",
    });
    assert.equal(structured(res).error_count, 0);
    await new Promise((r) => setTimeout(r, 10));
    const recs = records();
    assert.equal(recs.length, 2);
    for (const rec of recs) {
      assert.equal(rec.intent, "seed the inbox pair for the 03.12 migration");
    }
  });

  test("no intent — per-item records carry no intent field", async () => {
    const { call, records } = harness();
    await call({ notes: [{ path: "Inbox/C.md", frontmatter: { name: "C" }, body: "c" }] });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal("intent" in records()[0], false);
  });
});

describe("obsidian_write_notes — per item, as write_note (01.33.5)", () => {
  test("an item for an EXISTING note without if_rev is refused per item with the coded message; the batch goes on", async () => {
    const { call, vault } = harness({ existing: new Map([["E/Old.md", { rev: 500, content: "old" }]]) });
    const res = structured(await call({ notes: [{ path: "E/Old.md", body: "new" }, { path: "E/New.md", body: "fresh" }], stamp: false }));
    assert.equal(vault.get("E/Old.md").content, "old", "not overwritten without a token");
    const err = res.errors.find((e) => e.path === "E/Old.md");
    assert.equal(err.code, "protection_required");
    assert.match(err.error, /already exists, and this batch item carries no if_rev/);
    assert.match(err.error, /pass that value as the item's if_rev/);
    assert.ok(res.written.some((w) => w.path === "E/New.md" && w.created), "a new note is a create: exempt");
  });
  test("the same item WITH the note's if_rev overwrites it", async () => {
    const { call, vault } = harness({ existing: new Map([["E/Old.md", { rev: 500, content: "old" }]]) });
    const res = structured(await call({ notes: [{ path: "E/Old.md", body: "new", if_rev: 500 }], stamp: false }));
    assert.equal(res.count, 1);
    assert.match(vault.get("E/Old.md").content, /new/);
  });
  test("a keyed item refused as existing keeps that refusal under its key; the overwrite goes through with if_rev and a NEW key, as the message says", async () => {
    const { call, vault } = harness({ existing: new Map([["E/Old.md", { rev: 500, content: "old" }]]) });
    const first = structured(await call({ notes: [{ path: "E/Old.md", body: "new", idempotency_key: "K-old" }], stamp: false }));
    const err = first.errors.find((e) => e.path === "E/Old.md");
    assert.match(err.error, /give the overwrite a NEW one: that key now answers with this refusal/);
    const sameKey = structured(await call({ notes: [{ path: "E/Old.md", body: "new", if_rev: 500, idempotency_key: "K-old" }], stamp: false }));
    assert.equal(sameKey.errors.find((e) => e.path === "E/Old.md")?.code, "idempotency_mismatch", "the old key is spent on the refusal");
    assert.equal(vault.get("E/Old.md").content, "old");
    const newKey = structured(await call({ notes: [{ path: "E/Old.md", body: "new", if_rev: 500, idempotency_key: "K-old-2" }], stamp: false }));
    assert.equal(newKey.count, 1);
    assert.match(vault.get("E/Old.md").content, /new/);
  });
  test("a retry of a CREATE under the same key replays instead of being refused as an existing note", async () => {
    const { call, writeCalls } = harness();
    const item = { path: "E/Once.md", body: "v1", idempotency_key: "K-create" };
    assert.equal(structured(await call({ notes: [item], stamp: false })).count, 1);
    const again = structured(await call({ notes: [item], stamp: false }));
    assert.equal(again.count, 1, "the replay reports the first result");
    assert.deepEqual(again.errors, []);
    assert.equal(writeCalls.filter((p) => p === "E/Once.md").length, 1);
  });
});

// #507: the Sync guard's warning reaches the batch's caller, per item.
describe("obsidian_write_notes — the Sync guard's warning", () => {
  test("a content item written while Sync is behind carries sync_warning on its row; a refused create carries sync_behind", async () => {
    const existing = new Map([["Inbox/A.md", { content: "old", rev: 5 }]]);
    const { call } = harness({
      existing,
      syncGuard: async (_tool, args) =>
        args.create_only ? { refuse: { code: "sync_behind", message: "behind" } } : { warn: "Sync is behind", code: "sync_behind" },
    });
    const body = structured(
      await call({ notes: [{ path: "Inbox/A.md", body: "new", if_rev: 5, idempotency_key: "w1" }, { path: "Inbox/N.md", body: "n" }], stamp: false })
    );
    assert.equal(body.written.length, 1);
    assert.equal(body.written[0].sync_warning, "Sync is behind");
    assert.equal(body.errors[0].code, "sync_behind");
  });
});
