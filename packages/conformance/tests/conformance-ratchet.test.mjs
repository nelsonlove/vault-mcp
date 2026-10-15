/**
 * conformance-ratchet.test.mjs — the TS ratchet: baseline parse + the
 * NEW/CLEARED/CARRIED diff over the 4-tuple keyset, reproducing
 * conformance_ratchet.py's contract.
 *
 *   NEW     = live − baseline   → the run FAILS (exit 1) iff non-empty
 *   CLEARED = baseline − live   → never fails; --rebaseline shrinks the baseline
 *   CARRIED = live ∩ baseline   → accepted debt, counted not listed
 *
 * parseBaseline reads the ` ```ratchet-baseline ` fence; renderBaseline emits
 * it sorted, byte-compatible with the live `Conformance baseline.md`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseBaseline, renderBaseline, ratchet } from "../src/kernel/ratchet.ts";

const F = (script, check, target, kind = "", detail = "") => ({ script, check, target, kind, detail });

const BASELINE_NOTE = `---
title: Conformance baseline
---

Some prose about the baseline.

\`\`\`ratchet-baseline
conformance_check|DROPPED|00-09 System/02 Obsidian/02 Obsidian.md|Category.blueprint
vocab_findings|unregistered_tag|Notes/A.md|rogue
scheme_findings|misfiled|Notes/B.md|
\`\`\`

Trailing prose.
`;

describe("parseBaseline", () => {
  test("extracts exactly the fenced key lines, ignoring surrounding prose", () => {
    const keys = parseBaseline(BASELINE_NOTE);
    assert.equal(keys.size, 3);
    assert.ok(keys.has("vocab_findings|unregistered_tag|Notes/A.md|rogue"));
    assert.ok(keys.has("scheme_findings|misfiled|Notes/B.md|"));
    assert.ok(keys.has("conformance_check|DROPPED|00-09 System/02 Obsidian/02 Obsidian.md|Category.blueprint"));
  });

  test("a note with no fence parses to an empty set (not an error)", () => {
    assert.equal(parseBaseline("# just prose\n\nno fence here\n").size, 0);
  });
});

describe("ratchet diff", () => {
  const baseline = new Set([
    "vocab_findings|unregistered_tag|Notes/A.md|rogue",
    "scheme_findings|misfiled|Notes/B.md|",
  ]);

  test("a live finding absent from the baseline is NEW and fails the run", () => {
    const live = [
      F("vocab_findings", "unregistered_tag", "Notes/A.md", "rogue"), // carried
      F("vocab_findings", "undefined_property", "Notes/C.md", "sprocket"), // new
    ];
    const r = ratchet(live, baseline);
    assert.deepEqual(r.newKeys, ["vocab_findings|undefined_property|Notes/C.md|sprocket"]);
    assert.equal(r.carried, 1);
    assert.equal(r.failed, true);
    assert.equal(r.exitCode, 1);
  });

  test("a baseline finding gone from the live run is CLEARED and never fails", () => {
    const live = [F("vocab_findings", "unregistered_tag", "Notes/A.md", "rogue")]; // B misfile cleared
    const r = ratchet(live, baseline);
    assert.deepEqual(r.clearedKeys, ["scheme_findings|misfiled|Notes/B.md|"]);
    assert.equal(r.newKeys.length, 0);
    assert.equal(r.failed, false);
    assert.equal(r.exitCode, 0);
  });

  test("all-carried run passes with exit 0", () => {
    const live = [
      F("vocab_findings", "unregistered_tag", "Notes/A.md", "rogue"),
      F("scheme_findings", "misfiled", "Notes/B.md", ""),
    ];
    const r = ratchet(live, baseline);
    assert.equal(r.failed, false);
    assert.equal(r.carried, 2);
    assert.equal(r.newKeys.length, 0);
    assert.equal(r.clearedKeys.length, 0);
  });

  test("duplicate live findings with the same key collapse (a key is present-or-absent, not counted)", () => {
    const live = [
      F("vocab_findings", "unregistered_tag", "Notes/A.md", "rogue"),
      F("vocab_findings", "unregistered_tag", "Notes/A.md", "rogue"),
    ];
    const r = ratchet(live, new Set());
    assert.equal(r.newKeys.length, 1);
  });
});

describe("renderBaseline", () => {
  test("emits sorted key lines (deterministic, a function of the findings)", () => {
    const live = [
      F("vocab_findings", "unregistered_tag", "Notes/Z.md", "z"),
      F("scheme_findings", "misfiled", "Notes/A.md", ""),
    ];
    const out = renderBaseline(live);
    assert.deepEqual(out.split("\n"), [
      "scheme_findings|misfiled|Notes/A.md|",
      "vocab_findings|unregistered_tag|Notes/Z.md|z",
    ]);
  });

  test("renderBaseline output re-parses to the same keyset (round-trip)", () => {
    const live = [F("scheme_findings", "duplicate_address", "Notes/B.md", "06.11")];
    const reparsed = parseBaseline("```ratchet-baseline\n" + renderBaseline(live) + "\n```\n");
    assert.ok(reparsed.has("scheme_findings|duplicate_address|Notes/B.md|06.11"));
  });

  // #136 item 3: a note named with a pipe must survive render → parse → ratchet
  // as CARRIED (accepted debt), never re-appearing as a NEW finding.
  test("a pipe-in-target finding round-trips through the baseline and rachets as CARRIED", () => {
    const live = [F("scheme_findings", "unaddressed", "Notes/--skip | olano.dev.md", "")];
    const baseline = parseBaseline("```ratchet-baseline\n" + renderBaseline(live) + "\n```\n");
    const r = ratchet(live, baseline);
    assert.deepEqual(r.newKeys, [], "the pipe note must not resurface as NEW");
    assert.deepEqual(r.clearedKeys, []);
    assert.equal(r.carried, 1);
    assert.equal(r.exitCode, 0);
  });
});
