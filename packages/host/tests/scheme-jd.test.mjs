/**
 * scheme-jd.test.mjs — Task 1 of the scope-provider module: the ScopeProvider
 * types and the Johnny Decimal grammar core, ported verbatim from
 * obsidian-johnny-decimal's src/core/jdId.ts (see that file's header for the
 * full shape catalogue: area / category / id / expanded-item / fractal-id).
 *
 * This file covers parse/format/addressOf/validateName + capabilities — the
 * grammar-only half. The five vault-aware methods (scopeOf/chainOf/membersOf/
 * expectedFolder/nextFree, Task 2) are covered in scheme-jd-scopes.test.mjs;
 * the smoke test at the bottom of this file just pins that they're live
 * (not the "task 2" stubs Task 1 shipped them as) so a future refactor can't
 * silently regress them back to throwing.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { jdProvider, DEFAULT_JD_CONFIG, validateJdConfig } from "../src/kernel/scheme/jd.js";
import { FIXTURE_JD_CONFIG } from "./scheme-fixture.mjs";

const p = jdProvider(FIXTURE_JD_CONFIG);

// ── capabilities ──────────────────────────────────────────────────────────────

describe("capabilities", () => {
  test("JD is a fully-capable provider", () => {
    assert.deepEqual(p.capabilities, { validate: true, itemAddresses: true, allocate: true, ordered: true });
  });
});

// ── parse: the five shapes, ported from parseJdId's test cases ─────────────────

describe("parse — the five JD shapes", () => {
  test("id (XX.YY)", () => {
    const a = p.parse("06.11");
    assert.equal(a?.kind, "id");
    assert.deepEqual(a?.levels, ["00-09", "06", "11"]);
  });

  test("id widened to a 3-digit decimal (XX.YYY) — survey's widening", () => {
    const a = p.parse("06.110");
    assert.equal(a?.kind, "id");
    assert.deepEqual(a?.levels, ["00-09", "06", "110"]);
  });

  test("area (XX-YY)", () => {
    const a = p.parse("00-09");
    assert.equal(a?.kind, "area");
    assert.deepEqual(a?.levels, ["00-09"]);
  });

  test("category (XX)", () => {
    const a = p.parse("06");
    assert.equal(a?.kind, "category");
    assert.deepEqual(a?.levels, ["00-09", "06"]);
  });

  test("expanded-item in an expanded AREA (90-99) — numbering + dashboard", () => {
    const a = p.parse("92021");
    assert.equal(a?.kind, "expanded-item");
    assert.deepEqual(a?.levels, ["90-99", "92021"], "no category folder — the whole area is flat");
  });

  test("expanded-item in an expanded CATEGORY (27) — the category folder survives", () => {
    const a = p.parse("27001");
    assert.equal(a?.kind, "expanded-item");
    assert.deepEqual(a?.levels, ["20-29", "27", "27001"]);
  });

  test("fractal-id (NNNNN.YY) inside an expanded area", () => {
    const a = p.parse("92021.10");
    assert.equal(a?.kind, "fractal-id");
    assert.deepEqual(a?.levels, ["90-99", "92021", "10"]);
  });

  test("a fractal id inside an expanded CATEGORY (not an expanded area) does not parse", () => {
    // parseJdId's fractal branch only accepts categories inside expandedAreas —
    // 27 is an expandedCategory, not an expandedArea, so 27021.10 is malformed.
    assert.equal(p.parse("27021.10"), null);
  });

  test("a bare 5-digit token outside both expandedAreas and expandedCategories does not parse", () => {
    assert.equal(p.parse("12345"), null);
  });

  test("rejects malformed ids", () => {
    assert.equal(p.parse("26 2.18"), null, "malformed — a space inside what should be one token");
    assert.equal(p.parse("nope"), null);
  });

  test("digits must match in an area token", () => {
    assert.equal(p.parse("10-29"), null);
  });

  test("trims surrounding whitespace, as parseJdId does", () => {
    const a = p.parse("  06.11  ");
    assert.equal(a?.kind, "id");
    assert.equal(a?.raw, "06.11");
  });
});

// ── format: round-trips parse's output ──────────────────────────────────────

describe("format", () => {
  test("round-trips every shape", () => {
    for (const raw of ["06.11", "06.110", "00-09", "06", "92021", "27001", "92021.10"]) {
      assert.equal(p.format(p.parse(raw)), raw);
    }
  });
});

// ── addressOf: basename token extraction ────────────────────────────────────

describe("addressOf — extracts the id token from a note's basename", () => {
  test("a normal content note under its area/category folders", () => {
    const a = p.addressOf("00-09 System/06 Agent tooling/06.11 Foo bar.md");
    assert.equal(p.format(a), "06.11");
  });

  test("a note with no JD id in its name resolves to null", () => {
    assert.equal(p.addressOf("Notes/plain note.md"), null);
  });

  test("a fractal-id note inside an expanded area", () => {
    const a = p.addressOf("90-99 Projects/92021 Big thing/92021.10 Sub.md");
    assert.equal(p.format(a), "92021.10");
  });

  test("an Extend-the-End suffix is stripped before parsing", () => {
    const a = p.addressOf("00-09 System/06 Agent tooling/06.11+2024 Foo bar.md");
    assert.equal(p.format(a), "06.11");
  });

  test("a bare filename with no directory still resolves", () => {
    const a = p.addressOf("06.11 Foo bar.md");
    assert.equal(p.format(a), "06.11");
  });
});

// ── validateName: malformed_name findings ───────────────────────────────────

describe("validateName", () => {
  test("a leading token that looks numeric but does not parse is malformed_name", () => {
    const findings = p.validateName("10-29 Something.md"); // digits must match in an area
    assert.equal(findings.length, 1);
    assert.equal(findings[0].code, "malformed_name");
    assert.equal(findings[0].path, "10-29 Something.md");
    assert.match(findings[0].detail, /10-29/);
  });

  test("a token with too few digits before the dot is malformed_name", () => {
    const findings = p.validateName("6.11 Something.md");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].code, "malformed_name");
  });

  test("a valid JD id produces no findings", () => {
    assert.deepEqual(p.validateName("06.11 Foo bar.md"), []);
  });

  test("a valid JD id with an Extend-the-End suffix produces no findings", () => {
    assert.deepEqual(p.validateName("43.11+2024 Foo.md"), []);
  });

  test("a plain, non-numeric name produces no findings — it simply isn't addressed", () => {
    assert.deepEqual(p.validateName("plain note.md"), []);
  });

  test("a bare valid category or area name produces no findings", () => {
    assert.deepEqual(p.validateName("06 Agent tooling.md"), []);
    assert.deepEqual(p.validateName("00-09 System.md"), []);
  });
});

// ── validateName: name-hygiene findings (ported from obsidian-jd-numbering) ───
//
// colon-in-name / trailing-space were jd-numbering's checkNote hygiene lint;
// they are the two of its checks scheme lacked AND could express purely over a
// filename. They are ORTHOGONAL to the address token: a valid address can
// still carry a trailing space, so validateName can return more than one.

describe("validateName — name hygiene", () => {
  test("a colon anywhere in the name is name_colon", () => {
    const findings = p.validateName("06.11 A: B.md");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].code, "name_colon");
    assert.match(findings[0].detail, /colon/);
  });

  test("a trailing space before the .md extension is name_trailing_space", () => {
    const findings = p.validateName("06.11 Note .md");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].code, "name_trailing_space");
  });

  test("a trailing space at the very end (no extension) is name_trailing_space", () => {
    const findings = p.validateName("06.11 Note ");
    assert.deepEqual(findings.map((f) => f.code), ["name_trailing_space"]);
  });

  test("hygiene coexists with a valid address — a valid id token does not suppress a hygiene finding", () => {
    // "06.11" parses fine, but the name still has a trailing space.
    const findings = p.validateName("06.11 Foo .md");
    assert.deepEqual(findings.map((f) => f.code), ["name_trailing_space"]);
  });

  test("malformed_name keeps index 0 when a name is BOTH malformed and unhygienic", () => {
    // Leading token "06.5" looks numeric but doesn't parse (malformed_name);
    // the colon and the trailing space live in the TITLE, not the id token
    // (a colon inside the leading token would instead defeat the numeric-look
    // heuristic and yield no malformed_name at all).
    const findings = p.validateName("06.5 bad: title .md");
    assert.equal(findings[0].code, "malformed_name");
    assert.deepEqual(findings.map((f) => f.code).sort(), ["malformed_name", "name_colon", "name_trailing_space"]);
  });

  test("a clean valid name has no hygiene findings", () => {
    assert.deepEqual(p.validateName("06.11 Foo bar.md"), []);
  });
});

// ── Task 2 methods: smoke-pinned live here; full coverage in scheme-jd-scopes.test.mjs ──

describe("methods deferred to task 2 are live, not stubs", () => {
  test("scopeOf/chainOf/membersOf/expectedFolder/nextFree no longer throw 'task 2'", () => {
    const notes = ["00-09 System/06 Agent tooling/06.11 Foo.md"];
    assert.deepEqual(p.scopeOf("00-09 System/06 Agent tooling/06.11 Foo.md"), { kind: "category", token: "06" });
    assert.deepEqual(p.chainOf({ kind: "category", token: "06" }), [
      { kind: "category", token: "06" },
      { kind: "area", token: "00-09" },
    ]);
    assert.deepEqual(
      p.membersOf({ kind: "category", token: "06" }, notes).map((m) => m.address),
      ["06.11"],
    );
    assert.equal(p.expectedFolder(p.parse("06.12"), notes), "00-09 System/06 Agent tooling");
    assert.equal(p.format(p.nextFree({ kind: "category", token: "06" }, notes)), "06.10");
  });
});

// ── Task 5 amendment 2: validateJdConfig — flexible user config, validated ──
// by the provider (skip-and-report, never throw).

describe("validateJdConfig — problems list, empty means valid", () => {
  test("undefined config (no override at all) is valid", () => {
    assert.deepEqual(validateJdConfig(undefined), []);
  });

  test("an empty object is valid — every key is optional", () => {
    assert.deepEqual(validateJdConfig({}), []);
  });

  test("a fully valid override is valid", () => {
    assert.deepEqual(validateJdConfig({ expandedAreas: ["90-99"], expandedCategories: ["27", "31"], contentDecimalFloor: 5 }), []);
  });

  test("a non-object config (e.g. a string, an array, null) is invalid", () => {
    assert.equal(validateJdConfig("90-99").length, 1);
    assert.equal(validateJdConfig(["90-99"]).length, 1);
    assert.equal(validateJdConfig(null).length, 1);
  });

  test("expandedAreas as a string (not an array) is invalid, matching the amendment's example", () => {
    const problems = validateJdConfig({ expandedAreas: "90-99" });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /expandedAreas must be an array of strings/);
  });

  test("expandedAreas with a malformed token (e.g. mismatched digits) is invalid", () => {
    const problems = validateJdConfig({ expandedAreas: ["05-19"] });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /"05-19" is not a valid area token/);
  });

  test("expandedCategories with a malformed token is invalid", () => {
    const problems = validateJdConfig({ expandedCategories: ["not-a-category"] });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /"not-a-category" is not a valid category token/);
  });

  test("contentDecimalFloor must be an integer 0..99", () => {
    assert.deepEqual(validateJdConfig({ contentDecimalFloor: 0 }), []);
    assert.deepEqual(validateJdConfig({ contentDecimalFloor: 99 }), []);
    assert.equal(validateJdConfig({ contentDecimalFloor: -1 }).length, 1);
    assert.equal(validateJdConfig({ contentDecimalFloor: 100 }).length, 1);
    assert.equal(validateJdConfig({ contentDecimalFloor: 5.5 }).length, 1);
    assert.equal(validateJdConfig({ contentDecimalFloor: "5" }).length, 1);
  });

  test("multiple problems are all reported, not just the first", () => {
    const problems = validateJdConfig({ expandedAreas: "90-99", contentDecimalFloor: 100 });
    assert.equal(problems.length, 2);
  });
});
