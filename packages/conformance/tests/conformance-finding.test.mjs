/**
 * conformance-finding.test.mjs — the canonical rail Finding + its 4-tuple key.
 *
 * The key MUST serialize byte-identically to the existing Python ratchet's
 * baseline lines (`script|check|target|kind`, verified against the live
 * `Conformance baseline.md` fence) so the accepted-debt baseline carries over
 * with no re-blessing. The `detail` field is human text and is NOT part of the
 * key.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findingKey, parseKey } from "../src/kernel/finding.ts";

describe("findingKey", () => {
  test("serializes as script|check|target|kind (matches the live baseline)", () => {
    const f = {
      script: "conformance_check",
      check: "DROPPED",
      target: "00-09 System/02 Obsidian/02 Obsidian.md",
      kind: "Category.blueprint",
      detail: "would drop section on apply",
    };
    assert.equal(findingKey(f), "conformance_check|DROPPED|00-09 System/02 Obsidian/02 Obsidian.md|Category.blueprint");
  });

  test("detail is excluded from the key (two findings differing only in detail share a key)", () => {
    const a = { script: "s", check: "c", target: "t", kind: "k", detail: "one" };
    const b = { script: "s", check: "c", target: "t", kind: "k", detail: "two" };
    assert.equal(findingKey(a), findingKey(b));
  });

  test("an empty kind serializes as a trailing empty field", () => {
    assert.equal(findingKey({ script: "scheme_findings", check: "misfiled", target: "N.md", kind: "", detail: "" }), "scheme_findings|misfiled|N.md|");
  });

  test("parseKey round-trips findingKey", () => {
    const line = "vocab_findings|unregistered_tag|Notes/A.md|rogue";
    const k = parseKey(line);
    assert.deepEqual(k, { script: "vocab_findings", check: "unregistered_tag", target: "Notes/A.md", kind: "rogue" });
    assert.equal(findingKey({ ...k, detail: "ignored" }), line);
  });

  test("parseKey tolerates a target containing no pipe and an empty kind", () => {
    assert.deepEqual(parseKey("scheme_findings|misfiled|N.md|"), {
      script: "scheme_findings",
      check: "misfiled",
      target: "N.md",
      kind: "",
    });
  });
});

// #136 item 3: a real vault note IS named with a pipe (e.g.
// `--dangerously-skip-reading-code | olano.dev.md`). Its path becomes a finding
// `target`; the old key threw on a `|` in the first three fields and CRASHED
// the whole run. `findingKey` now ESCAPES the separator instead — total, never
// throwing — and `parseKey` round-trips it back.
describe("findingKey pipe/backslash escaping (issue #136)", () => {
  test("a pipe in target no longer throws — it escapes and round-trips", () => {
    const f = { script: "scheme_findings", check: "unaddressed", target: "Notes/--skip | olano.dev.md", kind: "" };
    const line = findingKey(f); // does NOT throw
    assert.equal(parseKey(line).target, "Notes/--skip | olano.dev.md");
    assert.deepEqual(parseKey(line), { script: "scheme_findings", check: "unaddressed", target: "Notes/--skip | olano.dev.md", kind: "" });
  });

  test("a pipe in ANY field round-trips (script/check/target/kind)", () => {
    const f = { script: "s|1", check: "c|2", target: "t|3", kind: "k|4" };
    assert.deepEqual(parseKey(findingKey(f)), { script: "s|1", check: "c|2", target: "t|3", kind: "k|4" });
  });

  test("a backslash round-trips (the escape char itself is escaped)", () => {
    const f = { script: "s", check: "c", target: "a\\b", kind: "k" };
    assert.equal(parseKey(findingKey(f)).target, "a\\b");
  });

  test("pipe and backslash together round-trip unambiguously", () => {
    const f = { script: "s", check: "c", target: "a\\|b", kind: "c\\d|e" };
    assert.deepEqual(parseKey(findingKey(f)), { script: "s", check: "c", target: "a\\|b", kind: "c\\d|e" });
  });

  test("two findings differing only in WHERE the pipe sits get DISTINCT keys", () => {
    const k1 = findingKey({ script: "s", check: "c", target: "a|b", kind: "d" });
    const k2 = findingKey({ script: "s", check: "c", target: "a", kind: "b|d" });
    assert.notEqual(k1, k2);
  });

  test("two findings differing only in WHERE the escape char sits get DISTINCT keys", () => {
    const k1 = findingKey({ script: "s", check: "c", target: "a\\b", kind: "d" });
    const k2 = findingKey({ script: "s", check: "c", target: "a", kind: "\\bd" });
    assert.notEqual(k1, k2);
  });

  // The load-bearing baseline-compat property: any component with neither `|`
  // nor `\` serializes byte-for-byte as before, so every existing accepted-debt
  // key is unchanged and carries over with zero re-blessing.
  test("baseline-compat: a pipe-and-backslash-free key is byte-identical to the naive join", () => {
    const f = { script: "conformance_check", check: "DROPPED", target: "00-09 System/02 Obsidian/02 Obsidian.md", kind: "Category.blueprint" };
    assert.equal(findingKey(f), [f.script, f.check, f.target, f.kind].join("|"));
    assert.equal(findingKey(f), "conformance_check|DROPPED|00-09 System/02 Obsidian/02 Obsidian.md|Category.blueprint");
  });

  test("baseline-compat: an empty kind still serializes as a bare trailing pipe", () => {
    assert.equal(findingKey({ script: "scheme_findings", check: "misfiled", target: "N.md", kind: "" }), "scheme_findings|misfiled|N.md|");
  });

  test("a LEGACY key with a raw (unescaped) pipe in kind still parses (kind is the rejoined remainder)", () => {
    // Pre-escaping keys never had a pipe in target either, but if one existed in
    // kind the old parseKey rejoined the remainder — preserve that tolerance.
    assert.equal(parseKey("s|c|t|a|b").kind, "a|b");
  });
});

// The engine's sort is the one keying call outside the per-pack guard; prove it
// does not throw on a pipe-in-target finding (the exact #136 item 3 crash).
describe("runEngine does not crash on a pipe-in-path finding", () => {
  test("a pack emitting a pipe-in-target finding sorts cleanly, no throw", async () => {
    const { runEngine } = await import("../src/kernel/engine.ts");
    const pipePack = {
      id: "test_pack",
      run: () => [
        { script: "test_pack", check: "X", target: "Notes/--skip | olano.dev.md", kind: "", detail: "pipe in path" },
        { script: "test_pack", check: "X", target: "Notes/plain.md", kind: "", detail: "no pipe" },
      ],
    };
    const snapshot = { notes: [], paths: [] };
    const findings = runEngine([pipePack], snapshot); // must NOT throw
    assert.equal(findings.length, 2);
    assert.ok(findings.some((f) => f.target === "Notes/--skip | olano.dev.md"));
  });
});
