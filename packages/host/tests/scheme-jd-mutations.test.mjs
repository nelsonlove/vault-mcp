import assert from "node:assert/strict";
import { test } from "node:test";
import { jdProvider, DEFAULT_JD_CONFIG } from "../src/kernel/scheme/jd.js";
import { FIXTURE_JD_CONFIG } from "./scheme-fixture.mjs";

const NOTES = [
  "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
  "00-09 System/06 Agent tooling/06.12 Bridge.md",
  "Unfiled/loose note.md",
];
const p = jdProvider(FIXTURE_JD_CONFIG);

test("occupantOf finds the claimant", () => {
  const addr = p.parse("06.11");
  const occ = p.occupantOf(addr, NOTES);
  assert.deepEqual(occ, { path: NOTES[0], address: "06.11" });
});

test("occupantOf returns null when nothing claims the address", () => {
  const addr = p.parse("06.13");
  assert.equal(p.occupantOf(addr, NOTES), null);
});

test("occupantOf: first match wins on a duplicate", () => {
  const dup = [...NOTES, "Somewhere else/06.11 Duplicate.md"];
  const addr = p.parse("06.11");
  assert.equal(p.occupantOf(addr, dup)?.path, NOTES[0]);
});

test("titleOf strips a leading address token", () => {
  assert.equal(p.titleOf("00-09 System/06 Agent tooling/06.11 Vault MCP.md"), "Vault MCP");
});

test("titleOf on a note with no address returns the whole basename", () => {
  assert.equal(p.titleOf("Unfiled/loose note.md"), "loose note");
});

test("titleOf on a malformed-but-numeric-looking token still strips only a real address", () => {
  // "06.1" is not a valid two-or-three-digit decimal — not an address, so
  // nothing is stripped.
  assert.equal(p.titleOf("Somewhere/06.1 Not Quite An Id.md"), "06.1 Not Quite An Id");
});

// ── finding #1 (code-review PR #214): titleOf must strip the WHOLE leading
// decorated token — the address token PLUS an Extend-the-End "+YYYY" suffix
// immediately following it — not just the bare address token. Before the
// fix, titleOf sliced only `token.length` (5, for "43.11") off the full
// name "43.11+2024 Foo", leaving "+2024 Foo" as the reported title instead
// of "Foo".

test("titleOf strips an Extend-the-End +YYYY suffix along with the address token", () => {
  assert.equal(p.titleOf("00-09 System/06 Agent tooling/43.11+2024 Foo.md"), "Foo");
});

test("titleOf on an Extend-the-End note with no title after the suffix returns empty", () => {
  assert.equal(p.titleOf("00-09 System/06 Agent tooling/43.11+2024.md"), "");
});

test("titleOf on a bare-addressed note (no +YYYY suffix) is unaffected by the fix", () => {
  assert.equal(p.titleOf("00-09 System/06 Agent tooling/06.11 Vault MCP.md"), "Vault MCP");
});

test("titleOf on an unaddressed note is unaffected by the fix", () => {
  assert.equal(p.titleOf("Unfiled/loose note.md"), "loose note");
});
