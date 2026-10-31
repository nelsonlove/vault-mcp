/**
 * addressed-as.test.mjs — journal audit-of-intent (issue #91): a mutating call
 * addressed by `uid:<value>` or `jd:<address>` records the ADDRESS FORM the
 * caller used, paired with what it resolved to, beside the resolved target.
 *
 * Load-bearing properties:
 *   • uid- and jd-addressed writes carry `addressedAs: [{ref, path}]`;
 *   • a call using both carries both, uid entries first (resolution order —
 *     the uid pass runs strictly before the scheme pass);
 *   • plain-path writes carry NO addressedAs field (byte-identical records);
 *   • a deduped terminal record keeps its own call's addressedAs (like
 *     `intent` — it documents this caller's ask, no dequeue check implied);
 *   • the list is capped like target.paths (MAX_JOURNALED_PATHS).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  Kernel,
  WriteQueue,
  WriteJournal,
  IdempotencyStore,
  LockStore,
  UidIndex,
} from "../src/kernel/index.ts";
import { makeGuarded } from "../src/mcp/guarded.ts";
import { makeRegistry } from "../src/kernel/scheme/registry.ts";
import { JD_SCHEMES } from "./scheme-fixture.mjs";

const ACTOR = { transport: "mcp", client: "claude-code/1.0.0", connection: "abc-1" };
const OPEN_SETTINGS = { readOnly: false, allowlist: [] };
const RW_DEF = { annotations: { readOnlyHint: false } };
const OK = async () => ({ content: [{ type: "text", text: "{}" }] });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function fakeSource(entries = {}) {
  return { paths: () => Object.keys(entries), uidOf: (p) => entries[p] };
}

function fakeAdapter() {
  const files = new Map();
  return {
    files,
    async exists(p) { return files.has(p); },
    async mkdir() {},
    async read(p) { return files.get(p) ?? ""; },
    async write(p, data) { files.set(p, data); },
    async append(p, data) { files.set(p, (files.get(p) ?? "") + data); },
  };
}

function kernelWith(index) {
  const adapter = fakeAdapter();
  const journal = new WriteJournal(adapter, "dir/journal", () => new Date("2026-08-10T12:00:00Z"));
  const kernel = new Kernel(
    new WriteQueue(1000),
    journal,
    { uid: () => undefined, rev: () => undefined },
    new IdempotencyStore(),
    new LockStore(),
    index,
  );
  const records = () =>
    (adapter.files.get("dir/journal/2026-08.jsonl") ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { kernel, records };
}

/** A guarded wrapper over a kernel + optional scheme registry, plus the vault
 * listing the scheme resolver sees. */
function guardedWith(kernel, index, notes = []) {
  return makeGuarded({
    getSettings: () => OPEN_SETTINGS,
    kernel,
    actor: () => ACTOR,
    uids: index,
    schemes: () => makeRegistry(JD_SCHEMES),
    schemeNotes: () => notes,
  });
}

describe("journal addressedAs (issue #91)", () => {
  test("a uid-addressed write records the ref and its resolution", async () => {
    const index = new UidIndex(fakeSource({ "Notes/A.md": "uid-a" }));
    index.rebuild();
    const { kernel, records } = kernelWith(index);
    const guarded = guardedWith(kernel, index);

    await guarded(RW_DEF, OK, "obsidian_write_note")({ path: "uid:uid-a", content: "hi" }, {});
    await tick();
    const [rec] = records();
    assert.deepEqual(rec.addressedAs, [{ ref: "uid:uid-a", path: "Notes/A.md" }]);
    assert.equal(rec.target.path, "Notes/A.md");
  });

  test("a jd-addressed write records the scheme ref and its resolution", async () => {
    const index = new UidIndex(fakeSource({}));
    index.rebuild();
    const { kernel, records } = kernelWith(index);
    const notes = ["00-09 System/06 Agent tooling/06.11 Something.md"];
    const guarded = guardedWith(kernel, index, notes);

    await guarded(RW_DEF, OK, "obsidian_write_note")({ path: "jd:06.11", content: "hi" }, {});
    await tick();
    const [rec] = records();
    assert.deepEqual(rec.addressedAs, [{ ref: "jd:06.11", path: notes[0] }]);
    assert.equal(rec.target.path, notes[0]);
  });

  test("uid and jd refs in one call both land, uid first", async () => {
    const index = new UidIndex(fakeSource({ "Notes/A.md": "uid-a" }));
    index.rebuild();
    const { kernel, records } = kernelWith(index);
    const notes = ["00-09 System/06 Agent tooling/06.11 Something.md"];
    const guarded = guardedWith(kernel, index, notes);

    await guarded(RW_DEF, OK, "obsidian_move_note")({ from: "uid:uid-a", to: "jd:06.11", idempotency_key: "k-move" }, {});
    await tick();
    const [rec] = records();
    assert.deepEqual(rec.addressedAs, [
      { ref: "uid:uid-a", path: "Notes/A.md" },
      { ref: "jd:06.11", path: notes[0] },
    ]);
  });

  test("a plain-path write carries NO addressedAs field", async () => {
    const index = new UidIndex(fakeSource({ "Notes/A.md": "uid-a" }));
    index.rebuild();
    const { kernel, records } = kernelWith(index);
    const guarded = guardedWith(kernel, index);

    await guarded(RW_DEF, OK, "obsidian_write_note")({ path: "Notes/A.md", content: "hi" }, {});
    await tick();
    assert.ok(!("addressedAs" in records()[0]), "plain-path records are byte-identical to before");
  });

  test("a deduped terminal record keeps its own call's addressedAs", async () => {
    const index = new UidIndex(fakeSource({ "Notes/A.md": "uid-a" }));
    index.rebuild();
    const { kernel, records } = kernelWith(index);
    const guarded = guardedWith(kernel, index);
    const call = () =>
      guarded(RW_DEF, OK, "obsidian_write_note")(
        { path: "uid:uid-a", content: "hi", idempotency_key: "k1" },
        {},
      );

    await call();
    await tick();
    await call();
    await tick();
    const recs = records();
    assert.equal(recs.length, 2);
    const deduped = recs.find((r) => r.outcome === "deduped");
    assert.ok(deduped, "second call dedupes");
    assert.deepEqual(deduped.addressedAs, [{ ref: "uid:uid-a", path: "Notes/A.md" }]);
  });

  test("the list is capped at MAX_JOURNALED_PATHS entries", async () => {
    const entries = {};
    for (let i = 0; i < 25; i++) entries[`Notes/N${i}.md`] = `uid-${i}`;
    const index = new UidIndex(fakeSource(entries));
    index.rebuild();
    const { kernel, records } = kernelWith(index);
    const guarded = guardedWith(kernel, index);

    const paths = Array.from({ length: 25 }, (_, i) => `uid:uid-${i}`);
    await guarded(RW_DEF, OK, "obsidian_read_notes_batchish")({ paths, content: "x" }, {});
    await tick();
    const [rec] = records();
    assert.equal(rec.addressedAs.length, 20);
  });
});
