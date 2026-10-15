import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { newSchemeDrift } from "../src/kernel/drift-view.ts";
import { ratchet } from "../src/kernel/ratchet.ts";
import { findingKey } from "../src/kernel/finding.ts";

const F = (script, check, target, kind = "", detail = "") => ({ script, check, target, kind, detail });

describe("newSchemeDrift", () => {
  test("recovers full detail for a scheme-pack finding that's NEW per the ratchet", () => {
    const findings = [F("scheme_findings", "misfiled", "06 Foo/bar.md", "", "lives outside its expected folder")];
    const result = ratchet(findings, new Set());
    const groups = newSchemeDrift(findings, result);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].check, "misfiled");
    assert.equal(groups[0].findings.length, 1);
    assert.equal(groups[0].findings[0].detail, "lives outside its expected folder");
  });

  test("a finding already in the baseline (carried, not new) is excluded", () => {
    const findings = [F("scheme_findings", "misfiled", "06 Foo/bar.md")];
    const baseline = new Set([findingKey(findings[0])]);
    const result = ratchet(findings, baseline);
    assert.deepEqual(newSchemeDrift(findings, result), []);
  });

  test("a NEW key from a different pack is silently skipped — this view is scheme-only", () => {
    const findings = [F("vocab_findings", "unregistered_tag", "some/note.md")];
    const result = ratchet(findings, new Set());
    assert.deepEqual(newSchemeDrift(findings, result), []);
  });

  test("groups by check, largest group first", () => {
    const findings = [
      F("scheme_findings", "misfiled", "a.md"),
      F("scheme_findings", "misfiled", "b.md"),
      F("scheme_findings", "malformed_name", "c.md"),
    ];
    const result = ratchet(findings, new Set());
    const groups = newSchemeDrift(findings, result);
    assert.deepEqual(groups.map((g) => g.check), ["misfiled", "malformed_name"]);
    assert.equal(groups[0].findings.length, 2);
  });

  test("ties in group size break alphabetically by check", () => {
    const findings = [
      F("scheme_findings", "unaddressed", "z.md"),
      F("scheme_findings", "malformed_name", "a.md"),
    ];
    const result = ratchet(findings, new Set());
    const groups = newSchemeDrift(findings, result);
    assert.deepEqual(groups.map((g) => g.check), ["malformed_name", "unaddressed"]);
  });

  test("within a group, findings are ordered by target", () => {
    const findings = [
      F("scheme_findings", "misfiled", "z.md"),
      F("scheme_findings", "misfiled", "a.md"),
    ];
    const result = ratchet(findings, new Set());
    const groups = newSchemeDrift(findings, result);
    assert.deepEqual(groups[0].findings.map((f) => f.target), ["a.md", "z.md"]);
  });

  test("a mix of scheme and non-scheme NEW findings only surfaces the scheme ones", () => {
    const findings = [
      F("scheme_findings", "misfiled", "a.md"),
      F("vocab_findings", "unregistered_tag", "b.md"),
      F("conformance_check", "some-legacy-check", "c.md"),
    ];
    const result = ratchet(findings, new Set());
    const groups = newSchemeDrift(findings, result);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].check, "misfiled");
  });

  test("no findings at all returns an empty array", () => {
    const result = ratchet([], new Set());
    assert.deepEqual(newSchemeDrift([], result), []);
  });

  test("cleared findings (in baseline but no longer live) don't appear — this view is NEW-only", () => {
    const liveFindings = [];
    const baseline = new Set([findingKey(F("scheme_findings", "misfiled", "gone.md"))]);
    const result = ratchet(liveFindings, baseline);
    assert.deepEqual(newSchemeDrift(liveFindings, result), []);
  });
});
