import assert from "node:assert/strict";
import { test } from "node:test";
import { jdProvider, DEFAULT_JD_CONFIG } from "../src/kernel/scheme/jd.js";
import { FIXTURE_JD_CONFIG } from "./scheme-fixture.mjs";
import { planAssign, planRefile, planRenumber } from "../src/kernel/scheme/mutate.js";

const p = jdProvider(FIXTURE_JD_CONFIG);
const NOTES = [
  "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
  "00-09 System/06 Agent tooling/06.12 Bridge.md",
];

test("planAssign computes the next free id and a move into the category folder", () => {
  const scope = { kind: "category", token: "06" };
  const out = planAssign(p, scope, "Unfiled/New thing.md", NOTES);
  assert.equal(out.ok, true);
  // nextFree returns the lowest free content decimal (floor 10), which is 06.10
  // when 06.11 and 06.12 are already used.
  assert.equal(out.result.address, "06.10");
  assert.deepEqual(out.result.step, {
    from: "Unfiled/New thing.md",
    to: "00-09 System/06 Agent tooling/06.10 New thing.md",
  });
});

test("planAssign reports exhaustion distinctly from never-allocatable", () => {
  const full = Array.from({ length: 90 }, (_, i) => `X/06.${10 + i} Filler.md`).concat(NOTES);
  const out = planAssign(p, { kind: "category", token: "06" }, "Unfiled/New.md", full);
  assert.equal(out.ok, false);
  assert.match(out.error, /exhaust/i);
});

test("planRefile is a no-op when already correctly filed", () => {
  const out = planRefile(p, NOTES[0], NOTES);
  assert.equal(out.ok, true);
  assert.equal(out.result.alreadyCorrect, true);
  assert.equal(out.result.step, null);
});

test("planRefile moves a misfiled note to its expected folder", () => {
  const misfiled = [...NOTES, "Wrong Place/06.13 Misfiled.md"];
  const out = planRefile(p, "Wrong Place/06.13 Misfiled.md", misfiled);
  assert.equal(out.ok, true);
  assert.equal(out.result.alreadyCorrect, false);
  assert.deepEqual(out.result.step, {
    from: "Wrong Place/06.13 Misfiled.md",
    to: "00-09 System/06 Agent tooling/06.13 Misfiled.md",
  });
});

test("planRefile refuses a note with no address", () => {
  const out = planRefile(p, "Unfiled/loose.md", [...NOTES, "Unfiled/loose.md"]);
  assert.equal(out.ok, false);
  assert.match(out.error, /no address/i);
});

test("planRenumber: target free, single step", () => {
  const to = p.parse("06.13");
  const out = planRenumber(p, NOTES[0], to, NOTES, "fail");
  assert.equal(out.ok, true);
  assert.equal(out.result.steps.length, 1);
  assert.equal(out.result.displaced, null);
  assert.deepEqual(out.result.steps[0], {
    from: NOTES[0],
    to: "00-09 System/06 Agent tooling/06.13 Vault MCP.md",
  });
});

test("planRenumber: target occupied, onOccupied 'fail' refuses", () => {
  const to = p.parse("06.12");
  const out = planRenumber(p, NOTES[0], to, NOTES, "fail");
  assert.equal(out.ok, false);
  assert.match(out.error, /occupied/i);
});

test("planRenumber: target occupied, 'auto' displaces occupant first then moves source", () => {
  const to = p.parse("06.12");
  const out = planRenumber(p, NOTES[0], to, NOTES, "auto");
  assert.equal(out.ok, true);
  assert.equal(out.result.steps.length, 2);
  assert.equal(out.result.steps[0].from, NOTES[1]); // occupant moves first
  assert.equal(out.result.steps[1].from, NOTES[0]); // source moves second, into the now-vacant slot
  assert.equal(out.result.displaced, out.result.steps[0].to);
});

test("planRenumber: target occupied, 'manual' without displace_to refuses", () => {
  const to = p.parse("06.12");
  const out = planRenumber(p, NOTES[0], to, NOTES, "manual");
  assert.equal(out.ok, false);
  assert.match(out.error, /displace_to/);
});

test("planRenumber: target occupied, 'manual' with a taken displace_to refuses", () => {
  const to = p.parse("06.12");
  const displaceTo = p.parse("06.11"); // NOTES[0] itself — occupied
  const out = planRenumber(p, NOTES[0], to, NOTES, "manual", displaceTo);
  assert.equal(out.ok, false);
  assert.match(out.error, /also occupied/);
});

// ── finding #1: renumbering a note to the address it already has ────────────
// occupantOf(to, notes) can return the SOURCE note itself (a retry of a
// renumber that already succeeded). Before the fix, "fail" reported a bogus
// "occupied by <itself>" error and "auto"/"manual" built a two-step plan whose
// first step's `from` is the same file the second step also tries to move —
// the second step would fail against a path that no longer exists. The
// correct behavior in all three modes is a no-op success.

for (const mode of ["fail", "auto", "manual"]) {
  test(`planRenumber: renumbering to the address the note already has is a no-op success ('${mode}')`, () => {
    const to = p.parse("06.11"); // NOTES[0]'s own current address
    const displaceTo = mode === "manual" ? p.parse("06.50") : undefined;
    const out = planRenumber(p, NOTES[0], to, NOTES, mode, displaceTo);
    assert.equal(out.ok, true, out.ok ? undefined : out.error);
    assert.deepEqual(out.result, { steps: [], displaced: null });
  });
}

// ── finding #7: displace_to === to is rejected under 'manual' ───────────────

test("planRenumber: 'manual' with displace_to equal to `to` is refused with a clear error", () => {
  const to = p.parse("06.12"); // occupied by NOTES[1]
  const displaceTo = p.parse("06.12"); // same as `to`
  const out = planRenumber(p, NOTES[0], to, NOTES, "manual", displaceTo);
  assert.equal(out.ok, false);
  assert.match(out.error, /displace_to must differ from to/);
});
