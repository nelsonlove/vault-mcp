/**
 * conformance-golive.test.mjs — #116: the conformance CLI's gate default and
 * its rebaseline guard.
 *
 * Two defects this pins, both measured live on the restored baseline:
 *
 * 1. The legacy gate was INVERTED relative to the baseline it is measured
 *    against. The accepted-debt baseline's keys are exclusively legacy-pack
 *    keys, and the legacy packs defaulted OFF — so the default run cleared the
 *    ENTIRE baseline (124 of 124) on every invocation. A pack set that cannot
 *    produce any of the baseline's keys is not a conservative default, it is a
 *    guaranteed false "everything was fixed" report.
 *
 * 2. `PHASE1_PACKS_INCOMPLETE` was a hardcoded `true` whose stated reason
 *    ("drift_audit is unported") became FALSE when the drift pack landed. A
 *    constant that encodes a fact about the pack set has to be COMPUTED from
 *    the pack set, or it goes stale silently and starts refusing (or, worse,
 *    permitting) for a reason that no longer holds.
 *
 * The refusal is deliberately NOT reduced to pack coverage alone: rebaselining
 * the live baseline re-accepts current findings, and acceptance is human-only.
 * Coverage is an ADDITIONAL check that also protects fixture baselines.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { baselinePackIds, rebaselineRefusal } from "../src/kernel/cli.ts";
import { LEGACY_CONVENTIONS_SEED as SEED } from "../src/kernel/vault-conventions.ts";

const KEYS = (...k) => new Set(k);

describe("baselinePackIds — which packs the accepted debt actually describes", () => {
  test("reads the pack id from each key's first field", () => {
    const ids = baselinePackIds(KEYS("drift_audit|E|uid|dup-uid", "ste_lint|editable|x.md|", "drift_audit|J|y|"));
    assert.deepEqual([...ids].sort(), ["drift_audit", "ste_lint"]);
  });

  test("an empty baseline names no packs", () => {
    assert.deepEqual([...baselinePackIds(new Set())], []);
  });

  test("a malformed key contributes no pack rather than throwing", () => {
    assert.deepEqual([...baselinePackIds(KEYS("no-pipes-here"))], ["no-pipes-here"]);
  });
});

describe("rebaselineRefusal — the computed guard replacing PHASE1_PACKS_INCOMPLETE", () => {
  const covered = { baselinePackIds: KEYS("drift_audit"), registeredPackIds: KEYS("drift_audit", "vocab_findings") };

  test("REFUSES a baseline pack that is not registered, naming it (accepted debt would be erased)", () => {
    const r = rebaselineRefusal({
      targetsLiveBaseline: false,
      baselinePackIds: KEYS("drift_audit", "ste_lint"),
      registeredPackIds: KEYS("drift_audit"),
    });
    assert.ok(r, "must refuse");
    assert.match(r, /ste_lint/, "names the uncovered pack");
    assert.doesNotMatch(r, /drift_audit/, "does not name a covered pack");
  });

  test("the uncovered-pack refusal applies to a FIXTURE baseline too, not just the live one", () => {
    const r = rebaselineRefusal({
      targetsLiveBaseline: false,
      baselinePackIds: KEYS("port_lint"),
      registeredPackIds: new Set(),
    });
    assert.match(r ?? "", /port_lint/);
  });

  test("REFUSES the live baseline even when every pack is covered — rebaselining is an acceptance act", () => {
    const r = rebaselineRefusal({ targetsLiveBaseline: true, ...covered });
    assert.ok(r, "must refuse");
    assert.match(r, /human/i, "states the acceptance-is-human-only reason");
    assert.doesNotMatch(r, /drift_audit is unported|unported/i, "not the stale drift_audit reason");
  });

  test("PERMITS a fixture baseline whose packs are all registered", () => {
    assert.equal(rebaselineRefusal({ targetsLiveBaseline: false, ...covered }), null);
  });

  test("is at least as strict as the old constant: the live baseline is never permitted", () => {
    for (const registered of [new Set(), KEYS("drift_audit"), KEYS("drift_audit", "ste_lint", "port_lint")]) {
      const r = rebaselineRefusal({ targetsLiveBaseline: true, baselinePackIds: KEYS("drift_audit"), registeredPackIds: registered });
      assert.ok(r, "live baseline must be refused for every pack set");
    }
  });
});

/**
 * PR #139 review fixes (@assent-module-worker-3, both Criticals reproduced).
 *
 * The unifying defect in Critical 1: the guard decided over a PROXY for the
 * thing (the shape of argv) instead of the thing itself (which file gets
 * written) — structurally the same mistake as an accept-guard scanning a
 * normalized copy instead of the bytes that land.
 */
// REMOVED (#144): the `isLiveBaseline` suite that lived here.
//
// It asserted over SYNTHETIC, non-existent paths (`/vault/...`), so
// `realpathSync` threw on every single case and only the `resolve()` string
// comparison was ever exercised — the symlink half the implementation
// advertised had ZERO coverage while the suite reported green. Worse, the
// property it pinned ("decided over the file written, not argv shape") was
// FALSE: it decided over `join(resolve(root), BASELINE_REL)`, and `root` is
// caller-controlled, so pointing `--root` elsewhere laundered the live record.
//
// Replaced by tests/conformance-baseline-identity.test.mjs, which drives the
// real `runCli` against REAL files on disk and is mutation-verified: each
// bypass test was confirmed to FAIL against the pre-#144 implementation, so
// none of them can pass vacuously the way these did.

describe("coverageRefusal — applies to plain runs, not just rebaseline (Critical 2)", () => {
  test("a run whose baseline names an unmeasured pack REFUSES rather than reporting CONFORMING", async () => {
    const { coverageRefusal } = await import("../src/kernel/cli.ts");
    const r = coverageRefusal(new Set(["ste_lint"]), new Set(["vocab_findings"]), "run");
    assert.ok(r, "must refuse — otherwise exit 0 while clearing accepted debt");
    assert.match(r, /ste_lint/);
    assert.match(r, /CLEARED|clearing/, "names the false-green consequence");
  });

  test("full coverage permits the run", async () => {
    const { coverageRefusal } = await import("../src/kernel/cli.ts");
    assert.equal(coverageRefusal(new Set(["ste_lint"]), new Set(["ste_lint", "vocab_findings"]), "run"), null);
  });

  test("an empty baseline (e.g. --no-baseline) names no packs, so nothing is uncovered", async () => {
    const { coverageRefusal } = await import("../src/kernel/cli.ts");
    assert.equal(coverageRefusal(new Set(), new Set(), "run"), null);
  });
});

describe("coveredPackIds — a pack that THREW is not 'covered' (Important)", () => {
  test("a crashing pack is excluded from coveredPackIds, so its accepted keys cannot be dropped", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const pth = (await import("node:path")).default;
    const { runConformance, coverageRefusal } = await import("../src/kernel/cli.ts");
    const root = await mkdtemp(pth.join(tmpdir(), "conf-throw-"));
    try {
      const res = await runConformance({ root, conventions: SEED, baselineText: "", vocabularies: [], schemes: [], legacyPacks: true });
      // every registered pack that did not throw is covered; the sets agree when nothing threw
      assert.ok(res.packIds.length > 0, "packs registered");
      assert.ok(res.coveredPackIds.every((id) => res.packIds.includes(id)), "covered is a subset of registered");
      // a baseline naming a pack that is registered-but-errored must still refuse
      const asIfErrored = new Set(res.coveredPackIds.filter((id) => id !== "ste_lint"));
      assert.ok(coverageRefusal(new Set(["ste_lint"]), asIfErrored, "--rebaseline"), "errored pack must not count as covered");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
