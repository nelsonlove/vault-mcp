/**
 * frontmatter-read-sites.test.mjs — issue #189, the two conformance-pack READ
 * sites that parsed raw note text with their own narrow `/^---\n/` frontmatter
 * regexes instead of the shared recognizer in @vault-mcp/core
 * (`leadingFrontmatterBlock` / `stripLeadingFrontmatter`, the #150 pair). A
 * narrow local copy reads a BOM- or CRLF-authored note as having NO
 * frontmatter at all — a silent mis-read, not a bypass.
 *
 * Moved from packages/host/tests/frontmatter-read-sites.test.mjs with the rail
 * on 2026-10-14; the host's other #189 sites stay pinned there. One
 * describe-block PER SITE, so neutering any single site (reverting its regex)
 * fails that site's own block. Each block asserts:
 *
 *   1. a BOM-prefixed note now parses (the pre-fix narrow behavior is dead),
 *   2. a CRLF note now parses,
 *   3. a plain LF note behaves byte-identically to before the fix — which is
 *      what keeps every already-recognized note's finding set, and therefore
 *      its ratchet keys, unchanged.
 *
 * The sites:
 *   - src/kernel/packs/drift.ts        `fmBlock`           (BOM+CRLF-blind)
 *   - src/kernel/packs/structure.ts    FM_STRIP + noteInfo (BOM+CRLF-blind)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { driftPack } from "../src/kernel/packs/index.ts";
import { findingKey } from "../src/kernel/finding.ts";
import { LEGACY_CONVENTIONS_SEED as SEED } from "../src/kernel/vault-conventions.ts";
import { noteInfo, emittedH2s } from "../src/kernel/packs/structure.ts";

// U+FEFF by code point, never a literal BOM byte in source (accept-guard.ts's
// own convention — stripLeadingBom compares 0xfeff the same way).
const BOM = String.fromCharCode(0xfeff);

// ── site 1: drift.ts `fmBlock` (exercised through check E on a uid pair) ─────
//
// E reads a note's `uid:` via fmBlock. Pre-fix, a BOM/CRLF note's frontmatter
// was invisible, so a duplicate claimant authored that way drew NO finding — a
// false clean. Post-fix its uid parses and the pair is the same E finding, same
// key, as an LF-authored pair. (Until #412 this site was exercised through the
// retired check G's `title:` read; the recognizer binding is the same.)

describe("drift.ts fmBlock binds to the shared recognizer (#189)", () => {
  const UID = "0192f1a0-1234-7abc-8def-0123456789ab";
  const snap = (sources) => ({
    notes: [],
    paths: [],
    blueprints: [],
    sources,
    dirs: [],
    walkOrder: sources.map((s) => s.path),
  });
  const pair = (text) => [{ path: "Notes/lf.md", text: `---\nuid: ${UID}\n---\nbody\n` }, { path: "Notes/other.md", text }];
  const eFindings = (text) => driftPack(SEED).run(snap(pair(text))).filter((f) => f.check === "E");
  const EXPECT_KEY = `drift_audit|E|${UID}|dup-uid`;

  test("LF note: a duplicate claimant draws the E finding (regression — unchanged behavior)", () => {
    const [f] = eFindings(`---\nuid: ${UID}\n---\nbody\n`);
    assert.ok(f, "expected an E finding");
    assert.equal(findingKey(f), EXPECT_KEY);
  });

  test("LF note: a different uid is not a claimant (the pair is the instrument, not the answer)", () => {
    assert.deepEqual(eFindings("---\nuid: ffff0000-1234-7abc-8def-0123456789ab\n---\n"), []);
  });

  test("BOM note: the frontmatter is SEEN — the duplicate is found, same key", () => {
    const [f] = eFindings(BOM + `---\nuid: ${UID}\n---\nbody\n`);
    assert.ok(f, "expected an E finding; a BOM must not hide a claimant");
    assert.equal(findingKey(f), EXPECT_KEY);
  });

  test("CRLF note: the frontmatter is SEEN — the duplicate is found, same key", () => {
    const [f] = eFindings(`---\r\nuid: ${UID}\r\n---\r\nbody\r\n`);
    assert.ok(f, "expected an E finding; CRLF must not hide a claimant");
    assert.equal(findingKey(f), EXPECT_KEY);
  });
});

// ── site 2: structure.ts — FM_STRIP (emittedH2s) and noteInfo ─────────────────

describe("structure.ts emittedH2s strips BOM/CRLF frontmatter (#189)", () => {
  // `## Ghost` sits INSIDE the blueprint's frontmatter; only `## Real` is body.
  // Pre-fix, a BOM made the strip miss, so Ghost leaked into the emitted set.
  const bp = (text) => emittedH2s("x.blueprint", new Map([["x.blueprint", text]]));

  test("LF blueprint: frontmatter is dropped (regression)", () => {
    assert.deepEqual([...bp("---\n## Ghost\n---\n## Real\n").heads], ["Real"]);
  });

  test("BOM blueprint: frontmatter is dropped, Ghost does not leak", () => {
    assert.deepEqual([...bp(BOM + "---\n## Ghost\n---\n## Real\n").heads], ["Real"]);
  });

  test("CRLF blueprint: frontmatter is dropped, Ghost does not leak", () => {
    assert.deepEqual([...bp("---\r\n## Ghost\r\n---\r\n## Real\r\n").heads], ["Real"]);
  });

  test("no frontmatter: nothing is stripped (regression)", () => {
    assert.deepEqual([...bp("## Real\n").heads], ["Real"]);
  });
});

describe("structure.ts noteInfo binds both halves to the shared recognizer (#189)", () => {
  const LF = '---\nblueprint: "[[X.blueprint]]"\n---\n## A\n```\n## fenced\n```\n## B\n';

  test("LF note: blueprint + H2s read as before (regression, incl. fence skipping)", () => {
    assert.deepEqual(noteInfo(LF), { bp: "X.blueprint", heads: ["A", "B"] });
  });

  test("BOM note: the blueprint link is SEEN (pre-fix the note read as having no frontmatter)", () => {
    assert.deepEqual(noteInfo(BOM + LF), { bp: "X.blueprint", heads: ["A", "B"] });
  });

  test("CRLF note: the blueprint link is SEEN", () => {
    const crlf = '---\r\nblueprint: "[[X.blueprint]]"\r\n---\r\n## A\r\n## B\r\n';
    assert.deepEqual(noteInfo(crlf), { bp: "X.blueprint", heads: ["A", "B"] });
  });

  test("frontmatter H2s are never counted as body H2s (the halves agree)", () => {
    const tricky = '---\nblueprint: "[[X.blueprint]]"\n## Ghost\n---\n## A\n';
    assert.deepEqual(noteInfo(tricky), { bp: "X.blueprint", heads: ["A"] });
  });

  test("no frontmatter / no blueprint link: skipped, as before (regression)", () => {
    assert.deepEqual(noteInfo("## A\n"), { bp: null, heads: [] });
    assert.deepEqual(noteInfo("---\ntitle: t\n---\n## A\n"), { bp: null, heads: [] });
  });
});

