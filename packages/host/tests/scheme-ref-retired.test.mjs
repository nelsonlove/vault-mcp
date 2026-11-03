/**
 * scheme-ref-retired.test.mjs — the `<scheme-id>:<address>` path syntax
 * (`jd:06.11`) is retired (Nelson, 2026-10-30: "retire em"). At the guard's
 * interception point a path argument that starts with a CONFIGURED scheme id
 * and a colon is refused with `scheme_ref_retired` on every road (read, write,
 * patch, append, move, trash, the batch writer), before the handler runs; it
 * is never read as a plain path. `uid:` is untouched. The file-system server's
 * half is packages/server/src/__tests__/fs-files.test.ts.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makeRegistry, refuseSchemeRefs, SchemeRefRetiredError } from "../src/kernel/scheme/registry.ts";
import { JD_SCHEMES } from "./scheme-fixture.mjs";
import { UidIndex } from "../src/kernel/index.ts";
import { makeGuarded, addressSafe, resolveGuardedPath } from "../src/mcp/guarded.ts";

const ACTOR = { transport: "mcp", client: "claude-code/1.0.0", connection: "abc-1" };
const RW_DEF = { annotations: { readOnlyHint: false } };
const RO_DEF = { annotations: { readOnlyHint: true } };

function handlerHarness() {
  const seen = [];
  const handler = async (args) => {
    seen.push(args);
    return { content: [{ type: "text", text: "{}" }] };
  };
  return { seen, handler };
}

/** A guarded() wrapper wired the way server.ts wires it: a jd registry per
 * call, and a uid index holding one note. */
function harness({ registry = makeRegistry(JD_SCHEMES), withSchemes = true } = {}) {
  const src = { paths: () => ["Notes/A.md"], uidOf: (p) => (p === "Notes/A.md" ? "uid-a" : undefined) };
  const index = new UidIndex(src);
  index.rebuild();
  const { seen, handler } = handlerHarness();
  const opts = {
    getSettings: () => ({ readOnly: false, allowlist: [] }),
    actor: () => ACTOR,
    uids: index,
    ...(withSchemes ? { schemes: () => registry } : {}),
  };
  return { guarded: makeGuarded(opts), opts, seen, handler };
}

function quietRegistry(rows) {
  const originalError = console.error;
  console.error = () => {};
  try {
    return makeRegistry(rows);
  } finally {
    console.error = originalError;
  }
}

const RETIRED = /^Error \[scheme_ref_retired\]: "jd:06\.11" uses the scheme-address path syntax \("jd:<address>"\), which is retired; name the note by a vault-relative path or a uid:<value> ref$/;

// ── every road ────────────────────────────────────────────────────────────────

const ROADS = [
  ["read", RO_DEF, "obsidian_read_note", { path: "jd:06.11" }],
  ["write", RW_DEF, "obsidian_write_note", { path: "jd:06.11", content: "x" }],
  ["patch", RW_DEF, "obsidian_patch_note", { path: "jd:06.11", anchor: { type: "heading", value: "H" }, op: "append", content: "x" }],
  ["append", RW_DEF, "obsidian_append_note", { path: "jd:06.11", content: "x", idempotency_key: "k" }],
  ["move (from)", RW_DEF, "obsidian_move_note", { from: "jd:06.11", to: "Notes/B.md" }],
  ["move (to)", RW_DEF, "obsidian_move_note", { from: "uid:uid-a", to: "jd:06.11" }],
  ["trash", RW_DEF, "obsidian_trash", { path: "jd:06.11" }],
  ["batch read", RO_DEF, "obsidian_read_notes", { paths: ["Notes/A.md", "jd:06.11"] }],
];

describe("a jd: ref is refused on every road, and the handler never runs", () => {
  for (const [road, def, tool, args] of ROADS) {
    test(road, async () => {
      const { guarded, seen, handler } = harness();
      const res = await guarded(def, handler, tool)(args, {});
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, RETIRED);
      assert.deepEqual(seen, [], "nothing ran");
    });
  }

  test("the batch writer's per-item resolution (obsidian_write_notes) refuses it too", () => {
    const { opts } = harness();
    const out = resolveGuardedPath("jd:06.11", opts);
    assert.deepEqual(Object.keys(out), ["blocked"]);
    assert.equal(out.blocked.code, "scheme_ref_retired");
  });

  test("a ref whose address does not parse is still refused — the prefix decides, never the address", async () => {
    const { guarded, seen, handler } = harness();
    for (const path of ["jd:not-an-address", "jd:", "jd:99.99"]) {
      const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path, content: "x" }, {});
      assert.match(res.content[0].text, /^Error \[scheme_ref_retired\]/, path);
    }
    assert.deepEqual(seen, []);
  });

  test("a ref naming a SKIPPED id (configured, no live instance) is refused the same way", async () => {
    const registry = quietRegistry([{ id: "jd", provider: "not-a-real-provider" }]);
    const { guarded, seen, handler } = harness({ registry });
    const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "jd:06.11", content: "x" }, {});
    assert.match(res.content[0].text, RETIRED);
    assert.deepEqual(seen, []);
  });

  test("any configured id is refused, not only jd", async () => {
    const registry = makeRegistry([{ id: "area-codes", provider: "johnny-decimal" }]);
    const { guarded, seen, handler } = harness({ registry });
    const res = await guarded(RO_DEF, handler, "obsidian_read_note")({ path: "area-codes:06.11" }, {});
    assert.match(res.content[0].text, /^Error \[scheme_ref_retired\]: "area-codes:06\.11"/);
    assert.deepEqual(seen, []);
  });
});

// ── what is not refused ───────────────────────────────────────────────────────

describe("what the refusal leaves alone", () => {
  test("uid: still resolves to the real path, on a read and a write", async () => {
    const { guarded, seen, handler } = harness();
    let res = await guarded(RO_DEF, handler, "obsidian_read_note")({ path: "uid:uid-a" }, {});
    assert.equal(res.isError, undefined);
    res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "uid:uid-a", content: "hi" }, {});
    assert.equal(res.isError, undefined);
    assert.deepEqual(seen, [{ path: "Notes/A.md" }, { path: "Notes/A.md", content: "hi" }]);
  });

  test("a colon after an id that is not configured is an ordinary path", async () => {
    const { guarded, seen, handler } = harness();
    for (const path of ["nope:06.11", "Notes/a:b.md"]) {
      const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path, content: "x" }, {});
      assert.equal(res.isError, undefined, path);
    }
    assert.deepEqual(seen, [{ path: "nope:06.11", content: "x" }, { path: "Notes/a:b.md", content: "x" }]);
  });

  test("with no scheme configured, nothing is refused (a fresh install)", async () => {
    const { guarded, seen, handler } = harness({ registry: makeRegistry([]) });
    const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "jd:06.11", content: "x" }, {});
    assert.equal(res.isError, undefined);
    assert.deepEqual(seen, [{ path: "jd:06.11", content: "x" }]);
  });

  test("opts without `schemes` refuse nothing", async () => {
    const { guarded, seen, handler } = harness({ withSchemes: false });
    await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "jd:06.11", content: "x" }, {});
    assert.deepEqual(seen, [{ path: "jd:06.11", content: "x" }]);
  });

  test("frontmatter is note data, never walked: a jd: value inside it is not refused", async () => {
    const { guarded, seen, handler } = harness();
    const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "Notes/C.md", frontmatter: { path: "jd:06.11" }, content: "x" }, {});
    assert.equal(res.isError, undefined);
    assert.equal(seen.length, 1);
  });
});

// ── the core helper ───────────────────────────────────────────────────────────

describe("refuseSchemeRefs", () => {
  const reg = makeRegistry(JD_SCHEMES);

  test("throws SchemeRefRetiredError naming the ref and the id", () => {
    assert.throws(
      () => refuseSchemeRefs({ moves: [{ from: "Notes/A.md", to: "jd:06.11" }] }, reg),
      (e) => e instanceof SchemeRefRetiredError && e.code === "scheme_ref_retired" && e.ref === "jd:06.11" && e.id === "jd",
    );
  });

  test("the alternatives named in the message are the caller's to choose", () => {
    assert.throws(() => refuseSchemeRefs({ path: "jd:06.11" }, reg, "a vault-relative path"), /name the note by a vault-relative path$/);
  });

  test("a null registry, uid:, and an unconfigured id refuse nothing", () => {
    refuseSchemeRefs({ path: "jd:06.11" }, null);
    refuseSchemeRefs({ path: "uid:abc" }, reg);
    refuseSchemeRefs({ path: "nope:1" }, reg);
  });

  test("refId: configured live or skipped ids only, uid reserved", () => {
    const mixed = quietRegistry([{ id: "jd", provider: "johnny-decimal" }, { id: "gone", provider: "not-a-real-provider" }]);
    assert.equal(mixed.refId("jd:06.11"), "jd");
    assert.equal(mixed.refId("gone:1"), "gone");
    assert.equal(mixed.refId("uid:abc"), null);
    assert.equal(mixed.refId("nope:1"), null);
    assert.equal(mixed.refId("Notes/a:b.md"), null);
  });
});

// ── addressSafe — fold-back, tested directly ───────────────────────────────────

describe("addressSafe — fold-back, tested directly", () => {
  test("folds a resolved uid back to its uid: form", () => {
    const out = addressSafe("path 'Notes/A.md' is outside the vault-mcp allowlist", [{ uid: "uid-a", path: "Notes/A.md" }]);
    assert.equal(out, "path 'uid:uid-a' is outside the vault-mcp allowlist");
  });

  test("a message naming no resolved path is left untouched", () => {
    const out = addressSafe("path 'Elsewhere.md' is outside the vault-mcp allowlist", [{ uid: "uid-a", path: "Notes/A.md" }]);
    assert.equal(out, "path 'Elsewhere.md' is outside the vault-mcp allowlist");
  });
});
