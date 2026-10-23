// The soft conformance gate (#230 gate + Nelson's 2026-08-19 soft/hard/off ruling).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { acceptNote, AcceptGateError } from "../src/kernel/accept.ts";
import { governanceAcceptanceSettings } from "../src/kernel/settings.ts";

const NOTE = "---\nacceptance-status: proposed\ntitle: T\n---\n\n# T\nbody\n";

function fakeDeps(overrides = {}) {
  let content = NOTE;
  const log = [];
  return {
    deps: {
      readNote: async () => content,
      store: { setBaseline: async (path, c, by, ts) => ({ path, hash: "h" + c.length, acceptedBy: by, acceptedAt: ts }) },
      appendLog: async (r) => { log.push(r); },
      now: () => "2026-08-19T12:00:00Z",
      user: "Nelson",
      requiredFrontmatterKeys: ["uid", "description"],
      ...overrides,
    },
    log,
  };
}

describe("gateMode settings coercion", () => {
  test("soft is the default; hard/off pass through; junk coerces to soft", () => {
    assert.equal(governanceAcceptanceSettings({}).gateMode, "soft");
    assert.equal(governanceAcceptanceSettings({ gateMode: "hard" }).gateMode, "hard");
    assert.equal(governanceAcceptanceSettings({ gateMode: "off" }).gateMode, "off");
    assert.equal(governanceAcceptanceSettings({ gateMode: "nonsense" }).gateMode, "soft");
  });
});

describe("acceptNote gateOverride", () => {
  test("without override: missing keys throw AcceptGateError naming them, nothing written", async () => {
    const { deps, log } = fakeDeps();
    await assert.rejects(
      () => acceptNote(deps, "N.md"),
      (e) => e instanceof AcceptGateError && e.missing.includes("uid") && e.missing.includes("description"),
    );
    assert.equal(log.length, 0);
  });

  test("with gateOverride: the same note advances its baseline, and the note is not edited", async () => {
    const { deps, log } = fakeDeps();
    const res = await acceptNote(deps, "N.md", { gateOverride: true });
    assert.equal(res.baseline.hash, "h" + NOTE.length);
    assert.equal(log.length, 1);
  });

  test("override is per-call only — an overridden accept does not stop the next plain call gating", async () => {
    const { deps } = fakeDeps();
    await acceptNote(deps, "N.md", { gateOverride: true });
    await assert.rejects(() => acceptNote(deps, "N.md"), AcceptGateError); // gate is back
  });
});
