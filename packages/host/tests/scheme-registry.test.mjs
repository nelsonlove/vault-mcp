/**
 * scheme-registry.test.mjs — Task 3 of the scope-provider module: the
 * SchemeRegistry (multiple named scheme instances, each a provider + merged
 * config) and ref parsing ("jd:06.11" -> {instance, addr}), which the address
 * tools use. The `jd:` path syntax itself is retired; see
 * scheme-ref-retired.test.mjs.
 *
 * The NOTES fixture mirrors scheme-jd-scopes.test.mjs's Task-2 listing.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  makeRegistry,
  DEFAULT_SCHEMES,
  SchemeRegistry,
  SchemeUnavailableError,
} from "../src/kernel/scheme/registry.js";
import { DEFAULT_JD_CONFIG } from "../src/kernel/scheme/jd.js";
import { JD_SCHEMES } from "./scheme-fixture.mjs";

const NOTES = [
  "00-09 System/00.00 Index.md",
  "00-09 System/06 Agent tooling/06.00 JDex.md",
  "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
  "00-09 System/06 Agent tooling/06.12 Bridge.md",
  "00-09 System/06 Agent tooling/scratch no address.md",
  "90-99 Projects/92021 Big thing/92021.10 Sub.md",
  "Unfiled/loose.md",
];

// ── makeRegistry / instances / get ──────────────────────────────────────────

describe("makeRegistry — building instances from config", () => {
  test("the default config registers no scheme (schemes are opt-in)", () => {
    assert.deepEqual(DEFAULT_SCHEMES, []);
    const reg = makeRegistry(DEFAULT_SCHEMES);
    assert.equal(reg.instances().length, 0);
    assert.equal(reg.parseRef("jd:06.11"), null, "with no scheme, jd:06.11 parses as no ref");
  });

  test("a plain jd row registers one 'jd' instance backed by the JD provider", () => {
    const reg = makeRegistry([{ id: "jd", provider: "johnny-decimal" }]);
    const instances = reg.instances();
    assert.equal(instances.length, 1);
    assert.equal(instances[0].id, "jd");
    assert.equal(instances[0].providerName, "johnny-decimal");
    assert.equal(typeof instances[0].provider.parse, "function");
  });

  test("get(id) returns the matching instance", () => {
    const reg = makeRegistry(JD_SCHEMES);
    const inst = reg.get("jd");
    assert.ok(inst);
    assert.equal(inst.id, "jd");
  });

  test("get(id) returns null for an unregistered id", () => {
    const reg = makeRegistry(JD_SCHEMES);
    assert.equal(reg.get("nope"), null);
  });

  test("an unknown provider name in a config is skipped (console.error), not thrown", () => {
    const originalError = console.error;
    let called = false;
    console.error = () => {
      called = true;
    };
    let reg;
    try {
      reg = makeRegistry([{ id: "bogus", provider: "not-a-real-provider" }]);
    } finally {
      console.error = originalError;
    }
    assert.equal(reg.instances().length, 0);
    assert.equal(reg.get("bogus"), null);
    assert.ok(called, "expected console.error to be called for the bad config entry");
  });

  test("prototype-key provider names (__proto__, constructor, toString, hasOwnProperty, valueOf) are skipped, not thrown", () => {
    const PROTOTYPE_KEYS = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];
    for (const provider of PROTOTYPE_KEYS) {
      const originalError = console.error;
      let called = false;
      console.error = () => {
        called = true;
      };
      let reg;
      try {
        reg = makeRegistry([{ id: "bogus", provider }]);
      } finally {
        console.error = originalError;
      }
      assert.equal(reg.instances().length, 0, `provider "${provider}" should register 0 instances`);
      assert.equal(reg.get("bogus"), null, `provider "${provider}" should not be gettable`);
      assert.ok(called, `expected console.error to be called for provider "${provider}"`);
    }
  });

  // ── Item 5: duplicate scheme ids — FIRST wins, later duplicates skipped ────

  test("a duplicate scheme id: the FIRST entry wins, later duplicates are skipped with console.error naming the id", () => {
    const originalError = console.error;
    const messages = [];
    console.error = (msg) => messages.push(msg);
    let reg;
    try {
      reg = makeRegistry([
        { id: "jd", provider: "johnny-decimal", config: { contentDecimalFloor: 5 } },
        { id: "jd", provider: "johnny-decimal", config: { contentDecimalFloor: 50 } },
      ]);
    } finally {
      console.error = originalError;
    }
    assert.equal(reg.instances().length, 1);
    const inst = reg.get("jd");
    const notes = ["00-09 System/06 Agent tooling/06.00 JDex.md"];
    const next = inst.provider.nextFree({ kind: "category", token: "06" }, notes);
    // FIRST entry's config (floor 5) wins, not the second (floor 50).
    assert.equal(inst.provider.format(next), "06.05");
    assert.equal(messages.length, 1);
    assert.match(messages[0], /"jd"/);
    assert.match(messages[0], /duplicate/i);
  });

  test("three entries sharing one id: only the first registers, the other two are each reported", () => {
    const originalError = console.error;
    const messages = [];
    console.error = (msg) => messages.push(msg);
    let reg;
    try {
      reg = makeRegistry([
        { id: "jd", provider: "johnny-decimal", config: { contentDecimalFloor: 1 } },
        { id: "jd", provider: "johnny-decimal", config: { contentDecimalFloor: 2 } },
        { id: "jd", provider: "johnny-decimal", config: { contentDecimalFloor: 3 } },
      ]);
    } finally {
      console.error = originalError;
    }
    assert.equal(reg.instances().length, 1);
    assert.equal(reg.get("jd").provider.parse === undefined, false);
    assert.equal(messages.length, 2, "two later duplicates should each be reported");
  });

  // ── worker-1 review follow-up: a row skipped for unknown-provider/invalid-config
  // must still RESERVE its id, so a later same-id row can't silently become
  // "the" instance as if the first row had never claimed that id ────────────

  test("a first row skipped for an unknown provider still reserves its id — a later same-id row does NOT silently register", () => {
    const originalError = console.error;
    const messages = [];
    console.error = (msg) => messages.push(msg);
    let reg;
    try {
      reg = makeRegistry([
        { id: "jd", provider: "bogus" },
        { id: "jd", provider: "johnny-decimal" },
      ]);
    } finally {
      console.error = originalError;
    }
    // Neither row produces a live "jd" instance: the first is skipped for an
    // unknown provider, and the second is skipped as a duplicate of an id
    // already spoken for — even though the row that spoke for it never
    // itself registered.
    assert.equal(reg.instances().length, 0);
    assert.equal(reg.get("jd"), null);
    assert.equal(messages.length, 2, "both the unknown-provider row and the duplicate row should be reported");
    assert.match(messages[0], /unknown provider/i);
    assert.match(messages[1], /duplicate/i);
  });

  test("a first row skipped for an invalid config still reserves its id — a later same-id row does NOT silently register", () => {
    const originalError = console.error;
    const messages = [];
    console.error = (msg) => messages.push(msg);
    let reg;
    try {
      reg = makeRegistry([
        { id: "jd", provider: "johnny-decimal", config: { contentDecimalFloor: 100 } },
        { id: "jd", provider: "johnny-decimal" },
      ]);
    } finally {
      console.error = originalError;
    }
    assert.equal(reg.instances().length, 0);
    assert.equal(reg.get("jd"), null);
    assert.equal(messages.length, 2);
    assert.match(messages[0], /invalid config/i);
    assert.match(messages[1], /duplicate/i);
  });

  test("a duplicate id does not prevent a DIFFERENT id alongside it from registering", () => {
    const originalError = console.error;
    console.error = () => {};
    let reg;
    try {
      reg = makeRegistry([
        { id: "jd", provider: "johnny-decimal" },
        { id: "jd", provider: "johnny-decimal", config: { contentDecimalFloor: 5 } },
        { id: "jd2", provider: "johnny-decimal" },
      ]);
    } finally {
      console.error = originalError;
    }
    assert.equal(reg.instances().length, 2);
    assert.deepEqual(reg.instances().map((i) => i.id).sort(), ["jd", "jd2"]);
  });

  test("a bad config entry does not prevent good entries alongside it from registering", () => {
    const originalError = console.error;
    console.error = () => {};
    let reg;
    try {
      reg = makeRegistry([
        { id: "bogus", provider: "not-a-real-provider" },
        { id: "jd", provider: "johnny-decimal" },
      ]);
    } finally {
      console.error = originalError;
    }
    assert.equal(reg.instances().length, 1);
    assert.equal(reg.instances()[0].id, "jd");
  });

  test("per-instance config deep-merges over provider defaults at the key level", () => {
    // Overriding only expandedCategories must leave expandedAreas at its
    // provider default (none) — not clobber the whole config object. The
    // expansions here are made up.
    const reg = makeRegistry([{ id: "jd", provider: "johnny-decimal", config: { expandedCategories: ["34", "41"] } }]);
    const inst = reg.get("jd");
    // 41001 is only an expanded-item because expandedCategories includes "41".
    assert.equal(inst.provider.parse("41001")?.kind, "expanded-item");
    // No area is expanded: the provider default stands for the key the config left out.
    assert.equal(inst.provider.parse("52021"), null);
  });

  // ── Task 5: registry-from-settings ──────────────────────────────────────────

  test("DEFAULT_JD_CONFIG expands nothing; a row's config adds expansions over it", () => {
    assert.deepEqual(DEFAULT_JD_CONFIG.expandedAreas, []);
    assert.deepEqual(DEFAULT_JD_CONFIG.expandedCategories, []);
    const plain = makeRegistry([{ id: "jd", provider: "johnny-decimal" }]).get("jd");
    // With no config, a 5-digit token is not an address at all.
    assert.equal(plain.provider.parse("52021"), null);
    assert.equal(plain.provider.parse("34001"), null);
    // Plain JD still works.
    assert.equal(plain.provider.parse("06.11")?.kind, "id");
    const expanded = makeRegistry([{ id: "jd", provider: "johnny-decimal", config: { expandedAreas: ["50-59"], expandedCategories: ["34"] } }]).get("jd");
    assert.equal(expanded.provider.parse("52021")?.kind, "expanded-item");
    assert.equal(expanded.provider.parse("34001")?.kind, "expanded-item");
  });

  // ── Amendment 2: flexible user config, validated by the provider ───────────

  test("an invalid config (expandedAreas as a string, not an array) is skipped with console.error, not thrown", () => {
    const originalError = console.error;
    const messages = [];
    console.error = (msg) => messages.push(msg);
    let reg;
    try {
      reg = makeRegistry([{ id: "jd", provider: "johnny-decimal", config: { expandedAreas: "90-99" } }]);
    } finally {
      console.error = originalError;
    }
    assert.equal(reg.instances().length, 0);
    assert.equal(reg.get("jd"), null);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /expandedAreas must be an array of strings/);
  });

  test("an invalid contentDecimalFloor (out of range) is skipped with console.error listing the problem", () => {
    const originalError = console.error;
    const messages = [];
    console.error = (msg) => messages.push(msg);
    let reg;
    try {
      reg = makeRegistry([{ id: "jd", provider: "johnny-decimal", config: { contentDecimalFloor: 100 } }]);
    } finally {
      console.error = originalError;
    }
    assert.equal(reg.instances().length, 0);
    assert.match(messages[0], /contentDecimalFloor must be an integer between 0 and 99/);
  });

  test("a valid contentDecimalFloor override changes nextFree's plain-category allocation (floor 5 -> 06.05)", () => {
    const reg = makeRegistry([{ id: "jd", provider: "johnny-decimal", config: { contentDecimalFloor: 5 } }]);
    const inst = reg.get("jd");
    const notes = ["00-09 System/06 Agent tooling/06.00 JDex.md"];
    const next = inst.provider.nextFree({ kind: "category", token: "06" }, notes);
    assert.equal(inst.provider.format(next), "06.05");
  });

  test("contentDecimalFloor absent from config preserves default behavior (-> 06.10)", () => {
    const reg = makeRegistry(JD_SCHEMES);
    const inst = reg.get("jd");
    const notes = ["00-09 System/06 Agent tooling/06.00 JDex.md"];
    const next = inst.provider.nextFree({ kind: "category", token: "06" }, notes);
    assert.equal(inst.provider.format(next), "06.10");
  });
});

// ── parseRef ─────────────────────────────────────────────────────────────────

describe("parseRef — 'scheme:address' -> {instance, addr} | null", () => {
  const reg = makeRegistry(JD_SCHEMES);

  test("a well-formed ref against a registered scheme parses", () => {
    const parsed = reg.parseRef("jd:06.11");
    assert.ok(parsed);
    assert.equal(parsed.instance.id, "jd");
    assert.equal(parsed.addr.kind, "id");
    assert.equal(reg.get("jd").provider.format(parsed.addr), "06.11");
  });

  test("'uid:...' is reserved and always returns null, even though it matches the ref shape", () => {
    assert.equal(reg.parseRef("uid:abc"), null);
  });

  test("an ordinary path containing a colon (not scheme-shaped) returns null", () => {
    // Starts with an uppercase letter / contains a slash before the colon —
    // does not match the scheme-id grammar at all.
    assert.equal(reg.parseRef("Notes/a:b.md"), null);
  });

  test("a colon-prefixed id that isn't registered returns null", () => {
    assert.equal(reg.parseRef("nope:06.11"), null);
  });

  test("a registered scheme id with an unparseable address returns null", () => {
    assert.equal(reg.parseRef("jd:not-a-jd-id"), null);
  });

  test("a plain path with no colon at all returns null", () => {
    assert.equal(reg.parseRef("Unfiled/loose.md"), null);
  });
});

// ── resolve ──────────────────────────────────────────────────────────────────

describe("resolve — canonical-form address equality against a notes listing", () => {
  const reg = makeRegistry(JD_SCHEMES);
  const jd = reg.get("jd");

  test("resolves to the single matching path", () => {
    const addr = jd.provider.parse("06.11");
    assert.deepEqual(reg.resolve(jd, addr, NOTES), ["00-09 System/06 Agent tooling/06.11 Vault MCP.md"]);
  });

  test("an address with no matching note resolves to an empty list", () => {
    const addr = jd.provider.parse("99.99");
    assert.deepEqual(reg.resolve(jd, addr, NOTES), []);
  });

  test("two notes sharing the same address both come back, in listing order", () => {
    const notes = ["00-09 System/06 Agent tooling/06.11 First.md", "00-09 System/06 Agent tooling/06.11 Second.md"];
    const addr = jd.provider.parse("06.11");
    assert.deepEqual(reg.resolve(jd, addr, notes), notes);
  });
});

// ── skipped() / parseRefDetailed / SchemeUnavailableError — issue #88 ──────────
//
// Typed refusal for a tool call naming a SKIPPED instance (configured but no
// live instance — unknown provider, invalid config, invalid excludedRoots, or
// a duplicate id with no live row of its own). Settings-tab surfacing of the
// same information landed in #74 (the console.error lines makeRegistry
// already emits); this is the remaining half — the registry retains the
// skipped ids so a CALL naming one gets a typed refusal instead of reading as
// an ordinary, never-registered id.

describe("SchemeRegistry.skipped() — ids configured but with no live instance", () => {
  test("an unknown provider skip is retained in skipped()", () => {
    const originalError = console.error;
    console.error = () => {};
    let reg;
    try {
      reg = makeRegistry([{ id: "bogus", provider: "not-a-real-provider" }]);
    } finally {
      console.error = originalError;
    }
    assert.ok(reg.skipped().has("bogus"));
    assert.ok(reg.skipped().get("bogus").length > 0);
  });

  test("an invalid-config skip is retained in skipped()", () => {
    const originalError = console.error;
    console.error = () => {};
    let reg;
    try {
      reg = makeRegistry([{ id: "jd", provider: "johnny-decimal", config: { contentDecimalFloor: 100 } }]);
    } finally {
      console.error = originalError;
    }
    assert.ok(reg.skipped().has("jd"));
    assert.match(reg.skipped().get("jd").join(";"), /contentDecimalFloor/);
  });

  test("an invalid-excludedRoots skip is retained in skipped(), naming the bad entry", () => {
    const originalError = console.error;
    console.error = () => {};
    let reg;
    try {
      reg = makeRegistry([{ id: "jd", provider: "johnny-decimal", excludedRoots: ["/DISTINCTIVE-MARKER-ROOT"] }]);
    } finally {
      console.error = originalError;
    }
    assert.ok(reg.skipped().has("jd"));
    assert.match(reg.skipped().get("jd").join(";"), /DISTINCTIVE-MARKER-ROOT/);
  });

  test("a duplicate id with NO live instance (first row itself skipped) is retained in skipped()", () => {
    const originalError = console.error;
    console.error = () => {};
    let reg;
    try {
      reg = makeRegistry([
        { id: "jd", provider: "bogus" },
        { id: "jd", provider: "johnny-decimal" },
      ]);
    } finally {
      console.error = originalError;
    }
    assert.equal(reg.get("jd"), null);
    assert.ok(reg.skipped().has("jd"), "no live instance claims the id — it must read as skipped");
  });

  test("a duplicate id that DOES have a live instance is NOT in skipped() — the live instance serves, nothing to refuse", () => {
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
    assert.ok(reg.get("jd"), "sanity: the first row did register");
    assert.equal(reg.skipped().has("jd"), false, "a live instance already serves this id — not a refusal case");
  });

  test("an id never mentioned in any config is absent from skipped() too (distinct from 'skipped')", () => {
    const reg = makeRegistry(JD_SCHEMES);
    assert.equal(reg.skipped().has("never-configured"), false);
  });

  test("a registry built directly (bypassing makeRegistry) has an empty skipped() map", () => {
    const reg = new SchemeRegistry([]);
    assert.equal(reg.skipped().size, 0);
  });
});

describe("parseRefDetailed — distinguishes resolved / skipped / none", () => {
  test("a well-formed ref against a registered scheme is 'resolved'", () => {
    const reg = makeRegistry(JD_SCHEMES);
    const detailed = reg.parseRefDetailed("jd:06.11");
    assert.equal(detailed.kind, "resolved");
    assert.equal(detailed.instance.id, "jd");
  });

  test("a ref naming a SKIPPED id is 'skipped', carrying the id and its problems", () => {
    const originalError = console.error;
    console.error = () => {};
    let reg;
    try {
      reg = makeRegistry([{ id: "jd", provider: "not-a-real-provider" }]);
    } finally {
      console.error = originalError;
    }
    const detailed = reg.parseRefDetailed("jd:06.11");
    assert.equal(detailed.kind, "skipped");
    assert.equal(detailed.id, "jd");
    assert.ok(detailed.problems.length > 0);
  });

  test("a ref naming a skipped id still returns null from parseRef (backward-compatible)", () => {
    const originalError = console.error;
    console.error = () => {};
    let reg;
    try {
      reg = makeRegistry([{ id: "jd", provider: "not-a-real-provider" }]);
    } finally {
      console.error = originalError;
    }
    assert.equal(reg.parseRef("jd:06.11"), null);
  });

  test("an unregistered, never-skipped id is 'none'", () => {
    const reg = makeRegistry(JD_SCHEMES);
    assert.deepEqual(reg.parseRefDetailed("nope:06.11"), { kind: "none" });
  });

  test("a plain path with no colon is 'none'", () => {
    const reg = makeRegistry(JD_SCHEMES);
    assert.deepEqual(reg.parseRefDetailed("Unfiled/loose.md"), { kind: "none" });
  });

  test("a filename containing a colon that isn't scheme-shaped is 'none' (pinned: must keep passing through as an ordinary path)", () => {
    const reg = makeRegistry(JD_SCHEMES);
    assert.deepEqual(reg.parseRefDetailed("Notes/a:b.md"), { kind: "none" });
  });

  test("'uid:...' is reserved and always 'none', even against a skipped 'uid' id (which can't happen, but the reserved check runs first)", () => {
    const reg = makeRegistry(JD_SCHEMES);
    assert.deepEqual(reg.parseRefDetailed("uid:abc"), { kind: "none" });
  });
});

describe("SchemeUnavailableError — names only the id, never the problem strings", () => {
  test("code is 'scheme_unavailable' and the message names the id", () => {
    const err = new SchemeUnavailableError("jd");
    assert.equal(err.code, "scheme_unavailable");
    assert.match(err.message, /"jd"/);
  });

  test("the message never echoes a problem string, even one with a distinctive marker naming vault territory", () => {
    const originalError = console.error;
    console.error = () => {};
    let reg;
    try {
      reg = makeRegistry([{ id: "jd", provider: "johnny-decimal", excludedRoots: ["/DISTINCTIVE-MARKER-ROOT"] }]);
    } finally {
      console.error = originalError;
    }
    // Sanity: the marker really is in the recorded problem.
    assert.match(reg.skipped().get("jd").join(";"), /DISTINCTIVE-MARKER-ROOT/);
    const err = new SchemeUnavailableError("jd");
    assert.equal(err.message.includes("DISTINCTIVE-MARKER-ROOT"), false, "problem text must never reach the refusal message");
  });
});
