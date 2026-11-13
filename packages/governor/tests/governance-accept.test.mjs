// The accept/revert primitives (#83, cycle 2). Since #599 Accept is baseline-advance only:
// it never edits the note, and writes none of the retired keys acceptance-status, accepted-by
// or accepted-on (Nelson's ruling of 2026-10-20). The conformance gate still refuses an
// under-filled `proposed` note before anything happens.
//
// These are the pure functions the pane's gesture-gated Accept/Revert buttons call —
// headless-testable because accept.ts imports nothing from Obsidian. The gesture GATE itself
// (a synthetic event does NOT reach these) is proven in governance-gesture.test.mjs and
// structurally in governance-module.test.mjs (the buttons are addEventListener-wired and
// gate on isRealGesture).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  acceptNote,
  revertNote,
  silentAdvanceRecord,
  AcceptGateError,
} from "../src/kernel/accept.ts";
import { computeQueue } from "../src/kernel/queue.ts";
import { makeFakeWorld } from "./governance-helpers.mjs";

const RETIRED_KEYS = ["acceptance-status", "accepted-by", "accepted-on"];
const frontmatterOf = (c) => (c.startsWith("---\n") ? c.slice(4, c.indexOf("\n---", 4)) : "");
const keysOf = (c) => frontmatterOf(c).split("\n").map((l) => /^([^:\s][^:]*):/.exec(l)?.[1]?.trim()).filter(Boolean);

describe("accept advances the baseline and edits nothing", () => {
  test("accept advances the baseline to current and logs (no stamped flag)", async () => {
    const w = makeFakeWorld({ "A.md": "current agent content" });
    w.seedBaseline("A.md", "old baseline");
    const res = await acceptNote(w.deps, "A.md");
    assert.equal("stamped" in res, false);
    assert.equal(w.baselines.get("A.md").content, "current agent content");
    assert.equal(w.baselines.get("A.md").acceptedBy, "test-human");
    assert.equal(w.log.length, 1);
    assert.equal(w.log[0].action, "accept");
    assert.equal(w.log[0].by, "test-human");
    assert.equal("stamped" in w.log[0], false, "the log record no longer carries a stamped flag");
  });

  test("an accept of a note in each status writes none of acceptance-status, accepted-by, accepted-on (#599)", async () => {
    const bodies = {
      proposed: "---\nuid: u-1\nacceptance-status: proposed\n---\nagent body",
      revising: "---\nacceptance-status: revising\n---\nrevised body",
      accepted: "---\nacceptance-status: accepted\naccepted-by: nelson\naccepted-on: 2026-08-01T09:00\n---\nedited",
      none: "---\ntitle: T\n---\nplain body",
      noFrontmatter: "plain body no frontmatter",
    };
    for (const [status, content] of Object.entries(bodies)) {
      const w = makeFakeWorld({ "A.md": content });
      w.seedBaseline("A.md", "old");
      await acceptNote(w.deps, "A.md");
      assert.equal(w.notes.get("A.md"), content, `a ${status} note must stay byte-untouched`);
      assert.equal(w.baselines.get("A.md").content, content, `the baseline advances over a ${status} note`);
      const before = keysOf(content);
      for (const k of RETIRED_KEYS) {
        assert.equal(keysOf(w.notes.get("A.md")).includes(k), before.includes(k), `${status}: ${k} must not be added or removed`);
      }
    }
  });

  test("an accepted proposed note stays acceptance-status: proposed and gains no accepted-by or accepted-on", async () => {
    const w = makeFakeWorld({ "A.md": "---\nuid: u-1\nacceptance-status: proposed\n---\nagent body" });
    w.seedBaseline("A.md", "old");
    await acceptNote(w.deps, "A.md");
    const keys = keysOf(w.notes.get("A.md"));
    assert.deepEqual(keys, ["uid", "acceptance-status"]);
    assert.match(w.notes.get("A.md"), /acceptance-status: proposed/);
  });

  test("the accept does not re-enter the pending queue (the baseline holds the exact current bytes)", async () => {
    const proposed = "---\nuid: u-1\nacceptance-status: proposed\n---\nagent body";
    const w = makeFakeWorld({ "A.md": proposed });
    w.seedBaseline("A.md", "---\nuid: u-1\nacceptance-status: proposed\n---\nold body");
    await acceptNote(w.deps, "A.md");
    const queue = computeQueue({
      notes: [{ path: "A.md", content: w.notes.get("A.md") }],
      getBaseline: (p) => w.baselines.get(p) ?? null,
      journal: [
        {
          ts: "2026-08-09T11:00:00.000Z",
          op: "obsidian_write_note",
          target: { path: "A.md" },
          actor: { transport: "mcp", client: "agent-x" },
          outcome: "ok",
        },
      ],
    });
    assert.deepEqual(queue, []);
  });

  test("setBaseline throws ⇒ the note is untouched, the baseline unchanged, nothing logged", async () => {
    const proposed = "---\nacceptance-status: proposed\n---\nbody";
    const w = makeFakeWorld({ "A.md": proposed });
    w.seedBaseline("A.md", "old");
    w.deps.store.setBaseline = async () => { throw new Error("store broke"); };
    await assert.rejects(() => acceptNote(w.deps, "A.md"), /store broke/);
    assert.equal(w.notes.get("A.md"), proposed);
    assert.equal(w.baselines.get("A.md").content, "old");
    assert.equal(w.log.length, 0);
  });
});

describe("the conformance gate (requiredFrontmatterKeys) — refuse means nothing happens", () => {
  const proposed = "---\nuid: u-1\ntitle: A note\nacceptance-status: proposed\n---\nbody";

  test("empty gate (the default) gates nothing — the accept proceeds", async () => {
    const w = makeFakeWorld({ "A.md": proposed });
    w.seedBaseline("A.md", "old");
    w.deps.requiredFrontmatterKeys = [];
    await acceptNote(w.deps, "A.md");
    assert.equal(w.baselines.get("A.md").content, proposed);
  });

  test("gate set + all keys present ⇒ accept proceeds", async () => {
    const w = makeFakeWorld({ "A.md": proposed });
    w.seedBaseline("A.md", "old");
    w.deps.requiredFrontmatterKeys = ["uid", "title"];
    await acceptNote(w.deps, "A.md");
    assert.equal(w.baselines.get("A.md").content, proposed);
  });

  test("gate set + a key missing ⇒ AcceptGateError, and NOTHING happened (no baseline, no log)", async () => {
    const w = makeFakeWorld({ "A.md": proposed });
    w.seedBaseline("A.md", "old");
    w.deps.requiredFrontmatterKeys = ["uid", "title", "description"];
    await assert.rejects(() => acceptNote(w.deps, "A.md"), (e) => {
      assert.ok(e instanceof AcceptGateError);
      assert.deepEqual(e.missing, ["description"]);
      assert.match(e.message, /description/);
      return true;
    });
    assert.equal(w.notes.get("A.md"), proposed, "note byte-untouched");
    assert.equal(w.baselines.get("A.md").content, "old", "baseline NOT advanced");
    assert.equal(w.log.length, 0, "nothing logged — nothing happened");
  });

  test("a present-but-EMPTY key counts as missing", async () => {
    const w = makeFakeWorld({ "A.md": "---\nuid:\nacceptance-status: proposed\n---\nbody" });
    w.seedBaseline("A.md", "old");
    w.deps.requiredFrontmatterKeys = ["uid"];
    await assert.rejects(() => acceptNote(w.deps, "A.md"), AcceptGateError);
    assert.equal(w.baselines.get("A.md").content, "old");
  });

  test("the gate applies ONLY to proposed notes — a no-status note accepts despite the gate", async () => {
    const w = makeFakeWorld({ "A.md": "---\ntitle: T\n---\nbody" });
    w.seedBaseline("A.md", "old");
    w.deps.requiredFrontmatterKeys = ["uid", "description"];
    await acceptNote(w.deps, "A.md");
    assert.equal(w.baselines.get("A.md").content, "---\ntitle: T\n---\nbody");
  });
});

describe("revert (unchanged by the convergence)", () => {
  test("revert restores baseline content and quarantines the rejected version — never deletes", async () => {
    const w = makeFakeWorld({ "A.md": "rejected agent content" });
    w.seedBaseline("A.md", "the good baseline");
    const res = await revertNote(w.deps, "A.md");
    assert.equal(w.notes.get("A.md"), "the good baseline");
    assert.equal(w.quarantines.size, 1);
    assert.equal([...w.quarantines.values()][0], "rejected agent content");
    assert.equal(res.quarantine, [...w.quarantines.keys()][0]);
    assert.equal(w.log[0].action, "revert");
    assert.equal(w.log[0].quarantine, res.quarantine);
  });

  test("revert throws (does nothing destructive) when there is no baseline", async () => {
    const w = makeFakeWorld({ "A.md": "content" });
    await assert.rejects(() => revertNote(w.deps, "A.md"), /no baseline/);
    assert.equal(w.quarantines.size, 0);
    assert.equal(w.notes.get("A.md"), "content");
  });
});

// D2 — silent baseline advances (the human-edit reconcile path) must be auditable.
test("silentAdvanceRecord builds the audit record for a silent baseline advance", () => {
  const rec = silentAdvanceRecord({
    ts: "2026-08-09T12:00:00.000Z",
    path: "Notes/A.md",
    reason: "human-edit",
    fromHash: "oldhash",
    toHash: "newhash",
  });
  assert.deepEqual(rec, {
    event: "silent-advance",
    ts: "2026-08-09T12:00:00.000Z",
    path: "Notes/A.md",
    reason: "human-edit",
    fromHash: "oldhash",
    toHash: "newhash",
  });
});

test("silentAdvanceRecord records fromHash=null when there was no prior baseline", () => {
  const rec = silentAdvanceRecord({
    ts: "2026-08-09T12:00:00.000Z",
    path: "New.md",
    reason: "human-edit",
    fromHash: null,
    toHash: "h1",
  });
  assert.equal(rec.event, "silent-advance");
  assert.equal(rec.fromHash, null);
  assert.equal(rec.toHash, "h1");
});
