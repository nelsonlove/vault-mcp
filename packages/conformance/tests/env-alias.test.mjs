/**
 * env-alias.test.mjs — the GOVERNOR_* / ASSENT_* env-var alias contract
 * (0.12.0 naming unification, part 3), at the conformance rail's call sites.
 * (Moved from the host with the rail on 2026-10-14; the precedence contract of
 * `envAliased` itself stays pinned in packages/host/tests/env-alias.test.mjs,
 * since the host's survey reads it too.)
 *
 * Every conformance env knob is read through envAliased:
 * GOVERNOR_<X> is primary; the pre-rename ASSENT_<X> spelling is a fallback
 * alias. Pinned: GOVERNOR_ wins when both are set; a set-but-empty GOVERNOR_
 * value still wins (it does not fall through to the legacy spelling); the
 * real call sites honor the alias in both directions.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptedByFrom,
  baselineRelFrom,
  excludedRootsFrom,
  rootDiscoveryRefusal,
  staleAfterFrom,
  registerDirFrom,
  debtBudgetFrom,
  inAppBaselineRel,
  inAppBaselineRefusal,
  inAppBaselineFromEnv,
} from "../src/kernel/cli.ts";
import { conventionsFromEnv, EMPTY_VAULT_CONVENTIONS } from "../src/kernel/vault-conventions.ts";

describe("real call sites honor the alias", () => {
  test("acceptedByFrom: GOVERNOR_ACCEPTED_BY wins over ASSENT_ACCEPTED_BY", () => {
    assert.equal(acceptedByFrom([], { GOVERNOR_ACCEPTED_BY: "Nelson", ASSENT_ACCEPTED_BY: "other" }), "Nelson");
    assert.equal(acceptedByFrom([], { ASSENT_ACCEPTED_BY: "legacy-human" }), "legacy-human");
    assert.equal(acceptedByFrom([], {}), "human");
  });

  test("baselineRelFrom: both spellings, GOVERNOR_ first", () => {
    assert.equal(baselineRelFrom({ GOVERNOR_BASELINE_REL: "A.md", ASSENT_BASELINE_REL: "B.md" }), "A.md");
    assert.equal(baselineRelFrom({ ASSENT_BASELINE_REL: "B.md" }), "B.md");
  });

  // #493: the plugin ships no baseline path (Nelson, 2026-10-03: "No folder
  // names are ever in the live code"). The order is the env override, then the
  // vault conventions' baselineRel, then "" (none configured) — never a constant.
  test("baselineRelFrom order (#493): env override > conventions.baselineRel > \"\"", () => {
    const conv = { baselineRel: "  Conv/Base.md  " };
    assert.equal(baselineRelFrom({ GOVERNOR_BASELINE_REL: "Env.md" }, conv), "Env.md", "the env override wins over the setting");
    assert.equal(baselineRelFrom({ ASSENT_BASELINE_REL: "Old.md" }, conv), "Old.md", "the legacy spelling is an override too");
    assert.equal(baselineRelFrom({}, conv), "Conv/Base.md", "no override: the setting, trimmed");
    assert.equal(baselineRelFrom({ GOVERNOR_BASELINE_REL: "   " }, conv), "Conv/Base.md", "a blank override falls through to the setting");
    assert.equal(baselineRelFrom({}, { baselineRel: "  " }), "", "a blank setting is none configured");
    assert.equal(baselineRelFrom({}, EMPTY_VAULT_CONVENTIONS), "", "EMPTY conventions: none configured");
    assert.equal(baselineRelFrom({}, null), "");
    assert.equal(baselineRelFrom({}), "", "nothing configured anywhere: \"\", not a shipped default");
  });

  // In-app (#494 review) the order is the other way round: the plugin's own
  // setting first, the env override only when the setting is blank.
  test("inAppBaselineRel: the setting beats the env override; the env is read only when the setting is blank", () => {
    const keys = ["GOVERNOR_BASELINE_REL", "ASSENT_BASELINE_REL"];
    const saved = keys.map((k) => [k, process.env[k]]);
    try {
      for (const k of keys) delete process.env[k];
      process.env.GOVERNOR_BASELINE_REL = "Env.md";
      assert.equal(inAppBaselineRel({ baselineRel: " Set.md " }), "Set.md", "the setting wins, trimmed");
      assert.equal(inAppBaselineRel({ baselineRel: "  " }), "Env.md", "a blank setting falls to the env");
      assert.equal(inAppBaselineRel(null), "Env.md");
      assert.equal(inAppBaselineRel(undefined), "Env.md");
      delete process.env.GOVERNOR_BASELINE_REL;
      process.env.ASSENT_BASELINE_REL = "Old.md";
      assert.equal(inAppBaselineRel({ baselineRel: "" }), "Old.md", "the legacy env spelling too");
      delete process.env.ASSENT_BASELINE_REL;
      assert.equal(inAppBaselineRel({ baselineRel: "" }), "", "nothing anywhere: none configured");
    } finally {
      for (const [k, v] of saved) if (v !== undefined) process.env[k] = v; else delete process.env[k];
    }
  });

  test("inAppBaselineRefusal: none configured, missing note, or null", () => {
    assert.match(inAppBaselineRefusal("", false), /^no conformance baseline is configured/);
    assert.match(inAppBaselineRefusal("", true), /^no conformance baseline is configured/, "no path wins over exists");
    assert.match(inAppBaselineRefusal("R/B.md", false), /^the conformance baseline note is missing: 'R\/B\.md'/);
    assert.equal(inAppBaselineRefusal("R/B.md", true), null);
    assert.equal(inAppBaselineRefusal("R/B.md", true, true), null);
  });

  test("inAppBaselineRefusal names where to fix it: none → the setting OR the env; missing → the env when fromEnv, else the setting", () => {
    const none = inAppBaselineRefusal("", false);
    assert.match(none, /the Vault MCP Conformance plugin's settings/);
    assert.match(none, /GOVERNOR_BASELINE_REL in Obsidian's environment/, "the none message also names the env override");
    const fromSetting = inAppBaselineRefusal("R/B.md", false);
    assert.match(fromSetting, /\(the Vault MCP Conformance plugin's settings name it\)/);
    assert.doesNotMatch(fromSetting, /GOVERNOR_BASELINE_REL/);
    assert.equal(inAppBaselineRefusal("R/B.md", false, false), fromSetting, "fromEnv defaults to false");
    const fromEnv = inAppBaselineRefusal("R/B.md", false, true);
    assert.match(fromEnv, /^the conformance baseline note is missing: 'R\/B\.md'/);
    assert.match(fromEnv, /GOVERNOR_BASELINE_REL in Obsidian's environment names it/);
    assert.doesNotMatch(fromEnv, /Conformance plugin's settings name it/);
  });

  test("inAppBaselineFromEnv: true only when the setting is blank AND the env override is set", () => {
    const keys = ["GOVERNOR_BASELINE_REL", "ASSENT_BASELINE_REL"];
    const saved = keys.map((k) => [k, process.env[k]]);
    try {
      for (const k of keys) delete process.env[k];
      assert.equal(inAppBaselineFromEnv({ baselineRel: "" }), false, "nothing set");
      assert.equal(inAppBaselineFromEnv({ baselineRel: "Set.md" }), false);
      process.env.GOVERNOR_BASELINE_REL = "Env.md";
      assert.equal(inAppBaselineFromEnv({ baselineRel: "  " }), true, "blank setting, env set");
      assert.equal(inAppBaselineFromEnv(null), true);
      assert.equal(inAppBaselineFromEnv(undefined), true);
      assert.equal(inAppBaselineFromEnv({ baselineRel: "Set.md" }), false, "the setting wins, so the path is not from the env");
      process.env.GOVERNOR_BASELINE_REL = "   ";
      assert.equal(inAppBaselineFromEnv({ baselineRel: "" }), false, "a blank override is no override");
      delete process.env.GOVERNOR_BASELINE_REL;
      process.env.ASSENT_BASELINE_REL = "Old.md";
      assert.equal(inAppBaselineFromEnv({ baselineRel: "" }), true, "the legacy spelling");
    } finally {
      for (const [k, v] of saved) if (v !== undefined) process.env[k] = v; else delete process.env[k];
    }
  });

  test("excludedRootsFrom: both spellings", () => {
    assert.deepEqual(excludedRootsFrom([], { GOVERNOR_EXCLUDED_ROOTS: "A, B", ASSENT_EXCLUDED_ROOTS: "C" }), ["A", "B"]);
    assert.deepEqual(excludedRootsFrom([], { ASSENT_EXCLUDED_ROOTS: "C" }), ["C"]);
  });

  test("staleAfterFrom / registerDirFrom / debtBudgetFrom: legacy spelling still works", () => {
    assert.equal(staleAfterFrom([], { ASSENT_STALE_AFTER_DAYS: "30" }), 30);
    assert.equal(staleAfterFrom([], { GOVERNOR_STALE_AFTER_DAYS: "10", ASSENT_STALE_AFTER_DAYS: "30" }), 10);
    assert.equal(registerDirFrom([], { ASSENT_REGISTER_DIR: "/r" }), "/r");
    assert.equal(registerDirFrom([], { GOVERNOR_REGISTER_DIR: "/g", ASSENT_REGISTER_DIR: "/r" }), "/g");
    assert.equal(debtBudgetFrom([], { ASSENT_DEBT_BUDGET: "5" }), 5);
    assert.equal(debtBudgetFrom([], { GOVERNOR_DEBT_BUDGET: "2", ASSENT_DEBT_BUDGET: "5" }), 2);
  });

  test("rootDiscoveryRefusal: either content-root spelling suffices; either opt-in spelling suffices", () => {
    assert.equal(rootDiscoveryRefusal([], { GOVERNOR_CONTENT_ROOT: "/v" }), null);
    assert.equal(rootDiscoveryRefusal([], { ASSENT_CONTENT_ROOT: "/v" }), null);
    assert.equal(rootDiscoveryRefusal([], { GOVERNOR_ALLOW_ROOT_DISCOVERY: "1" }), null);
    assert.equal(rootDiscoveryRefusal([], { ASSENT_ALLOW_ROOT_DISCOVERY: "1" }), null);
    const refusal = rootDiscoveryRefusal([], {});
    assert.ok(refusal, "no root and no opt-in must refuse");
    assert.match(refusal, /GOVERNOR_CONTENT_ROOT/);
    assert.match(refusal, /ASSENT_CONTENT_ROOT/, "the refusal names the legacy spelling too");
  });

  test("the conventions knob left the GOVERNOR_/ASSENT_ alias family (#403): it is VAULT_MCP_CONVENTIONS, with the two old spellings as warned legacy reads — pinned in vault-conventions.test.mjs", () => {
    const g = JSON.stringify({ ungovernedRoots: ["G"] });
    const a = JSON.stringify({ ungovernedRoots: ["A"] });
    assert.deepEqual(conventionsFromEnv({ GOVERNOR_VAULT_CONVENTIONS: g, ASSENT_VAULT_CONVENTIONS: a }, () => {}).ungovernedRoots, ["G"]);
    assert.deepEqual(conventionsFromEnv({ ASSENT_VAULT_CONVENTIONS: a }, () => {}).ungovernedRoots, ["A"]);
    assert.deepEqual(conventionsFromEnv({}, () => {}), EMPTY_VAULT_CONVENTIONS, "unset is EMPTY: there is no default any more");
  });
});
