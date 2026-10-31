/**
 * scheme-addressing.test.mjs — Task 7 of the scope-provider module:
 * `jd:<address>` universal addressing at the guard interception point.
 *
 * The uid-addressing analog (tests/uid-index.test.mjs's "uid references" and
 * "uid addressing through the guarded wrapper" sections) is the precedent
 * this mirrors — same shape, same properties, same disclosure guarantees:
 *
 *   • resolveSchemeArgs   — `<scheme-id>:<address>` rewriting at the guarded
 *                           wrapper, defined over the guard's own path walker
 *   • makeGuarded         — the interception point: uid resolution runs
 *                           first, scheme resolution second, both before
 *                           guardCall, both refusing before the handler runs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  makeRegistry,
  AddressUnresolvedError,
  AddressAmbiguousError,
  SchemeUnavailableError,
  resolveSchemeArgs,
} from "../src/kernel/scheme/registry.ts";
import { JD_SCHEMES } from "./scheme-fixture.mjs";
import { UidIndex } from "../src/kernel/index.ts";
import { makeGuarded, addressSafe } from "../src/mcp/guarded.ts";

// ── fixtures ──────────────────────────────────────────────────────────────────

const ACTOR = { transport: "mcp", client: "claude-code/1.0.0", connection: "abc-1" };
const RW_DEF = { annotations: { readOnlyHint: false } };
const RO_DEF = { annotations: { readOnlyHint: true } };
const OPEN_SETTINGS = { readOnly: false, allowlist: [] };

// Mirrors scheme-registry.test.mjs's own NOTES fixture, so "jd:06.11" resolves
// the same way here as it does at the registry-unit level.
const NOTES = [
  "00-09 System/00.00 Index.md",
  "00-09 System/06 Agent tooling/06.00 JDex.md",
  "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
  "00-09 System/06 Agent tooling/06.12 Bridge.md",
  "00-09 System/06 Agent tooling/scratch no address.md",
  "90-99 Projects/92021 Big thing/92021.10 Sub.md",
  "Unfiled/loose.md",
];
const VAULT_MCP_PATH = "00-09 System/06 Agent tooling/06.11 Vault MCP.md";

function handlerHarness() {
  const seen = [];
  const handler = async (args) => {
    seen.push(args);
    return { content: [{ type: "text", text: "{}" }] };
  };
  return { seen, handler };
}

/** A guarded() wrapper with a fresh jd registry wired the way server.ts wires
 * it — schemes()/schemeNotes() resolved per call, notes() call-counted so
 * laziness ("only when a scheme-shaped value is actually encountered") is
 * pinned, not just assumed. */
function harness({ allowlist = [], notes = NOTES, withSchemes = true } = {}) {
  const registry = makeRegistry(JD_SCHEMES);
  let notesCalls = 0;
  const schemeNotes = () => {
    notesCalls++;
    return notes;
  };
  const { seen, handler } = handlerHarness();
  const opts = {
    getSettings: () => ({ readOnly: false, allowlist }),
    actor: () => ACTOR,
    ...(withSchemes ? { schemes: () => registry, schemeNotes } : {}),
  };
  const guarded = makeGuarded(opts);
  return { registry, guarded, seen, handler, notesCallCount: () => notesCalls };
}

// ── resolveSchemeArgs — the uid-addressing-analog unit tests ──────────────────

describe("resolveSchemeArgs", () => {
  test("jd:06.11 rewrites to the real path and reports what it resolved", () => {
    const reg = makeRegistry(JD_SCHEMES);
    const { args, resolved } = resolveSchemeArgs({ path: "jd:06.11", overwrite: true }, reg, () => NOTES);
    assert.deepEqual(args, { path: VAULT_MCP_PATH, overwrite: true });
    assert.deepEqual(resolved, [{ ref: "jd:06.11", path: VAULT_MCP_PATH }]);
  });

  test("a call using no scheme addressing is handed back its own args, untouched, SAME object", () => {
    const reg = makeRegistry(JD_SCHEMES);
    const args = { path: "Notes/Ordinary.md", content: "x" };
    const out = resolveSchemeArgs(args, reg, () => NOTES);
    assert.equal(out.args, args, "behavior is unchanged when scheme addressing is unused");
    assert.deepEqual(out.resolved, []);
  });

  test('"Notes/a:b.md" — a colon that is not a registered scheme id — is untouched too', () => {
    const reg = makeRegistry(JD_SCHEMES);
    const args = { path: "Notes/a:b.md" };
    const out = resolveSchemeArgs(args, reg, () => NOTES);
    assert.equal(out.args, args);
    assert.deepEqual(out.resolved, []);
  });

  test("without a registry, a scheme-shaped value is left untouched — never guessed at, never enumerated", () => {
    const args = { path: "jd:06.11" };
    const out = resolveSchemeArgs(args, null, () => {
      throw new Error("notes() must not be called when there is no registry to resolve against");
    });
    assert.equal(out.args, args);
    assert.deepEqual(out.resolved, []);
  });

  test("notes() is called LAZILY — only once a scheme-shaped value is actually encountered", () => {
    const reg = makeRegistry(JD_SCHEMES);
    let calls = 0;
    const notesFn = () => {
      calls++;
      return NOTES;
    };
    resolveSchemeArgs({ path: "Notes/Ordinary.md" }, reg, notesFn);
    assert.equal(calls, 0, "an ordinary call must not enumerate the vault");
    resolveSchemeArgs({ path: "jd:06.11" }, reg, notesFn);
    assert.equal(calls, 1);
  });

  // Fix-round item (IMPORTANT 2): visiblePaths(notes(), settings) used to run
  // INSIDE the per-value mapPaths callback, so a K-address batch enumerated and
  // allowlist-filtered the whole vault K times. It is now computed at most once
  // per resolveSchemeArgs call, on the first scheme-shaped value, and reused
  // for the rest of the walk.
  test("notes() is memoized per call — several scheme-shaped values enumerate the vault ONCE, not once per value", () => {
    const reg = makeRegistry(JD_SCHEMES);
    let calls = 0;
    const notesFn = () => {
      calls++;
      return NOTES;
    };
    const { args } = resolveSchemeArgs(
      { paths: ["jd:06.11", "jd:06.12", "jd:92021.10"] },
      reg,
      notesFn
    );
    assert.equal(calls, 1, "one listing serves every scheme-shaped value in the call, not one per value");
    assert.deepEqual(args, {
      paths: [
        VAULT_MCP_PATH,
        "00-09 System/06 Agent tooling/06.12 Bridge.md",
        "90-99 Projects/92021 Big thing/92021.10 Sub.md",
      ],
    });
  });

  test("an unknown address throws AddressUnresolvedError", () => {
    const reg = makeRegistry(JD_SCHEMES);
    assert.throws(
      () => resolveSchemeArgs({ path: "jd:99.99" }, reg, () => NOTES),
      (e) => e instanceof AddressUnresolvedError && e.code === "address_unresolved"
    );
  });

  test("two claimants throws AddressAmbiguousError naming both", () => {
    const reg = makeRegistry(JD_SCHEMES);
    const dupNotes = [
      "00-09 System/06 Agent tooling/06.11 First.md",
      "00-09 System/06 Agent tooling/06.11 Second.md",
    ];
    assert.throws(
      () => resolveSchemeArgs({ path: "jd:06.11" }, reg, () => dupNotes),
      (e) => {
        assert.ok(e instanceof AddressAmbiguousError);
        assert.equal(e.code, "address_ambiguous");
        assert.deepEqual(e.candidates, dupNotes);
        return true;
      }
    );
  });

  // Fix-round item (MINOR b): the message caps how many candidates it NAMES at
  // 10, matching UidAmbiguousError's MAX_LISTED_PATHS convention in
  // uid-index.ts — the candidates are already allowlist-visible-only by this
  // point, so this bounds wire size, not disclosure. `.candidates` itself stays
  // the full list (a caller that wants all of them still can).
  test("more than 10 claimants caps the NAMED candidates in the message, but not the .candidates array", () => {
    const reg = makeRegistry(JD_SCHEMES);
    const dupNotes = Array.from(
      { length: 12 },
      (_, i) => `00-09 System/06 Agent tooling/06.11 Dup${i}.md`
    );
    assert.throws(
      () => resolveSchemeArgs({ path: "jd:06.11" }, reg, () => dupNotes),
      (e) => {
        assert.ok(e instanceof AddressAmbiguousError);
        assert.equal(e.candidates.length, 12, "the full candidate list is preserved on the error object");
        const named = dupNotes.slice(0, 10).every((p) => e.message.includes(p));
        assert.ok(named, "the first 10 candidates are named in the message");
        assert.equal(e.message.includes(dupNotes[11]), false, "the 12th is not spelled out");
        assert.match(e.message, /\+2 more/);
        return true;
      }
    );
  });

  test("resolution is scoped to the allowlist-VISIBLE notes only", () => {
    const reg = makeRegistry(JD_SCHEMES);
    const settings = { readOnly: false, allowlist: ["90-99 Projects"] };
    // "jd:06.11" is real, but hidden by the allowlist — 0 visible candidates.
    assert.throws(
      () => resolveSchemeArgs({ path: "jd:06.11" }, reg, () => NOTES, settings),
      AddressUnresolvedError
    );
    // "jd:92021.10" IS inside the allowlist — resolves normally.
    const { args } = resolveSchemeArgs({ path: "jd:92021.10" }, reg, () => NOTES, settings);
    assert.equal(args.path, "90-99 Projects/92021 Big thing/92021.10 Sub.md");
  });

  // ── issue #88: a ref naming a SKIPPED instance is a typed refusal ──────────

  test("a ref naming a SKIPPED id throws SchemeUnavailableError, coded 'scheme_unavailable', naming only the id", () => {
    const originalError = console.error;
    console.error = () => {};
    let reg;
    try {
      reg = makeRegistry([{ id: "jd", provider: "not-a-real-provider" }]);
    } finally {
      console.error = originalError;
    }
    assert.throws(
      () => resolveSchemeArgs({ path: "jd:06.11" }, reg, () => NOTES),
      (e) => {
        assert.ok(e instanceof SchemeUnavailableError);
        assert.equal(e.code, "scheme_unavailable");
        assert.match(e.message, /"jd"/);
        return true;
      }
    );
  });

  test("a duplicate id that DOES have a live instance is NOT refused — the live instance serves", () => {
    const originalError = console.error;
    console.error = () => {};
    let reg;
    try {
      reg = makeRegistry([
        { id: "jd", provider: "johnny-decimal" },
        { id: "jd", provider: "johnny-decimal", config: { contentDecimalFloor: 5 } },
      ]);
    } finally {
      console.error = originalError;
    }
    const { args } = resolveSchemeArgs({ path: "jd:06.11" }, reg, () => NOTES);
    assert.equal(args.path, VAULT_MCP_PATH, "resolves normally against the FIRST (winning) row's provider");
  });
});

// ── addressSafe — fold-back, tested directly ───────────────────────────────────
//
// Fix-round item (IMPORTANT 1): resolution is allowlist-VISIBLE-only, so a
// resolved path can never be the one path guardCall's own refusal message
// names (it was visible, so it was allowed) — the end-to-end disclosure tests
// above therefore cannot exercise addressSafe's folding loop itself; they only
// prove the OUTCOME (nothing leaks). These test the fold-back directly,
// independent of whether any given guardCall message shape currently happens
// to route a resolved path through it.

describe("addressSafe — fold-back, tested directly", () => {
  test("folds a resolved uid back to its uid: form", () => {
    const out = addressSafe(
      "path 'Notes/A.md' is outside the vault-mcp allowlist",
      [{ uid: "uid-a", path: "Notes/A.md" }]
    );
    assert.equal(out, "path 'uid:uid-a' is outside the vault-mcp allowlist");
  });

  test("folds a resolved scheme address back to its jd: form", () => {
    const out = addressSafe(
      "path 'Notes/A.md' is outside the vault-mcp allowlist",
      [],
      [{ ref: "jd:06.11", path: "Notes/A.md" }]
    );
    assert.equal(out, "path 'jd:06.11' is outside the vault-mcp allowlist");
  });

  test("folds a uid pair AND a scheme pair in the SAME message, one pass", () => {
    const out = addressSafe(
      "moved 'Notes/A.md' over 'Notes/B.md'",
      [{ uid: "uid-a", path: "Notes/A.md" }],
      [{ ref: "jd:06.11", path: "Notes/B.md" }]
    );
    assert.equal(out, "moved 'uid:uid-a' over 'jd:06.11'");
  });

  test("a message naming neither resolved path is left untouched", () => {
    const out = addressSafe(
      "path 'Elsewhere.md' is outside the vault-mcp allowlist",
      [{ uid: "uid-a", path: "Notes/A.md" }],
      [{ ref: "jd:06.11", path: "Notes/B.md" }]
    );
    assert.equal(out, "path 'Elsewhere.md' is outside the vault-mcp allowlist");
  });

  test("the scheme list defaults to empty — uid-only calls are unaffected", () => {
    const out = addressSafe("path 'Notes/A.md' is outside the vault-mcp allowlist", [
      { uid: "uid-a", path: "Notes/A.md" },
    ]);
    assert.equal(out, "path 'uid:uid-a' is outside the vault-mcp allowlist");
  });
});

// ── scheme addressing through the guarded wrapper ──────────────────────────────

describe("scheme addressing through the guarded wrapper", () => {
  test("jd:06.11 reaches the handler as the real path (write)", async () => {
    const { guarded, seen, handler } = harness();
    const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "jd:06.11", content: "hi" }, {});
    assert.equal(res.isError, undefined);
    assert.deepEqual(seen, [{ path: VAULT_MCP_PATH, content: "hi" }], "handlers never see a scheme reference");
  });

  test("jd:06.11 reaches the handler as the real path (read) — the same interception point covers both", async () => {
    const { guarded, seen, handler } = harness();
    const res = await guarded(RO_DEF, handler, "obsidian_read_note")({ path: "jd:06.11" }, {});
    assert.equal(res.isError, undefined);
    assert.deepEqual(seen, [{ path: VAULT_MCP_PATH }]);
  });

  test("an unknown address is a typed error, and the handler never runs", async () => {
    const { guarded, seen, handler } = harness();
    const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "jd:99.99", content: "x" }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[address_unresolved\]/);
    assert.deepEqual(seen, [], "nothing was written");
  });

  test("two claimants is a typed error naming both, and nothing runs", async () => {
    const dupNotes = [
      "00-09 System/06 Agent tooling/06.11 First.md",
      "00-09 System/06 Agent tooling/06.11 Second.md",
    ];
    const { guarded, seen, handler } = harness({ notes: dupNotes });
    const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "jd:06.11", content: "x" }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[address_ambiguous\]/);
    assert.match(res.content[0].text, /06\.11 First\.md/);
    assert.match(res.content[0].text, /06\.11 Second\.md/);
    assert.deepEqual(seen, []);
  });

  test("an allowlisted session addressing a hidden note's address gets address_unresolved, never out_of_allowlist — no existence oracle", async () => {
    const { guarded, seen, handler } = harness({ allowlist: ["90-99 Projects"], notes: NOTES });
    const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "jd:06.11", content: "x" }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[address_unresolved\]/);
    assert.deepEqual(seen, [], "nothing ran");
  });

  // NOTE: resolution is allowlist-VISIBLE-only (see "resolution is scoped to
  // the allowlist-VISIBLE notes only" above), so the resolved "from" here is
  // ALREADY inside the allowlist and can never itself be the path guardCall
  // blocks on — the disclosure control is that visibility gate, not this
  // end-to-end refusal text. addressSafe's own folding behavior is unit-tested
  // directly, below ("addressSafe — fold-back, tested directly"); this test
  // pins the outcome an allowlisted caller actually sees: nothing about the
  // resolved address's real path leaks into a refusal triggered by a DIFFERENT
  // argument in the same call.
  test("an allowlist refusal on a different argument never discloses a resolved scheme address's real path", async () => {
    const { guarded, seen, handler } = harness({ allowlist: ["00-09 System"], notes: NOTES });
    const res = await guarded(RW_DEF, handler, "obsidian_move_note")(
      { from: "jd:06.11", to: "Secret/Elsewhere.md" },
      {}
    );
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[out_of_allowlist\]/);
    assert.equal(
      res.content[0].text.includes(VAULT_MCP_PATH),
      false,
      "no resolved path leaks into the refusal text"
    );
    assert.deepEqual(seen, []);
  });

  test('"Notes/a:b.md" — a colon that is not a registered scheme id — passes through untouched', async () => {
    const { guarded, seen, handler } = harness();
    const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "Notes/a:b.md", content: "x" }, {});
    assert.equal(res.isError, undefined);
    assert.deepEqual(seen, [{ path: "Notes/a:b.md", content: "x" }]);
  });

  test("opts without `schemes` never attempts resolution — jd:06.11 passes through as a literal path, byte-identical", async () => {
    const { guarded, seen, handler } = harness({ withSchemes: false });
    const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "jd:06.11", content: "x" }, {});
    assert.equal(res.isError, undefined);
    assert.deepEqual(
      seen,
      [{ path: "jd:06.11", content: "x" }],
      "no schemes opt => scheme resolution is skipped entirely and args pass through byte-identical"
    );
  });

  test("schemeNotes is never called when no scheme-shaped value is present", async () => {
    const { guarded, handler, notesCallCount } = harness();
    await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "Notes/Ordinary.md", content: "x" }, {});
    assert.equal(notesCallCount(), 0);
  });

  test("schemeNotes is called once a scheme-shaped value is encountered", async () => {
    const { guarded, handler, notesCallCount } = harness();
    await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "jd:06.11", content: "x" }, {});
    assert.equal(notesCallCount(), 1);
  });

  // ── issue #88: a ref naming a SKIPPED instance is a typed refusal, and the
  // handler never runs — same contract as address_unresolved/address_ambiguous
  // above, at the same interception point ────────────────────────────────────

  test("a ref naming a skipped scheme id is a typed scheme_unavailable refusal, and the handler never runs", async () => {
    const originalError = console.error;
    console.error = () => {};
    let registry;
    try {
      registry = makeRegistry([{ id: "jd", provider: "not-a-real-provider" }]);
    } finally {
      console.error = originalError;
    }
    const { seen, handler } = handlerHarness();
    const guarded = makeGuarded({
      getSettings: () => ({ readOnly: false, allowlist: [] }),
      actor: () => ACTOR,
      schemes: () => registry,
      schemeNotes: () => NOTES,
    });
    const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "jd:06.11", content: "x" }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[scheme_unavailable\]/);
    assert.match(res.content[0].text, /"jd"/);
    assert.deepEqual(seen, [], "nothing ran");
  });

  test("the scheme_unavailable refusal never echoes the underlying problem text, even one naming vault territory", async () => {
    const originalError = console.error;
    console.error = () => {};
    let registry;
    try {
      registry = makeRegistry([{ id: "jd", provider: "johnny-decimal", excludedRoots: ["/DISTINCTIVE-MARKER-ROOT"] }]);
    } finally {
      console.error = originalError;
    }
    const { seen, handler } = handlerHarness();
    const guarded = makeGuarded({
      getSettings: () => ({ readOnly: false, allowlist: [] }),
      actor: () => ACTOR,
      schemes: () => registry,
      schemeNotes: () => NOTES,
    });
    const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "jd:06.11", content: "x" }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[scheme_unavailable\]/);
    assert.equal(res.content[0].text.includes("DISTINCTIVE-MARKER-ROOT"), false, "problem text must never leak into the refusal");
    assert.deepEqual(seen, []);
  });

  test("a duplicate id WITH a live instance is not refused through the guarded wrapper either — the live instance serves", async () => {
    const originalError = console.error;
    console.error = () => {};
    let registry;
    try {
      registry = makeRegistry([
        { id: "jd", provider: "johnny-decimal" },
        { id: "jd", provider: "johnny-decimal", config: { contentDecimalFloor: 5 } },
      ]);
    } finally {
      console.error = originalError;
    }
    const { seen, handler } = handlerHarness();
    const guarded = makeGuarded({
      getSettings: () => ({ readOnly: false, allowlist: [] }),
      actor: () => ACTOR,
      schemes: () => registry,
      schemeNotes: () => NOTES,
    });
    const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "jd:06.11", content: "x" }, {});
    assert.equal(res.isError, undefined);
    assert.deepEqual(seen, [{ path: VAULT_MCP_PATH, content: "x" }]);
  });

  test("an unregistered scheme id (never configured, not skipped either) still passes through as an ordinary path", async () => {
    const { guarded, seen, handler } = harness();
    const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "nope:06.11", content: "x" }, {});
    assert.equal(res.isError, undefined);
    assert.deepEqual(seen, [{ path: "nope:06.11", content: "x" }]);
  });
});

// ── uid addressing and scheme addressing combined ──────────────────────────────

describe("uid: is reserved and resolved first — no regression when both addressing forms are wired", () => {
  function combinedHarness() {
    const src = { paths: () => ["Notes/A.md"], uidOf: (p) => (p === "Notes/A.md" ? "uid-a" : undefined) };
    const index = new UidIndex(src);
    index.rebuild();
    const registry = makeRegistry(JD_SCHEMES);
    const { seen, handler } = handlerHarness();
    const guarded = makeGuarded({
      getSettings: () => OPEN_SETTINGS,
      uids: index,
      actor: () => ACTOR,
      schemes: () => registry,
      schemeNotes: () => NOTES,
    });
    return { guarded, seen, handler };
  }

  test("a uid: reference still resolves via the uid path when a scheme registry is also wired", async () => {
    const { guarded, seen, handler } = combinedHarness();
    const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "uid:uid-a", content: "hi" }, {});
    assert.equal(res.isError, undefined);
    assert.deepEqual(seen, [{ path: "Notes/A.md", content: "hi" }]);
  });

  test("one call can address one side by uid and the other by scheme address", async () => {
    const { guarded, seen, handler } = combinedHarness();
    const res = await guarded(RW_DEF, handler, "obsidian_move_note")({ from: "uid:uid-a", to: "jd:92021.10" }, {});
    assert.equal(res.isError, undefined);
    assert.deepEqual(seen, [{ from: "Notes/A.md", to: "90-99 Projects/92021 Big thing/92021.10 Sub.md" }]);
  });
});
