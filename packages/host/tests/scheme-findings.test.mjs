/**
 * scheme-findings.test.mjs — Task 4 of the scope-provider module: the pure
 * conformance findings core (`schemeFindings`). NOT a registered tool — this
 * is the rule-pack core a later task wraps as a read-only tool.
 *
 * Every rule delegates its judgment to the provider (`jdProvider`): nothing
 * here hardcodes JD-specific knowledge beyond building a fixture listing.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { jdProvider, DEFAULT_JD_CONFIG } from "../src/kernel/scheme/jd.js";
import { schemeFindings } from "@vault-mcp/core";

const instance = { id: "jd", providerName: "johnny-decimal", provider: jdProvider(DEFAULT_JD_CONFIG) };

// A listing exhibiting each finding class exactly once, plus one clean
// control note establishing "00-09 System/06 Agent tooling" as category 06's
// real folder (so expectedFolder has something correct to compare against).
const NOTES = [
  "00-09 System/06 Agent tooling/06.11 Vault MCP.md", // clean — establishes 06's real folder
  "00-09 System/06 Agent tooling/06.11 Duplicate.md", // duplicate_address (extra claimant)
  "00-09 System/06 Agent tooling/06.5 Bad.md", // malformed_name — "06.5" looks numeric, doesn't parse
  "00-09 System/06 Agent tooling/scratch no address.md", // unaddressed — in-scope, no address
  "00-09 System/06 Misfiled/06.20 Oops.md", // misfiled — valid address, wrong folder
];

describe("schemeFindings — one of each class", () => {
  const findings = schemeFindings(instance, NOTES);

  test("exactly four findings, one per class", () => {
    assert.equal(findings.length, 4);
    const codes = findings.map((f) => f.code).sort();
    assert.deepEqual(codes, ["duplicate_address", "malformed_name", "misfiled", "unaddressed"]);
  });

  test("deterministic order: sorted by path", () => {
    assert.deepEqual(
      findings.map((f) => f.path),
      [
        "00-09 System/06 Agent tooling/06.11 Duplicate.md",
        "00-09 System/06 Agent tooling/06.5 Bad.md",
        "00-09 System/06 Agent tooling/scratch no address.md",
        "00-09 System/06 Misfiled/06.20 Oops.md",
      ],
    );
  });

  test("duplicate_address: flagged on the EXTRA path, detail names the first claimant", () => {
    const f = findings.find((f) => f.code === "duplicate_address");
    assert.equal(f.path, "00-09 System/06 Agent tooling/06.11 Duplicate.md");
    assert.match(f.detail, /06\.11/);
    assert.match(f.detail, /06\.11 Vault MCP\.md/);
  });

  test("malformed_name: delegated to provider.validateName", () => {
    const f = findings.find((f) => f.code === "malformed_name");
    assert.equal(f.path, "00-09 System/06 Agent tooling/06.5 Bad.md");
    assert.match(f.detail, /06\.5/);
  });

  test("unaddressed: in-scope note with no recognizable address", () => {
    const f = findings.find((f) => f.code === "unaddressed");
    assert.equal(f.path, "00-09 System/06 Agent tooling/scratch no address.md");
  });

  test("misfiled: addressed note whose actual folder differs from expectedFolder", () => {
    const f = findings.find((f) => f.code === "misfiled");
    assert.equal(f.path, "00-09 System/06 Misfiled/06.20 Oops.md");
    assert.match(f.detail, /00-09 System\/06 Agent tooling/);
    assert.match(f.detail, /00-09 System\/06 Misfiled/);
  });

  test("the clean control note produces no finding of its own", () => {
    assert.ok(!findings.some((f) => f.path === "00-09 System/06 Agent tooling/06.11 Vault MCP.md"));
  });
});

describe("schemeFindings — clean listing", () => {
  test("a fully conformant listing (plus an out-of-scheme note) produces no findings", () => {
    const notes = [
      "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
      "00-09 System/06 Agent tooling/06.12 Bridge.md",
      "Unfiled/loose.md", // no scheme scope at all — not flagged unaddressed
    ];
    assert.deepEqual(schemeFindings(instance, notes), []);
  });
});

describe("schemeFindings — malformed_name and unaddressed are mutually exclusive per note", () => {
  test("a numeric-looking-but-unparseable name is malformed_name only, never also unaddressed", () => {
    const notes = ["00-09 System/06 Agent tooling/06.5 Bad.md"];
    const findings = schemeFindings(instance, notes);
    assert.deepEqual(
      findings.map((f) => f.code),
      ["malformed_name"],
    );
  });
});

// The name-hygiene checks (name_colon / name_trailing_space, ported from
// obsidian-jd-numbering's checkNote) are orthogonal to the address token, so
// unlike malformed_name they must NOT suppress the unaddressed check: a note
// that carries neither an address nor a clean name is legitimately both.
describe("schemeFindings — name-hygiene checks", () => {
  test("an addressed, correctly-filed note that has a trailing space is flagged name_trailing_space only", () => {
    const notes = [
      "00-09 System/06 Agent tooling/06.11 A.md", // clean control, establishes 06's folder
      "00-09 System/06 Agent tooling/06.12 Bridge .md", // valid address, trailing space
    ];
    const findings = schemeFindings(instance, notes);
    assert.deepEqual(
      findings.map((f) => ({ path: f.path, code: f.code })),
      [{ path: "00-09 System/06 Agent tooling/06.12 Bridge .md", code: "name_trailing_space" }],
    );
  });

  test("an unaddressed note that also has a colon is flagged BOTH unaddressed and name_colon (hygiene does not suppress unaddressed)", () => {
    const notes = [
      "00-09 System/06 Agent tooling/06.11 A.md", // clean control
      "00-09 System/06 Agent tooling/scratch: draft.md", // in-scope, no address, colon
    ];
    const codes = schemeFindings(instance, notes)
      .filter((f) => f.path.endsWith("scratch: draft.md"))
      .map((f) => f.code)
      .sort();
    assert.deepEqual(codes, ["name_colon", "unaddressed"]);
  });

  test("a malformed-address note with a trailing space is malformed_name + name_trailing_space, never unaddressed", () => {
    const notes = [
      "00-09 System/06 Agent tooling/06.11 A.md", // clean control
      "00-09 System/06 Agent tooling/06.5 Bad .md", // malformed token + trailing space
    ];
    const codes = schemeFindings(instance, notes)
      .filter((f) => f.path.endsWith("06.5 Bad .md"))
      .map((f) => f.code)
      .sort();
    assert.deepEqual(codes, ["malformed_name", "name_trailing_space"]);
  });
});

// expectedFolder's result depends only on the address's container token, so
// findings.ts memoizes it per container token within one schemeFindings call
// (jd.ts itself stays an unmemoized, always-fresh linear scan — see
// findings.ts's makeExpectedFolderCache doc). This pins that the memoized
// path produces IDENTICAL findings to what an unmemoized per-note lookup
// would: several notes sharing category "06" (so the cache entry is written
// once and reused on every subsequent lookup, both before and after the one
// misfiled note), with only the genuinely misfiled note flagged.
describe("schemeFindings — expectedFolder memoization does not change results", () => {
  test("many notes sharing a category: the cached lookup still flags only the misfiled one", () => {
    const notes = [
      "00-09 System/06 Agent tooling/06.11 A.md", // seeds the "06" cache entry, correctly filed
      "00-09 System/06 Agent tooling/06.12 B.md", // correctly filed — reuses the cached entry
      "00-09 System/06 Agent tooling/06.13 C.md", // correctly filed — reuses the cached entry
      "00-09 System/06 Misfiled/06.20 D.md", // misfiled — reuses the SAME cached entry
      "00-09 System/06 Agent tooling/06.14 E.md", // correctly filed — after the misfiled lookup
    ];
    const findings = schemeFindings(instance, notes);
    assert.deepEqual(
      findings.map((f) => ({ path: f.path, code: f.code })),
      [{ path: "00-09 System/06 Misfiled/06.20 D.md", code: "misfiled" }],
    );
    assert.match(findings[0].detail, /00-09 System\/06 Agent tooling/);
    assert.match(findings[0].detail, /00-09 System\/06 Misfiled/);
  });
});
