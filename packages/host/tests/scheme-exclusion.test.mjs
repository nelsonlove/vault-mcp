/**
 * scheme-exclusion.test.mjs — instance-level `excludedRoots`: the scope
 * territory exclusion seam (fleet assignment B, kernel-v0). Motivating case:
 * two notes claiming the same JD address, one in the live spine and one in
 * an archive tree ("Vault archaeology/…") — excluding the archive root lets
 * the scheme instance resolve cleanly to the live claimant without renaming
 * anything.
 *
 * Covers, in order:
 *   - excludeRoots (pure, registry.ts) — segment-boundary matching, identity
 *     convention
 *   - validateExcludedRoots (pure, registry.ts) — the skip-and-report
 *     validation convention
 *   - makeRegistry — invalid excludedRoots skips the instance; a trailing
 *     slash is normalized, not refused
 *   - schemeFindings — duplicate_address disappears, an excluded misfiled
 *     note produces nothing
 *   - the five read-only scheme tools — resolve_address's address:null +
 *     reason:"excluded", list_scope/next_address ignoring excluded
 *     occupants, expected_location skipping excluded candidate containers
 *   - no-exclusion passthrough — same-array identity, byte-identical
 *     behavior when excludedRoots is absent/[]
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  makeRegistry,
  excludeRoots,
  validateExcludedRoots,
} from "../src/kernel/scheme/registry.ts";
import { jdProvider, DEFAULT_JD_CONFIG } from "../src/kernel/scheme/jd.ts";
import { FIXTURE_JD_CONFIG } from "./scheme-fixture.mjs";
import { schemeFindings } from "@vault-mcp/core";
import { fakeServer } from "./fake-server.mjs";
import { registerSchemeTools } from "../src/mcp/tools-scheme.ts";

// ── the 02.10 fixture ────────────────────────────────────────────────────────

const LIVE_0210 = "00-09 System/02 Obsidian/02.10 Live spine note.md";
const ARCHIVE_0210 = "Vault archaeology/notes gen2/system notes/02.10 Archive note.md";
const ARCHIVE_SIBLING = "Vault archaeology2/notes/02.11 Not excluded.md"; // segment-boundary control

const NOTES_02_10 = [
  "00-09 System/00.00 Index.md",
  "00-09 System/02 Obsidian/02.00 Obsidian index.md",
  LIVE_0210,
  ARCHIVE_0210,
];

const JD_WITH_EXCLUSION = [{ id: "jd", provider: "johnny-decimal", excludedRoots: ["Vault archaeology"] }];

// ── excludeRoots (pure) ──────────────────────────────────────────────────────

describe("excludeRoots", () => {
  test("removes a path exactly equal to a root", () => {
    const out = excludeRoots(["Vault archaeology", "Other/x.md"], ["Vault archaeology"]);
    assert.deepEqual(out, ["Other/x.md"]);
  });

  test("removes everything under a root, segment-boundary matched", () => {
    const paths = [ARCHIVE_0210, LIVE_0210, ARCHIVE_SIBLING];
    const out = excludeRoots(paths, ["Vault archaeology"]);
    assert.deepEqual(out, [LIVE_0210, ARCHIVE_SIBLING], "a bare-prefix 'Vault archaeology2' must NOT be excluded by root 'Vault archaeology'");
  });

  test("roots absent returns the SAME array (identity)", () => {
    const paths = ["a.md", "b.md"];
    assert.equal(excludeRoots(paths, undefined), paths);
  });

  test("roots empty returns the SAME array (identity)", () => {
    const paths = ["a.md", "b.md"];
    assert.equal(excludeRoots(paths, []), paths);
  });

  test("roots present but nothing matches returns the SAME array (identity)", () => {
    const paths = ["a.md", "b.md"];
    assert.equal(excludeRoots(paths, ["Nowhere"]), paths);
  });

  test("multiple roots each remove their own subtree", () => {
    const paths = ["A/x.md", "B/y.md", "C/z.md"];
    assert.deepEqual(excludeRoots(paths, ["A", "B"]), ["C/z.md"]);
  });
});

// ── validateExcludedRoots (pure) ─────────────────────────────────────────────

describe("validateExcludedRoots", () => {
  test("undefined input -> {roots: undefined, problems: []}", () => {
    assert.deepEqual(validateExcludedRoots(undefined), { roots: undefined, problems: [] });
  });

  test("a clean relative folder passes through unchanged", () => {
    const { roots, problems } = validateExcludedRoots(["Vault archaeology"]);
    assert.deepEqual(roots, ["Vault archaeology"]);
    assert.deepEqual(problems, []);
  });

  test("a trailing slash is normalized away, not refused", () => {
    const { roots, problems } = validateExcludedRoots(["Vault archaeology/"]);
    assert.deepEqual(roots, ["Vault archaeology"]);
    assert.deepEqual(problems, []);
  });

  test("an absolute path is a problem", () => {
    const { roots, problems } = validateExcludedRoots(["/Vault archaeology"]);
    assert.equal(roots, undefined);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /relative/);
  });

  test('a ".." segment is a problem', () => {
    const { problems } = validateExcludedRoots(["Vault archaeology/../etc"]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /\.\./);
  });

  test('"." is a problem', () => {
    const { problems } = validateExcludedRoots(["."]);
    assert.equal(problems.length, 1);
  });

  test("a non-string entry is a problem", () => {
    const { problems } = validateExcludedRoots([42]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /non-empty string/);
  });

  test("an empty string entry is a problem", () => {
    const { problems } = validateExcludedRoots([""]);
    assert.equal(problems.length, 1);
  });

  test("several entries: valid ones collect, invalid ones each report their own problem", () => {
    const { roots, problems } = validateExcludedRoots(["Vault archaeology", "/bad", "Fine/Sub/"]);
    assert.deepEqual(roots, ["Vault archaeology", "Fine/Sub"]);
    assert.equal(problems.length, 1);
  });

  // ── Important 2 (reviewer, round 1): "./Vault archaeology" passed with
  // zero problems but excludeRoots never matched it — a silent no-op that
  // defeats the #74 you-must-SEE-it philosophy (the field LOOKS accepted,
  // but the exclusion never actually happens). Fix: normalize a leading
  // "./" away, same treatment as the trailing-slash precedent, and trim
  // surrounding whitespace.

  test('a leading "./" is normalized away, not refused, and the result actually excludes', () => {
    const { roots, problems } = validateExcludedRoots(["./Vault archaeology"]);
    assert.deepEqual(roots, ["Vault archaeology"]);
    assert.deepEqual(problems, []);
    // Prove the normalization isn't cosmetic-only: the normalized root must
    // actually fire against a real vault path.
    assert.deepEqual(excludeRoots(["Vault archaeology/x.md", "Other/y.md"], roots), ["Other/y.md"]);
  });

  test("repeated leading \"./\" segments are all stripped", () => {
    const { roots, problems } = validateExcludedRoots(["././Vault archaeology"]);
    assert.deepEqual(roots, ["Vault archaeology"]);
    assert.deepEqual(problems, []);
  });

  test("surrounding whitespace is trimmed", () => {
    const { roots, problems } = validateExcludedRoots(["  Vault archaeology  "]);
    assert.deepEqual(roots, ["Vault archaeology"]);
    assert.deepEqual(problems, []);
  });

  test("interior whitespace is preserved as part of the name — only surrounding whitespace is trimmed", () => {
    const { roots, problems } = validateExcludedRoots(["  My   Folder  "]);
    assert.deepEqual(roots, ["My   Folder"]);
    assert.deepEqual(problems, []);
  });

  test('a ".." segment reached via a leading "./" is still a problem (normalization does not mask it)', () => {
    const { problems } = validateExcludedRoots(["./../etc"]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /\.\./);
  });

  test('"./" alone (normalizes to nothing) is a problem, not a silently-dropped no-op root', () => {
    const { roots, problems } = validateExcludedRoots(["./"]);
    assert.equal(roots, undefined);
    assert.equal(problems.length, 1);
  });
});

// ── makeRegistry — excludedRoots validation, skip-and-report ────────────────

describe("makeRegistry — excludedRoots", () => {
  test("a valid excludedRoots is attached to the built instance", () => {
    const reg = makeRegistry(JD_WITH_EXCLUSION);
    const inst = reg.get("jd");
    assert.ok(inst);
    assert.deepEqual(inst.excludedRoots, ["Vault archaeology"]);
  });

  test("no excludedRoots configured -> instance.excludedRoots is undefined", () => {
    const reg = makeRegistry([{ id: "jd", provider: "johnny-decimal" }]);
    assert.equal(reg.get("jd").excludedRoots, undefined);
  });

  test("a trailing slash is normalized on the built instance, not refused", () => {
    const reg = makeRegistry([{ id: "jd", provider: "johnny-decimal", excludedRoots: ["Vault archaeology/"] }]);
    const inst = reg.get("jd");
    assert.ok(inst, "instance must NOT be skipped for a mere trailing slash");
    assert.deepEqual(inst.excludedRoots, ["Vault archaeology"]);
  });

  test("an invalid excludedRoots entry (absolute path) skips the whole instance, console.error reports it", () => {
    const originalError = console.error;
    let message = "";
    console.error = (msg) => {
      message = msg;
    };
    try {
      const reg = makeRegistry([{ id: "jd", provider: "johnny-decimal", excludedRoots: ["/absolute"] }]);
      assert.equal(reg.get("jd"), null, "instance skipped, not registered with a dropped-bad-entry list");
      assert.match(message, /excludedRoots/);
      assert.match(message, /"jd"/);
    } finally {
      console.error = originalError;
    }
  });

  test('an invalid excludedRoots entry (".." segment) skips the instance', () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const reg = makeRegistry([{ id: "jd", provider: "johnny-decimal", excludedRoots: ["a/../b"] }]);
      assert.equal(reg.get("jd"), null);
    } finally {
      console.error = originalError;
    }
  });

  test("a non-string excludedRoots entry skips the instance", () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const reg = makeRegistry([{ id: "jd", provider: "johnny-decimal", excludedRoots: [42] }]);
      assert.equal(reg.get("jd"), null);
    } finally {
      console.error = originalError;
    }
  });

  test("the id of a skipped-for-excludedRoots instance is still reserved (duplicate-id convention)", () => {
    const originalError = console.error;
    let calls = 0;
    console.error = () => {
      calls++;
    };
    try {
      const reg = makeRegistry([
        { id: "jd", provider: "johnny-decimal", excludedRoots: ["/bad"] },
        { id: "jd", provider: "johnny-decimal" }, // would otherwise register cleanly
      ]);
      assert.equal(reg.get("jd"), null, "the id stays unclaimed by the second, otherwise-valid row");
      assert.equal(calls, 2, "both the excludedRoots problem and the duplicate-id skip are reported");
    } finally {
      console.error = originalError;
    }
  });
});

// ── schemeFindings — excludedRoots ───────────────────────────────────────────

describe("schemeFindings — excludedRoots", () => {
  const provider = jdProvider(FIXTURE_JD_CONFIG);

  test("the duplicate_address finding disappears when one side is excluded", () => {
    const instance = { id: "jd", providerName: "johnny-decimal", provider, excludedRoots: ["Vault archaeology"] };
    const findings = schemeFindings(instance, NOTES_02_10);
    assert.deepEqual(findings, [], "the live note is the sole visible claimant; nothing to flag");
  });

  test("without exclusion, the same fixture DOES report duplicate_address", () => {
    const instance = { id: "jd", providerName: "johnny-decimal", provider };
    const findings = schemeFindings(instance, NOTES_02_10);
    assert.equal(findings.some((f) => f.code === "duplicate_address"), true);
  });

  test("an excluded misfiled note produces no findings at all", () => {
    const misfiled = ["00-09 System/06 Agent tooling/06.11 Vault MCP.md", "Vault archaeology/06.20 Wrong folder.md"];
    const instance = { id: "jd", providerName: "johnny-decimal", provider, excludedRoots: ["Vault archaeology"] };
    assert.deepEqual(schemeFindings(instance, misfiled), []);
  });

  test("no excludedRoots -> same findings as before this feature existed (passthrough)", () => {
    const NOTES = [
      "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
      "00-09 System/06 Agent tooling/06.11 Duplicate.md",
    ];
    const instance = { id: "jd", providerName: "johnny-decimal", provider };
    const findings = schemeFindings(instance, NOTES);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].code, "duplicate_address");
  });
});

// ── the five read-only scheme tools — excludedRoots ──────────────────────────

function toolServer({ schemes, notes, settings = { readOnly: false, allowlist: [] } }) {
  const server = fakeServer();
  registerSchemeTools(server, {
    registry: () => makeRegistry(schemes),
    notes: () => notes,
    getSettings: () => ({ ...settings, schemes }),
  });
  const call = (name, args = {}) => server.tools.get(name).handler(args, {});
  return { server, call };
}

describe("obsidian_resolve_address — excludedRoots", () => {
  test("address direction: two claimants, one excluded -> resolves cleanly to the live one", async () => {
    const { call } = toolServer({ schemes: JD_WITH_EXCLUSION, notes: NOTES_02_10 });
    const res = await call("obsidian_resolve_address", { address: "jd:02.10" });
    assert.equal(res.isError, undefined);
    assert.deepEqual(res.structuredContent, { address: "jd:02.10", found: true, path: LIVE_0210 });
  });

  test("address direction: the only claimant excluded -> found: false, no disclosure", async () => {
    const onlyArchived = ["00-09 System/00.00 Index.md", ARCHIVE_0210];
    const { call } = toolServer({ schemes: JD_WITH_EXCLUSION, notes: onlyArchived });
    const res = await call("obsidian_resolve_address", { address: "jd:02.10" });
    assert.equal(res.structuredContent.found, false);
  });

  test("path direction: the excluded note's own path reports address: null, reason: excluded", async () => {
    const { call } = toolServer({ schemes: JD_WITH_EXCLUSION, notes: NOTES_02_10 });
    const res = await call("obsidian_resolve_address", { path: ARCHIVE_0210 });
    assert.deepEqual(res.structuredContent, { path: ARCHIVE_0210, address: null, scheme: null, reason: "excluded" });
  });

  test("path direction: a NON-excluded note (the live claimant) resolves normally, no reason field", async () => {
    const { call } = toolServer({ schemes: JD_WITH_EXCLUSION, notes: NOTES_02_10 });
    const res = await call("obsidian_resolve_address", { path: LIVE_0210 });
    assert.deepEqual(res.structuredContent, { path: LIVE_0210, address: "02.10", scheme: "jd" });
  });

  test("the tool description documents the excluded reason", async () => {
    const { server } = toolServer({ schemes: JD_WITH_EXCLUSION, notes: NOTES_02_10 });
    const desc = server.tools.get("obsidian_resolve_address").def.description.toLowerCase();
    assert.match(desc, /excluded/);
  });
});

// ── Important 1 (reviewer, round 1): multi-instance fall-through parity.
// obsidian_resolve_address's path direction used to stop at the FIRST
// instance recognizing the path even when THAT instance excluded it,
// reporting `reason: "excluded"` — while obsidian_expected_location already
// `continue`d past an excluding instance to one that claims it. A
// two-instance config where instance "a" excludes "Vault archaeology" and
// instance "b" does not (both johnny-decimal, so both recognize the same
// address) demonstrates the divergence: the archived note's address should
// be claimed by "b", and both tools must agree.

describe("obsidian_resolve_address / obsidian_expected_location — multi-instance fall-through parity", () => {
  const TWO_INSTANCE_MIXED = [
    { id: "a", provider: "johnny-decimal", excludedRoots: ["Vault archaeology"] },
    { id: "b", provider: "johnny-decimal" },
  ];
  const archivedPath = "Vault archaeology/notes gen2/system notes/06.11 Archived.md";
  const notes = [archivedPath];

  test("obsidian_resolve_address falls through the excluding instance to the claiming one", async () => {
    const { call } = toolServer({ schemes: TWO_INSTANCE_MIXED, notes });
    const res = await call("obsidian_resolve_address", { path: archivedPath });
    assert.deepEqual(res.structuredContent, { path: archivedPath, address: "06.11", scheme: "b" });
  });

  test("obsidian_expected_location falls through the excluding instance to the claiming one", async () => {
    const { call } = toolServer({ schemes: TWO_INSTANCE_MIXED, notes });
    const res = await call("obsidian_expected_location", { path: archivedPath, scheme: undefined });
    assert.equal(res.structuredContent.address, "06.11");
  });

  test("the two tools AGREE: neither reports the note as excluded when a non-excluding instance claims it", async () => {
    const { call } = toolServer({ schemes: TWO_INSTANCE_MIXED, notes });
    const resolveRes = await call("obsidian_resolve_address", { path: archivedPath });
    const expectedRes = await call("obsidian_expected_location", { path: archivedPath });
    assert.equal(resolveRes.structuredContent.address, "06.11");
    assert.equal(expectedRes.structuredContent.address, "06.11");
    assert.equal(resolveRes.structuredContent.reason, undefined);
  });

  test("when EVERY recognizing instance excludes it, obsidian_resolve_address reports reason: excluded", async () => {
    const bothExclude = [
      { id: "a", provider: "johnny-decimal", excludedRoots: ["Vault archaeology"] },
      { id: "b", provider: "johnny-decimal", excludedRoots: ["Vault archaeology"] },
    ];
    const { call } = toolServer({ schemes: bothExclude, notes });
    const res = await call("obsidian_resolve_address", { path: archivedPath });
    assert.deepEqual(res.structuredContent, { path: archivedPath, address: null, scheme: null, reason: "excluded" });
  });

  test("when EVERY recognizing instance excludes it, obsidian_expected_location falls through to unrecognized", async () => {
    const bothExclude = [
      { id: "a", provider: "johnny-decimal", excludedRoots: ["Vault archaeology"] },
      { id: "b", provider: "johnny-decimal", excludedRoots: ["Vault archaeology"] },
    ];
    const { call } = toolServer({ schemes: bothExclude, notes });
    const res = await call("obsidian_expected_location", { path: archivedPath });
    assert.equal(res.structuredContent.address, null);
  });
});

describe("obsidian_list_scope — excludedRoots", () => {
  const schemes = [{ id: "jd", provider: "johnny-decimal", excludedRoots: ["Vault archaeology"] }];
  const notes = [
    "00-09 System/02 Obsidian/02.10 Live spine note.md",
    "Vault archaeology/notes gen2/system notes/02.11 Also archived.md",
  ];

  test("excluded members are absent from the scope listing", async () => {
    const { call } = toolServer({ schemes, notes });
    const res = await call("obsidian_list_scope", { scope: "02" });
    assert.deepEqual(
      res.structuredContent.members.map((m) => m.path),
      [LIVE_0210]
    );
  });

  test("free/gaps allocation ignores the excluded occupant (02.11 reads as free, not taken)", async () => {
    const { call } = toolServer({ schemes, notes });
    const res = await call("obsidian_list_scope", { scope: "02" });
    assert.equal(res.structuredContent.free.next, "02.11");
  });
});

describe("obsidian_next_address — excludedRoots", () => {
  test("the excluded occupant's address computes as next-free", async () => {
    const schemes = [{ id: "jd", provider: "johnny-decimal", excludedRoots: ["Vault archaeology"] }];
    const notes = [
      "00-09 System/02 Obsidian/02.10 Live spine note.md",
      "Vault archaeology/02.11 Archived.md",
    ];
    const { call } = toolServer({ schemes, notes });
    const res = await call("obsidian_next_address", { scope: "02" });
    assert.equal(res.structuredContent.next, "02.11");
  });
});

describe("obsidian_expected_location — excludedRoots", () => {
  test("a candidate container folder under an excluded root is not considered", async () => {
    const schemes = [{ id: "jd", provider: "johnny-decimal", excludedRoots: ["Vault archaeology"] }];
    // Only an archived note establishes folder "Vault archaeology/06 Agent tooling"
    // for category 06 — with the root excluded, nothing establishes it, so
    // expected_folder is null rather than pointing into excluded territory.
    const notes = ["Vault archaeology/06 Agent tooling/06.11 Archived.md"];
    const { call } = toolServer({ schemes, notes });
    const res = await call("obsidian_expected_location", { address: "jd:06.12" });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.expected_folder, null);
  });

  test("path direction: an excluded note falls through as unrecognized (address: null)", async () => {
    const schemes = [{ id: "jd", provider: "johnny-decimal", excludedRoots: ["Vault archaeology"] }];
    const notes = ["Vault archaeology/06 Agent tooling/06.11 Archived.md"];
    const { call } = toolServer({ schemes, notes });
    const res = await call("obsidian_expected_location", { path: notes[0] });
    assert.equal(res.structuredContent.address, null);
  });
});

// ── no-exclusion passthrough — identity + byte-identical behavior ───────────

describe("no-exclusion passthrough", () => {
  test("excludedRoots absent: obsidian_list_scope's members are unaffected, byte-identical", async () => {
    const schemes = [{ id: "jd", provider: "johnny-decimal" }];
    const notes = [LIVE_0210];
    const { call } = toolServer({ schemes, notes });
    const res = await call("obsidian_list_scope", { scope: "02" });
    assert.deepEqual(
      res.structuredContent.members.map((m) => m.path),
      [LIVE_0210]
    );
  });

  test("excludedRoots: [] behaves identically to absent", async () => {
    const schemesEmpty = [{ id: "jd", provider: "johnny-decimal", excludedRoots: [] }];
    const notes = [LIVE_0210];
    const { call } = toolServer({ schemes: schemesEmpty, notes });
    const res = await call("obsidian_list_scope", { scope: "02" });
    assert.deepEqual(
      res.structuredContent.members.map((m) => m.path),
      [LIVE_0210]
    );
  });

  test("excludeRoots identity: instance.excludedRoots absent leaves the registry's own resolve() unaffected", () => {
    const reg = makeRegistry([{ id: "jd", provider: "johnny-decimal" }]);
    // Exercise via the registry's own resolve(), confirming the candidate
    // list handed to it is unaffected in shape/order.
    const inst = reg.get("jd");
    const target = inst.provider.parse("06.11");
    const matches = reg.resolve(inst, target, [
      "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
    ]);
    assert.deepEqual(matches, ["00-09 System/06 Agent tooling/06.11 Vault MCP.md"]);
  });
});
