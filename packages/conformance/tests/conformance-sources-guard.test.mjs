/**
 * conformance-sources-guard.test.mjs — #125 item 1.
 *
 * `VaultSnapshot.sources` / `.blueprints` are optional, and every pack that
 * needs them wrote `snapshot.sources ?? []`. A snapshot built WITHOUT a sources
 * listing therefore made those packs report zero findings — indistinguishable
 * from a clean vault, and the ratchet then reports every one of that pack's
 * accepted keys as CLEARED.
 *
 * This is the absence-vs-emptiness class, which by this point has bitten this
 * codebase in four separate subsystems: a missing baseline read as an empty one
 * (#133), an absent quickadd `data.json` reported as CONFORMING (#136), an
 * unparseable frontmatter block read as no frontmatter (#104's residual), and
 * here. The distinction that matters is ABSENT vs EMPTY: `[]` is a real answer
 * ("this vault has no source files") and must keep working; `undefined` is the
 * absence of an answer and must refuse.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runEngine, ENGINE_ID } from "../src/kernel/engine.ts";
import { portPack, stePack, structurePack, driftPack } from "../src/kernel/packs/index.ts";
import { LEGACY_CONVENTIONS_SEED as SEED } from "../src/kernel/vault-conventions.ts";

const PACKS = [
  ["port_lint", portPack],
  ["ste_lint", () => stePack(SEED)],
  ["conformance_check", () => structurePack({ conventions: SEED })],
  ["drift_audit", () => driftPack(SEED)],
];

const base = { notes: [], paths: [] };

describe("#125 — an ABSENT sources listing refuses; an EMPTY one is a real answer", () => {
  for (const [id, make] of PACKS) {
    test(`${id}: snapshot with NO sources listing surfaces pack_error, not zero findings`, () => {
      const findings = runEngine([make()], { ...base });
      const errs = findings.filter((f) => f.script === ENGINE_ID && f.check === "pack_error");
      assert.equal(errs.length, 1, `${id} must refuse an absent listing`);
      assert.equal(errs[0].target, id);
      // Assert the REFUSAL, not merely that something errored. Mutation-checked:
      // disabling the guard makes the packs iterate `undefined` and CRASH, which
      // the engine also reports as pack_error — so a bare "a pack_error appeared"
      // assertion passes against a broken implementation. The message is what
      // distinguishes a deliberate refusal from an incidental TypeError.
      assert.match(errs[0].detail, /sources|blueprints/i, "names the missing listing");
      assert.match(errs[0].detail, /absent|missing/i, "says the listing is ABSENT, not merely that something failed");
      assert.doesNotMatch(errs[0].detail, /undefined is not|not iterable|Cannot read/i, "must not be an incidental crash");
    });

    test(`${id}: snapshot with an EMPTY sources listing runs cleanly (empty is a real answer)`, () => {
      const findings = runEngine([make()], {
        ...base,
        // No `obsidianConfig`: no pack reads it since #412 retired drift's A and B.
        sources: [], blueprints: [], files: [], dirs: [], walkOrder: [],
      });
      const errs = findings.filter((f) => f.script === ENGINE_ID && f.check === "pack_error");
      assert.deepEqual(errs, [], `${id} must accept a genuinely empty listing`);
    });
  }

  test("structurePack distinguishes an absent BLUEPRINTS listing specifically", () => {
    const findings = runEngine([structurePack({ conventions: SEED })], { ...base, sources: [] });
    const errs = findings.filter((f) => f.check === "pack_error");
    assert.equal(errs.length, 1, "sources present but blueprints absent must still refuse");
    assert.match(errs[0].detail, /blueprints/i);
    assert.doesNotMatch(errs[0].detail, /undefined is not|not iterable|Cannot read/i);
  });

  test("the refusal is per-pack: one broken pack does not suppress the others", () => {
    const findings = runEngine([portPack(), stePack(SEED)], { ...base });
    const errs = findings.filter((f) => f.check === "pack_error");
    assert.deepEqual(errs.map((e) => e.target).sort(), ["port_lint", "ste_lint"]);
    for (const e of errs) assert.match(e.detail, /absent|missing/i, "each must be a refusal, not a crash");
  });
});
