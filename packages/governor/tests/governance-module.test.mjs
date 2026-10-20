/**
 * governance-module.test.mjs — THE ACCEPT-UNREACHABILITY TRIPWIRE, now inside the provider.
 *
 * It asserts, with the accept surface actually present in the source tree, that NONE of
 * performAccept / setBaseline / runGuardedAdopt / setClassEnabled / stampAcceptedFrontmatter is
 * reachable from any of:
 *   - the plugin instance (no instance method / no this.<member>),
 *   - the view/tab instance (controller held in a module-private WeakMap),
 *   - the settings tab (it hands over a container and receives nothing),
 *   - this plugin's published agent-facing tool surface (src/tools/*.ts + main.ts's publishTools
 *     call), which never names an accept-path callable,
 * and that every pane Accept/Revert/Adopt/allowlist/authority button is addEventListener-wired (so
 * its `.onclick` stays null) and gates on isRealGesture. The DEFINITIVE proof is the deploy-time
 * LIVE reachability walk (pane.ts/wiring.ts import the obsidian runtime, types-only in the test
 * env, so the classes cannot be instantiated headlessly); this source-level tripwire is what
 * catches a regression BEFORE that live check.
 *
 * ── WHAT S3c DID TO THIS FILE, AND WHY EACH DELETION IS NOT A THINNING ──────────────────────
 *
 * THE ACCEPTANCE MODULE NO LONGER EXISTS. It left the host's module registry entirely: it never
 * contributed an MCP tool (its registrar was a no-op on the transport), and all it ever carried
 * was an `enabled` flag and a config block for a pane that lived somewhere else. Both halves are
 * this package's own now — `src/settings.ts` (`GovernorSettings.enabled` / `.config`, read from
 * the same `data.json` the pre-split plugin wrote) and `src/settings-tab.ts`.
 *
 * So the module-registry half of the old tripwire — "declared as a capability module, default off",
 * "contributes ZERO MCP tools when enabled", "collect() renders a config section", "the registry
 * REFUSES a governance-shaped module", "mountHost's ctx is {getSettings, visible} only" — is not
 * weakened here, it is UNSTATEABLE here: there is no module row, no manifest, no `collect()`, no
 * mount host and no `fake-server.mjs` in this package. The host's side of the fact is pinned where
 * it belongs, in `packages/host/tests/modules-mount.test.mjs`: a surviving `modules.acceptance` row
 * is an UNKNOWN id, reported as a problem and never mounted. Reproducing a host assertion from a
 * package that cannot import the host is how a suite grows two copies of one claim that drift.
 *
 * Each removed block carries its reason inline below, at the point where it used to sit, so a
 * reader diffing against the pre-split file finds the accounting rather than a hole.
 *
 * ── INSTRUMENT DISCIPLINE ───────────────────────────────────────────────────────────────────
 *
 * Every scan in this file is exercised against a planted violation before it is trusted against
 * the real tree. A source scan that silently matches nothing is worse than no scan: it reads as
 * coverage in the suite output while asserting the empty set.
 *
 * Headless: this file imports only pure provider modules (`kernel/settings.ts`,
 * `kernel/dispositions.ts`, `tools/pending-review.ts`) — none of which needs the obsidian runtime.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(here, "..");
const srcDir = path.join(pkgDir, "src");
const readRaw = (rel) => fs.readFileSync(path.join(srcDir, rel), "utf8");
// Strip comments so identifiers named only in the (extensive) invariant docs don't false-match.
function code(rel) {
  return readRaw(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/([^:])\/\/[^\n]*/g, "$1")
    .replace(/^\/\/[^\n]*/gm, "");
}

/**
 * The provider's AGENT-FACING TOOL LAYER — the successor to the old `mcp/server.ts` +
 * `mcp/tools-*.ts` sweep. Those were host files; this package's equivalent is `src/tools/`, whose
 * specs main.ts hands to `publishTools`. It is the only source in this package an agent's request
 * can reach, so it is the tree the accept-path names must be absent from.
 */
function providerToolFiles() {
  const dir = path.join(srcDir, "tools");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => `tools/${f}`);
}

/** The forbidden-surface matcher. DELIBERATELY BROADER than the host registry's own built-in
 * tripwire (accept/approve/baseline): it also names `adopt` and `setClassEnabled` — the cycle-2
 * accept-path verbs that fragment list does NOT catch. Asserting the provider's ACTUAL published
 * surface against THIS is what makes the tripwire load-bearing. */
const FORBIDDEN = /accept|baseline|adopt|approve|setclassenabled|set_class_enabled/i;

// ---------------------------------------------------------------------------
// DROPPED AT S3c — `governance module: shape + default-off`
// DROPPED AT S3c — `governance module: contributes ZERO MCP tools when enabled`
// DROPPED AT S3c — `governance module: renders a config-tab section`
//
// All three asserted properties of a row in the HOST's module registry: its posture, its
// default-off flag, its empty `tools` array on `collect()`, its rendered field list. There is no
// such row. `builtinModules`, `collect`, `ModuleRegistry`, `mountModules` and `mountHost` are host
// exports this package cannot import, and the flag/config they carried are now
// `GovernorSettings.enabled` / `.config` (src/settings.ts), whose default-off and legacy-read
// behaviour is the subject of the settings tests, not of a module manifest.
//
// The one fact worth keeping from them — that a stale `modules.acceptance` row in the shared
// `data.json` must not be mounted as a module — is host-side and is pinned in
// `packages/host/tests/modules-mount.test.mjs` ("a surviving modules.acceptance row is an UNKNOWN
// id, not a mount"). It is not restated here.
// ---------------------------------------------------------------------------

describe("provider settings tab: config keys match what the pane actually reads", () => {
  // RETARGETED, claim unchanged. This used to compare the module manifest's declared field keys
  // against `governanceDisplaySettings` + `governanceAcceptanceSettings`. The manifest is gone and
  // the fields are hand-rendered by `src/settings-tab.ts` now — which is a WEAKER arrangement than
  // a generated section, because a hand-written control can name a key nothing reads and nothing
  // would notice. The claim is therefore the same and matters more: every key the settings tab
  // WRITES into `settings.config` is a key one of the two readers READS, and vice versa. A drift
  // either way is a control that controls nothing, or a setting with no way to set it.

  /** Keys the tab writes: the literal `settings.config.<key> =` assignments, plus the keys handed
   * to the `toggleField` helper (which writes through a computed `config[key]`, invisible to the
   * first pattern — the exact shape a single-pattern scan would miss). */
  function keysWrittenByTab(src) {
    const literal = [...src.matchAll(/this\.plugin\.settings\.config\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]);
    const viaHelper = [...src.matchAll(/this\.toggleField\(\s*containerEl,\s*"([^"]+)"/g)].map((m) => m[1]);
    return { literal, viaHelper, all: new Set([...literal, ...viaHelper]) };
  }

  /** Keys the coercers read out of the untrusted config record. Read from the SOURCE rather than
   * from `Object.keys(DEFAULT_*)`, so a default declared but never read (or a key read but never
   * defaulted) is caught rather than assumed away. */
  function keysReadByCoercers(src) {
    return new Set([...src.matchAll(/\bc\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  }

  test("VACUITY: both scans find a planted key, and each finds the form the other cannot", () => {
    const planted = keysWrittenByTab(`
      this.toggleField(
        containerEl,
        "plantedToggle",
        "n", "d");
      this.plugin.settings.config.plantedLiteral = value;
    `);
    assert.deepEqual(planted.literal, ["plantedLiteral"]);
    assert.deepEqual(planted.viaHelper, ["plantedToggle"]);
    assert.deepEqual(keysWrittenByTab("nothing here"), { literal: [], viaHelper: [], all: new Set() });
    assert.deepEqual([...keysReadByCoercers("const x = c.plantedRead;")], ["plantedRead"]);
    assert.equal(keysReadByCoercers("no reads").size, 0);
  });

  test("the tab's written keys ARE the governanceDisplaySettings + governanceAcceptanceSettings keys", async () => {
    const { DEFAULT_GOVERNANCE_SETTINGS, DEFAULT_ACCEPTANCE_SETTINGS } = await import("../src/kernel/settings.ts");
    const written = keysWrittenByTab(code("settings-tab.ts"));
    // Non-vacuous on the real file: both write forms are in use, so neither pattern is dead.
    assert.ok(written.viaHelper.length >= 2, "the tab must still write badge toggles through toggleField");
    assert.ok(written.literal.length >= 3, "the tab must still write the acceptance fields directly");

    // `guardedTerritories` is deliberately NOT here any more (#397): the tab must
    // not write a key this plugin does not own. The list moved to the HOST, whose
    // capture writes note bodies outside the vault and runs without this plugin;
    // the tab now renders it read-only from the host's api and writes nothing. If
    // a territories field is ever re-added here this assertion fails, which is the
    // intended alarm — two editable copies is the drift EXCLUDED_PREFIXES was
    // centralized to prevent.
    const readers = [...Object.keys(DEFAULT_GOVERNANCE_SETTINGS), ...Object.keys(DEFAULT_ACCEPTANCE_SETTINGS)];
    assert.deepEqual([...written.all].sort(), [...readers].sort());

    // And the defaults ARE read: every key the two DEFAULT_ objects declare
    // is actually consulted by the coercers, so a default cannot become
    // decorative.
    const read = keysReadByCoercers(code("kernel/settings.ts"));
    for (const key of readers) assert.ok(read.has(key), `${key} is defaulted but never read out of the config`);
  });

  test("the tab's rendered defaults are the coercers' defaults (an untouched config renders what the pane will use)", async () => {
    const {
      governanceDisplaySettings,
      governanceAcceptanceSettings,
      DEFAULT_GOVERNANCE_SETTINGS,
      DEFAULT_ACCEPTANCE_SETTINGS,
    } = await import("../src/kernel/settings.ts");
    const tab = code("settings-tab.ts");
    // Toggles render `config[key] !== false`, i.e. default ON — which is what the coercer does.
    assert.match(tab, /this\.plugin\.settings\.config\[key\] !== false/, "toggles must default ON in the tab");
    assert.equal(DEFAULT_GOVERNANCE_SETTINGS.showRibbonBadge, true);
    assert.equal(DEFAULT_GOVERNANCE_SETTINGS.showViewTabBadge, true);
    // The gate-mode dropdown's own fallback literal must be the coercer's default, spelled once
    // here and once there — the only pair in this surface where a drift would be silent.
    assert.match(tab, /config\.gateMode as string\)\s*:\s*"soft"/, "the dropdown falls back to soft");
    assert.equal(DEFAULT_ACCEPTANCE_SETTINGS.gateMode, "soft");
    // The accepted-by placeholder is taken from the constant rather than retyped.
    assert.match(tab, /DEFAULT_ACCEPTANCE_SETTINGS\.acceptedBy/, "the placeholder must come from the constant");

    // End-to-end: what a field persists is what the readers read back.
    assert.equal(governanceDisplaySettings({ showRibbonBadge: false }).showRibbonBadge, false);
    assert.equal(governanceDisplaySettings({ showRibbonBadge: false }).showViewTabBadge, true);
    assert.equal(governanceAcceptanceSettings({ acceptedBy: "nelson" }).acceptedBy, "nelson");
    assert.deepEqual(
      governanceAcceptanceSettings({ requiredFrontmatterKeys: ["uid", "title"] }).requiredFrontmatterKeys,
      ["uid", "title"],
    );
    // The tab writes the csv field as a string[]; the coercer accepts that shape unchanged.
    assert.match(code("settings-tab.ts"), /requiredFrontmatterKeys = value\s*\n?\s*\.split\(","\)/);
  });
});

describe("governance module: THE TRIPWIRE — source reachability (accept surface present)", () => {
  // A class METHOD is `<indent><modifiers?> name(` (inside a class body). A module function is
  // `function name(` at column 0. This matcher fires ONLY on an instance method.
  function isInstanceMethod(src, name) {
    return new RegExp(
      `(?:^|\\n)[ \\t]+(?:private |public |protected |readonly |static |get |set )*(?:async )?${name}\\s*\\(`,
    ).test(src);
  }
  const referencesThisMember = (src, name) => new RegExp(`\\bthis\\.${name}\\b`).test(src);

  // The accept-equivalent capabilities. None may be an instance method, a this.<member>, or named
  // by the published tool layer. Each exists ONLY as a module-scope function / WeakMap value
  // reached through a gesture-gated pane handler. (The accepted-family stamp,
  // `stampAcceptedFrontmatter`, was removed by #599; the test below pins that nothing writes
  // those keys.)
  const ACCEPT_EQUIVALENT = [
    "performAccept", "performRevert", "performAdopt", "setClassEnabled", "reconcile",
    "getStore", "setBaseline", "acceptNote", "revertNote",
  ];

  // KEPT FROM THE RETIRED `structural (module + registry)` BLOCK. The other four tests in that
  // block were about the host registry (a hostile module's tools being refused, the mount host's
  // two-key ctx, the manifest directory's declared names) and went with it; this one is the
  // vacuity proof for FORBIDDEN, which is still the matcher every published-surface scan below
  // runs. Without it a typo in the regex would silently pass every one of them.
  test("the matcher has teeth (it would catch the accept verbs, incl. ones a fragment list misses)", () => {
    for (const bad of [
      "obsidian_accept_note",
      "obsidian_adopt_baseline",
      "obsidian_advance_baseline",
      "governance_setClassEnabled",
      "obsidian_approve_change",
    ]) {
      assert.ok(FORBIDDEN.test(bad), `matcher failed to catch ${bad}`);
    }
    assert.ok(!FORBIDDEN.test("governance_pending_review"));
    assert.ok(!FORBIDDEN.test("governance_submit_revision"));
  });

  test("wiring.ts: the accept-equivalent capabilities are module-scope, not instance methods or this.<member>", () => {
    const wiring = code("wiring/wiring.ts");
    for (const name of ACCEPT_EQUIVALENT) {
      assert.ok(!isInstanceMethod(wiring, name), `${name} must NOT be an instance method`);
      assert.ok(!referencesThisMember(wiring, name), `this.${name} must not exist (would be reachable from app)`);
    }
    // The accept-path capabilities ARE declared as module-scope functions.
    for (const fn of ["performAccept", "performRevert", "performAdopt", "reconcile", "setClassEnabled"]) {
      assert.match(wiring, new RegExp(`\\n(?:async )?function ${fn}\\s*\\(`), `${fn} must be a module-scope function`);
    }
  });

  test("wiring.ts: the baseline store lives in a module-private WeakMap, never this.store", () => {
    const wiring = code("wiring/wiring.ts");
    assert.ok(!/\bthis\.store\b/.test(wiring), "store must not be this.store (would be reachable)");
    assert.match(wiring, /const baselineStores = new WeakMap</, "the store must be held in a module-private WeakMap");
  });

  test("wiring.ts: registers ZERO commands (a command is agent-invokable via obsidian_run_command)", () => {
    const wiring = code("wiring/wiring.ts");
    assert.ok(!/\baddCommand\b/.test(wiring), "the governance wiring must register no command");
  });

  test("wiring.ts: onLayoutReady is disposed-guarded so an unmount/unload never leaks an auto-accept poll", () => {
    // The poll interval created in onLayoutReady runs pollJournal → sweepAutoAccept → setBaseline
    // (it advances baselines). onLayoutReady returns no EventRef, so if the mount is torn down in the
    // onload→layout-ready window the register-cleanups have already flushed and an interval created
    // afterward is never cleared — a leaked auto-accept poll on a disposed mount. The callback must
    // be gated on a disposed flag flipped by the child Component's register cleanup (the live-mount
    // teardown: `plugin.removeChild` on toggle-off, or the plugin's own unload — the wireUidIndex
    // disposed-flag pattern, scoped to the mount's Component).
    const wiring = code("wiring/wiring.ts");
    assert.match(wiring, /let disposed = false;/, "must track a disposed flag");
    assert.match(wiring, /component\.register\(\(\) => \{[\s\S]*?disposed = true;/, "cleanup hook must flip disposed");
    const m = /onLayoutReady\(async \(\) => \{([\s\S]*?)\n  \}\);/.exec(wiring);
    assert.ok(m, "onLayoutReady callback must exist");
    assert.match(m[1], /if \(disposed\) return;/, "onLayoutReady must bail when disposed");
    assert.match(m[1], /registerInterval/, "the poll interval is created inside onLayoutReady");
  });

  test("pane.ts: the controller lives in a module-private WeakMap, never on the instance", () => {
    const pane = code("wiring/pane.ts");
    assert.ok(!/\bthis\.controller\b/.test(pane), "no this.controller (would be reachable)");
    assert.ok(!/(private|readonly)\s+controller\b/.test(pane), "no controller instance field on the view");
    assert.match(pane, /const viewDeps = new WeakMap</, "deps held in a module-private WeakMap");
    assert.match(pane, /viewDeps\.set\(this,/, "constructor stows deps in the WeakMap");
  });

  test("pane.ts: EVERY legacy accept-class control is gated on the cutover — offered, or omitted, never dead", () => {
    // The 2026-08-24 incident: Nelson cut over, clicked Accept, and got
    // `legacy_writer_disabled`. The refusal was right; offering the control was
    // not. The context menu was fixed first, and an independent review then
    // found the pane doing the SAME thing — rendering live Accept/Revert
    // buttons directly above its own notice saying Accept is disabled.
    const pane = code("wiring/pane.ts");

    // The Proposed section's accept is not created at all once retired.
    assert.match(
      pane,
      /if \(!\(deps\.legacyRetired\?\.\(\) \?\? false\)\) \{\s*\n\s*const proposedAcceptBtn/,
      "the Proposed-section Accept must be inside a legacyRetired guard",
    );

    // The queue detail's accept + revert are removed once retired.
    const detailGuard = /if \(deps\.legacyRetired\?\.\(\) \?\? false\) \{[\s\S]{0,400}?acceptBtn\.remove\(\);[\s\S]{0,200}?revertBtn\.remove\(\);/;
    assert.match(pane, detailGuard, "the queue-detail Accept and Revert must be removed when legacy is retired");

    // Request-changes is deliberately NOT retired — it advances no baseline.
    assert.ok(
      !/legacyRetired[\s\S]{0,200}?requestBtn\.remove\(\)/.test(pane),
      "request-changes advances no baseline and must survive the cutover",
    );
  });

  test("VACUITY: the cutover-gate scan can fail — it is not matching on prose", () => {
    // Strip the guards and every assertion above must stop matching. Without
    // this, a regex drifting to match a comment would keep the suite green
    // while the buttons went back to being live.
    const stripped = code("wiring/pane.ts")
      .replace(/if \(!\(deps\.legacyRetired\?\.\(\) \?\? false\)\) \{\s*\n\s*const proposedAcceptBtn/g, "const proposedAcceptBtn")
      .replace(/acceptBtn\.remove\(\);/g, "")
      .replace(/revertBtn\.remove\(\);/g, "");
    assert.ok(!/if \(!\(deps\.legacyRetired\?\.\(\) \?\? false\)\) \{\s*\n\s*const proposedAcceptBtn/.test(stripped));
    assert.ok(!/acceptBtn\.remove\(\);/.test(stripped));
  });

  test("pane.ts: every accept-class button is addEventListener-wired, NEVER via .onclick = (so .onclick stays null)", () => {
    const pane = code("wiring/pane.ts");
    // WP9's three mandate controls are on this list because activation GRANTS
    // PROSPECTIVE AUTHORITY — a stronger act than a single admission — and
    // revoke/decline are human dispositions on the same surface. (Review of
    // #356: the buttons shipped correctly wired but unpinned; an onclick
    // rewrite of Activate survived the whole suite. Guard-exists-path-
    // doesn't-run, the family's canonical shape.)
    for (const el of [
      "acceptBtn", "revertBtn", "adoptBtn", "checkbox", "confirm", "proposedAcceptBtn", "proposedRequestBtn",
      "activateBtn", "revokeBtn", "declineBtn",
      // WP10a: promote arms automatic admission; demote is the brake — both authority-class.
      "promoteBtn", "demoteBtn",
    ]) {
      assert.ok(!new RegExp(`\\b${el}\\.onclick\\s*=`).test(pane),
        `${el}.onclick = … is the forgeable wiring — must use addEventListener`);
    }
    assert.match(pane, /activateBtn\.addEventListener\(\s*["']click["']/, "mandate Activate via addEventListener");
    assert.match(pane, /revokeBtn\.addEventListener\(\s*["']click["']/, "mandate Revoke via addEventListener");
    assert.match(pane, /declineBtn\.addEventListener\(\s*["']click["']/, "mandate Decline via addEventListener");
    assert.match(pane, /promoteBtn\.addEventListener\(\s*["']click["']/, "promotion Promote via addEventListener");
    assert.match(pane, /demoteBtn\.addEventListener\(\s*["']click["']/, "promotion Demote via addEventListener");
    assert.match(pane, /acceptBtn\.addEventListener\(\s*["']click["']/, "accept via addEventListener");
    assert.match(pane, /revertBtn\.addEventListener\(\s*["']click["']/, "revert via addEventListener");
    // The Proposed section's two controls (#221/#164) keep the same wiring discipline.
    assert.match(pane, /proposedAcceptBtn\.addEventListener\(\s*["']click["']/, "Proposed-section accept via addEventListener");
    assert.match(pane, /proposedRequestBtn\.addEventListener\(\s*["']click["']/, "Proposed-section request-changes via addEventListener");
    // Adopt is now wired by the SHARED wireAdoptButton helper (one implementation, shared with the
    // settings-tab render). That helper wires via `btn.addEventListener('click', …)` — never
    // `.onclick =` — and the pane hands it `adoptBtn`. Both facts are asserted so the adopt wiring
    // stays addEventListener-only across the refactor.
    assert.match(pane, /export function wireAdoptButton\(/, "wireAdoptButton is the shared adopt wiring");
    assert.match(pane, /btn\.addEventListener\(\s*["']click["']/, "wireAdoptButton wires via addEventListener");
    assert.match(pane, /wireAdoptButton\(\s*\n?\s*adoptBtn/, "the pane wires its adopt button via wireAdoptButton");
    assert.match(pane, /checkbox\.addEventListener\(\s*["']click["']/, "allowlist checkbox via addEventListener");
    assert.match(pane, /confirm\.addEventListener\(\s*["']click["']/, "modal confirm via addEventListener");
  });

  test("pane.ts: every accept-class handler gates on isRealGesture (directly or via runGuardedAdopt)", () => {
    const paneRaw = readRaw("wiring/pane.ts");
    assert.match(paneRaw, /isRealGesture/, "the pane must use the isRealGesture gate");
    // accept/revert handlers gate directly on isRealGesture — including the Proposed
    // section's converged Accept and Request-changes (#221/#164).
    const lines = paneRaw.split("\n");
    // runGuardedDisposition IS the shared gesture gate (gesture.ts: "THE ONE
    // SHARED GESTURE GATE"; its first line is the isRealGesture check), so a
    // handler routing through it is gated — the tripwire accepts the shared
    // gate by name, same as it always accepted runGuardedAdopt (its wrapper).
    // admitBtn is on the list because ADMISSION advances standing — the §9
    // authority act — and the WP6b-2 revert button shares revertBtn's name.
    for (const el of ["acceptBtn", "revertBtn", "proposedAcceptBtn", "proposedRequestBtn", "admitBtn", "activateBtn", "revokeBtn", "declineBtn", "promoteBtn", "demoteBtn"]) {
      let found = false;
      for (let i = 0; i < lines.length; i++) {
        if (new RegExp(`${el}\\.addEventListener\\(`).test(lines[i])) {
          assert.match(
            lines.slice(i, i + 5).join("\n"),
            /isRealGesture|runGuardedDisposition|runGuardedAdopt/,
            `${el} handler must gate on isRealGesture (directly or via the shared gate)`
          );
          found = true;
        }
      }
      assert.ok(found, `${el} must be wired with addEventListener`);
    }
    // adopt gates via runGuardedAdopt (which checks isRealGesture); the allowlist checkbox gates
    // via deps.setClassEnabled (whose body checks isRealGesture — asserted below).
    assert.match(paneRaw, /runGuardedAdopt/, "adopt must go through runGuardedAdopt");
  });

  test("wiring.ts: setClassEnabled (the auto-accept allowlist mutator) gates on isRealGesture", () => {
    const wiringRaw = readRaw("wiring/wiring.ts");
    const m = /async function setClassEnabled\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(wiringRaw);
    assert.ok(m, "setClassEnabled must be a module-scope function");
    // The refusal may carry the popout-incident Notice (2026-08-23) — the pin
    // is the GATE-then-refuse shape, not the exact statement body: the branch
    // must test !isRealGesture(evt) and its consequent must return false.
    assert.match(m[1], /if \(!isRealGesture\(evt\)\) \{?[^}\n]*return false;? ?\}?/,
      "setClassEnabled must refuse unless handed a real trusted gesture");
  });

  test("nothing in the governor wiring or kernel writes acceptance-status, accepted-by or accepted-on (#599)", () => {
    const wiring = code("wiring/wiring.ts");
    assert.ok(!/\bstampAcceptedFrontmatter\b/.test(wiring), "the stamp writer must be gone");
    assert.ok(!/\bstampAccepted\b/.test(wiring), "the stampAccepted dep must be gone");
    assert.ok(!/\bprocessFrontMatter\b/.test(wiring), "wiring.ts must make no processFrontMatter write at all");
    for (const rel of ["wiring/wiring.ts", "wiring/pane.ts", "kernel/accept.ts"]) {
      const raw = readRaw(rel);
      const writes = raw.match(/\bfm\[["'](?:acceptance-status|accepted-by|accepted-on)["']\]\s*=(?!=)/g) ?? [];
      assert.equal(writes.length, 0, `${rel} must not assign the retired keys`);
    }
    assert.ok(!/\bstampAccepted\b|AcceptanceStampFields/.test(readRaw("kernel/accept.ts")), "accept.ts must carry no stamp dep");
    // The published tool layer must reference NONE of the accept path. Pre-split this loop swept
    // the host's `mcp/server.ts` + `mcp/tools-*.ts`; the provider's equivalent agent-reachable
    // source is `src/tools/*.ts` plus the `publishTools` call in main.ts that hands them over.
    for (const rel of [...providerToolFiles(), "main.ts"]) {
      const src = code(rel);
      for (const name of [
        "stampAcceptedFrontmatter", "stampAccepted", "performAccept", "performAdopt",
        "runGuardedAdopt", "setClassEnabled", "acceptNote", "revertNote",
      ]) {
        assert.ok(!new RegExp(`\\b${name}\\b`).test(src), `${rel} must not reference the accept-path fn ${name}`);
      }
      assert.ok(!/kernel\/accept/.test(readRaw(rel)), `${rel} must not import the accept kernel module`);
    }
  });

  test("the converged accept clears the human-input record (the #228 race discipline extends to the stamp write)", () => {
    // The stamp is a programmatic write landing right after a human click (and possibly recent
    // typing in the same note's editor). A lingering genuine-human-input record would let the
    // debounced reconcile misattribute a subsequent unrelated agent write as a human edit.
    const wiringRaw = readRaw("wiring/wiring.ts");
    const m = /async function performAccept\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(wiringRaw);
    assert.ok(m, "performAccept body found");
    assert.match(m[1], /humanInputMap\(plugin\)\.delete\(path\)/, "performAccept must clear the human-input record");
    assert.match(m[1], /finally/, "the clear runs in finally — a partially-failed accept has still written");
  });
});

// ---------------------------------------------------------------------------
// REPLACING `the MCP transport imports nothing from src/governor/wiring/`.
//
// The first half of that test is now TRIVIALLY TRUE and was deleted for exactly that reason: the
// transport is in another package, so "server.ts does not import the pane" cannot fail, and an
// assertion that cannot fail is worse than none — it occupies a line in the suite output that a
// reader counts as coverage. What carries the weight now is the direction the package boundary
// does NOT enforce: `packages/governor` has no dependency on `packages/host`, but a RELATIVE
// specifier that escapes the package resolves fine on disk in a monorepo and would bundle happily.
// That is the scan below, and it is the provider-side half the host's own `host-layering.test.mjs`
// says lives here.
//
// The second half (pending-review is always-on read-only) is asserted against this package's own
// `buildPendingReviewTools` SPEC instead of against a `registerPendingReviewTools(server, …)` line
// in host source — a stronger subject, because it reads the shipped flag rather than a call site.
// ---------------------------------------------------------------------------
describe("provider layering: no relative specifier escapes packages/governor/src", () => {
  /** Static and dynamic import/export specifiers, including `import("…")` in type position. */
  const SPECIFIER = /(?:\bfrom|\bimport|\bexport)\s*\(?\s*["']([^"']+)["']/g;

  /**
   * @param files Map of package-relative path → source text.
   * @returns Map of offending file → sorted list of the escaping specifiers it uses.
   */
  function scanEscapingImports(files) {
    const out = new Map();
    for (const [rel, text] of files) {
      for (const m of text.matchAll(SPECIFIER)) {
        const spec = m[1];
        if (!spec.startsWith(".")) continue; // bare = a declared dependency, the sanctioned door
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
        if (resolved.startsWith("src/")) continue;
        if (!out.has(rel)) out.set(rel, new Set());
        out.get(rel).add(resolved);
      }
    }
    return new Map([...out].map(([k, v]) => [k, [...v].sort()]));
  }

  function realSources() {
    const files = new Map();
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".ts")) {
          files.set(path.relative(pkgDir, full).split(path.sep).join("/"), fs.readFileSync(full, "utf8"));
        }
      }
    };
    walk(srcDir);
    return files;
  }

  test("VACUITY: the scan FINDS a planted escape, and passes a clean tree", () => {
    const planted = scanEscapingImports(new Map([
      ["src/main.ts", 'import { Kernel } from "../../host/src/kernel/kernel.js";\n'],
      ["src/wiring/pane.ts", 'type T = import("../../../host/src/mcp/server.js").ServerCtx;\n'],
      ["src/kernel/ok.ts", 'import { x } from "../settings.js";\nimport { z } from "obsidian";\n'],
    ]));
    assert.deepEqual([...planted.keys()].sort(), ["src/main.ts", "src/wiring/pane.ts"]);
    // Reported package-root-relative, so an escape still READS as one: the leading `../` is the
    // package boundary being crossed, not noise to be normalized away.
    assert.deepEqual(planted.get("src/main.ts"), ["../host/src/kernel/kernel.js"]);
    assert.deepEqual(planted.get("src/wiring/pane.ts"), ["../host/src/mcp/server.js"]);
    assert.equal(scanEscapingImports(new Map([["src/a.ts", 'import "./b.js";\nimport "obsidian";\n']])).size, 0);
  });

  test("the scan sees the real tree (non-vacuous: it reads every .ts under src and finds real specifiers)", () => {
    const files = realSources();
    assert.ok(files.size > 60, `expected the whole provider tree, got ${files.size} files`);
    assert.ok(files.has("src/main.ts") && files.has("src/wiring/wiring.ts"));
    const anySpecifier = [...files.values()].some((t) => [...t.matchAll(SPECIFIER)].length > 0);
    assert.ok(anySpecifier, "the specifier regex matched nothing anywhere — the scan is dead");
  });

  test("the ONLY file reaching outside the package is the declaration one, and nothing under src imports it", () => {
    // ONE allowlisted crossing, and it is a declaration read by its test rather than by any shipped
    // code path — `kernel/operations/inventory-authority.ts` type-imports `ActionDefinition` /
    // `SurfaceBinding` and calls `compatibilityAction` from the host's operations registry. Its own
    // header argues the case: those three do not meet the S3c bar for publication into
    // `@vault-mcp/core` (byte-for-byte agreement between two plugins), and inventing a "contract"
    // for a single importer would be a bigger lie than a relative path a reader can follow. The
    // honest statement is that this is a TEST-TIME dependency on host source, and the second
    // assertion is what makes that statement true rather than aspirational.
    const escapes = scanEscapingImports(realSources());
    assert.deepEqual(
      [...escapes.keys()].sort(),
      ["src/kernel/operations/inventory-authority.ts"],
      "a NEW relative specifier escaped packages/governor/src — it resolves on disk in this monorepo and would " +
        "bundle, so the package boundary will not catch it; publish the shared part into @vault-mcp/core instead",
    );
    for (const spec of escapes.get("src/kernel/operations/inventory-authority.ts")) {
      assert.match(spec, /^\.\.\/host\/src\/kernel\/operations\//, `unexpected escape target: ${spec}`);
    }
    // The crossing costs the BUILT plugin nothing only while no shipped module imports the
    // declaration. If one ever does, the host tree walks into the provider's bundle.
    for (const [rel, text] of realSources()) {
      if (rel === "src/kernel/operations/inventory-authority.ts") continue;
      assert.ok(
        !/inventory-authority/.test(text),
        `${rel} imports the declaration file, dragging host source into the provider bundle`,
      );
    }
  });
});

describe("pending-review: always-on, read-only, and not accept-shaped", () => {
  test("the published spec is readOnly and carries no accept-shaped name", async () => {
    const { buildPendingReviewTools } = await import("../src/tools/pending-review.ts");
    const specs = buildPendingReviewTools({ source: { read: async () => null } });
    assert.ok(specs.length > 0, "buildPendingReviewTools published nothing — the assertions below are vacuous");
    for (const spec of specs) {
      assert.equal(spec.readOnly, true, `${spec.name} must be published read-only`);
      assert.ok(!FORBIDDEN.test(spec.name), `pending-review published a forbidden-named tool: ${spec.name}`);
    }
    // `governance_pending_review`, NOT `obsidian_pending_review` (Nelson, at S3c). The old
    // spelling branded a provider tool as a host built-in, which after the split is an
    // architectural lie, and keeping it would have required an `obsidian_*`-namespace carve-out in
    // the host's refusal — a permanent hole in a namespace-integrity rule, bought for one name.
    assert.deepEqual(specs.map((s) => s.name), ["governance_pending_review"]);
  });

  test("main.ts publishes it UNCONDITIONALLY — the review pane's toggle does not gate the read surface", () => {
    const main = code("main.ts");
    // One publishTools call, and buildPendingReviewTools is inside it.
    const publish = /publishTools\(this, \[([\s\S]*?)\n      \]\)/.exec(main);
    assert.ok(publish, "main.ts must hand its specs to publishTools");
    assert.match(publish[1], /buildPendingReviewTools\(/, "pending-review must be in the published set");
    // And `settings.enabled` — the pane toggle that used to be `modules.acceptance.enabled` —
    // guards ONLY the pane mount. Every occurrence in a conditional position is checked, so a
    // future `if (this.settings.enabled)` wrapped around the publish would fail here.
    const guards = [...main.matchAll(/if \(this\.settings\.enabled\)([^\n]*)/g)].map((m) => m[1]);
    assert.equal(guards.length, 1, "settings.enabled must guard exactly one thing");
    assert.match(guards[0], /setPaneMounted\(true\)/, "the only thing it guards is the pane mount");
  });

  test("the WHOLE published tool surface is free of accept-shaped names", () => {
    // The successor to "nothing forbidden reached the mounted MCP surface". Read from source rather
    // than by instantiating all five builders, so it covers the mandate and revision tools without
    // this file needing their runtime deps. Both spelling forms are collected: a string literal and
    // the one `name: SUBMIT_REVISION_TOOL` constant reference.
    const names = [];
    for (const rel of providerToolFiles()) {
      const src = code(rel);
      for (const m of src.matchAll(/^\s*name:\s*"([^"]+)"/gm)) names.push(m[1]);
      for (const m of src.matchAll(/^\s*name:\s*([A-Z][A-Z0-9_]*)\s*,/gm)) names.push(`<const ${m[1]}>`);
    }
    assert.ok(names.length >= 4, `expected the provider's published names, found ${names.length}`);
    assert.ok(names.includes("<const SUBMIT_REVISION_TOOL>"), "the submit-revision spec must still name its constant");
    for (const n of names) {
      if (n.startsWith("<const ")) continue;
      assert.ok(!FORBIDDEN.test(n), `a forbidden-named tool is published: ${n}`);
      // NAMESPACE INTEGRITY (Nelson, at S3c). Every tool this plugin publishes is in the
      // `governance_` family. The `obsidian_` prefix belongs to the host's own built-ins, and
      // `obsidian_pending_review` was renamed rather than carved out of the host's refusal —
      // an exception to a namespace rule is the precedent for the next exception.
      assert.match(n, /^governance_/, `a published tool escapes the governance_ namespace: ${n}`);
    }
  });

  test("SUBMIT_REVISION_TOOL's VALUE is checked too — a constant must not smuggle an accept verb past the scan", async () => {
    const { SUBMIT_REVISION_TOOL } = await import("../src/kernel/dispositions.ts");
    assert.equal(typeof SUBMIT_REVISION_TOOL, "string");
    assert.ok(SUBMIT_REVISION_TOOL.length > 0);
    assert.ok(!FORBIDDEN.test(SUBMIT_REVISION_TOOL), `the submit tool's name is accept-shaped: ${SUBMIT_REVISION_TOOL}`);
  });
});

describe("main.ts: the pane is reached ONLY through wireGovernance, behind settings.enabled", () => {
  // RETARGETED from the host's main.ts. The equivalent facts here are stronger, because this
  // plugin IS the perimeter: there is no host composition root to hide behind, so anything
  // accept-shaped on this class is directly `app.plugins.plugins.governor.<thing>`.
  function isInstanceMethod(src, name) {
    return new RegExp(
      `(?:^|\\n)[ \\t]+(?:private |public |protected |readonly |static |get |set )*(?:async )?${name}\\s*\\(`,
    ).test(src);
  }

  test("the pane mounts only via wireGovernance, gated on this.settings.enabled", () => {
    const main = code("main.ts");
    assert.match(main, /wireGovernance\(this,/, "main.ts wires the pane via wireGovernance");
    assert.match(main, /if \(this\.settings\.enabled\) void this\.setPaneMounted\(true\)/,
      "the mount at load is gated on the (default-off) enabled flag");
    // wireGovernance is CALLED in exactly one place — the reconciled mount path — so there is no
    // second, ungated route to a live controller. (Counted on the call form `wireGovernance(`;
    // the named import carries no parenthesis and is not counted.)
    assert.equal((main.match(/wireGovernance\(/g) ?? []).length, 1, "exactly one call site");
    assert.match(main, /import \{ wireGovernance,[^}]*\} from "\.\/wiring\/wiring\.js"/,
      "and it comes from the wiring module, not from a re-export that could widen");
  });

  test("the plugin class exposes no accept-shaped method and registers no command", () => {
    const main = code("main.ts");
    for (const name of [
      "performAccept", "performAdopt", "performRevert", "setBaseline", "acceptNote", "revertNote",
      "stampAcceptedFrontmatter", "setClassEnabled", "runGuardedAdopt", "getStore", "adopt", "accept",
    ]) {
      assert.ok(!isInstanceMethod(main, name), `${name} must not be a plugin instance method`);
    }
    assert.ok(!/addCommand\(/.test(readRaw("main.ts")), "the provider plugin registers no command at all");
  });

  test("the UI-deps factories live in module-level WeakMaps, never as plugin properties (§9)", () => {
    const main = code("main.ts");
    // Each factory builds an admit-/mandate-/promotion-capable deps object. Held on the instance,
    // renderer JS walking `app.plugins.plugins.governor` would find one and call it.
    for (const map of ["admissionFactories", "mandateUiFactories", "promotionUiFactories", "migrations"]) {
      assert.match(main, new RegExp(`^const ${map} = new WeakMap<`, "m"), `${map} must be a module-level WeakMap`);
      assert.ok(!new RegExp(`\\bthis\\.${map}\\b`).test(main), `this.${map} must not exist`);
      assert.ok(!new RegExp(`export\\s+(?:const|function)\\s+${map}\\b`).test(main), `${map} must not be exported`);
    }
    // They are read back only to build the argument object handed to wireGovernance — never
    // assigned onto the plugin or handed to anything else.
    assert.match(main, /admission: admissionFactories\.get\(this\)\?\.\(\)/);
    assert.match(main, /mandates: mandateUiFactories\.get\(this\)\?\.\(\)/);
    assert.match(main, /promotion: promotionUiFactories\.get\(this\)\?\.\(\)/);
    // The only exports are the settings default and the plugin class Obsidian must load.
    const exports = [...code("main.ts").matchAll(/^export\s+(?:default\s+)?(?:class|const|function)?\s*\{?\s*([A-Za-z_$][\w$]*)/gm)]
      .map((m) => m[1]);
    assert.deepEqual(exports.sort(), ["DEFAULT_GOVERNOR_SETTINGS", "GovernorPlugin"]);
  });

  test("the seam registration passes an observer and a refusal — nothing accept-shaped crosses", () => {
    // §3 of docs/suite-split-design.md: candidates flow outward, refusals flow inward, and the
    // type of the inward hook cannot express permission. Pinned as the shape of the registration
    // literal, because the two keys ARE the two classes.
    const main = code("main.ts");
    const reg = /registerGovernance\(this, \{([\s\S]*?)\n      \}\)/.exec(main);
    assert.ok(reg, "registerGovernance must be called with an object literal");
    const keys = [...reg[1].matchAll(/^\s{8}([A-Za-z][\w]*):/gm)].map((m) => m[1]);
    // `sessionRefusalPurposes` (vault-mcp-api 1.3) is a DECLARATION about the
    // refusal hook, not a hook: it is a list of strings, and it can only make
    // the host refuse more (no rotation without it).
    assert.deepEqual(keys.sort(), ["sessionRefusal", "sessionRefusalPurposes", "writeObserver"],
      "the seam must carry exactly the observer and the refusal (and its declaration) — another key is a new hook class");
    assert.match(reg[1], /sessionRefusalPurposes: \["rotate"\]/, "the declaration is a plain string list");
    for (const name of ["performAccept", "performAdopt", "setBaseline", "acceptNote", "setClassEnabled"]) {
      assert.ok(!new RegExp(`\\b${name}\\b`).test(reg[1]), `the seam registration must not name ${name}`);
    }
    // The registration is revocable: a plugin unload must drop both hooks, or a dead provider's
    // stores stay wired into a live host.
    assert.match(main, /this\.register\(\s*\n?\s*registerGovernance\(this,/, "the disposer goes to this.register");
  });
});

describe("history browser (#135): a READ-ONLY surface that confers nothing", () => {
  // The history browser reads the acceptance log and renders it. It must add NO accept surface:
  // no command, no published tool, no log-write path, and the tool layer must not grow a way to
  // reach the log reader. (The render path's text-node-only discipline is pinned behaviorally in
  // governance-history.test.mjs.)

  test("wiring.ts: readAcceptanceLog is module-scope, read-only (adapter.read), never a this.<member> or export", () => {
    const wiring = code("wiring/wiring.ts");
    assert.match(wiring, /\nasync function readAcceptanceLog\(/, "readAcceptanceLog must be a module-scope function");
    assert.ok(!/\bthis\.readAcceptanceLog\b/.test(wiring), "must not be an instance member");
    assert.ok(!/export\s+(?:async\s+)?function\s+readAcceptanceLog\b/.test(wiring), "must not be exported");
    // The one appendLog writer is unchanged; the history reader must never append.
    const m = /async function readAcceptanceLog\([\s\S]*?\n\}/.exec(wiring);
    assert.ok(m, "readAcceptanceLog body found");
    assert.ok(!/\.append\(|\.write\(/.test(m[0]), "the history reader must not write the log");
  });

  test("the kernel history module is import-reachable from the pane ONLY — never from the published tool layer", () => {
    for (const rel of [...providerToolFiles(), "main.ts"]) {
      assert.ok(!/kernel\/history\.js/.test(readRaw(rel)), `${rel} must not import the governance history module`);
      assert.ok(!/\breadAcceptanceLog\b/.test(code(rel)), `${rel} must not reference readAcceptanceLog`);
    }
    // The positive leg — without it the loop above would pass in a world where NOBODY imports the
    // reader. Asserted on the pane's actual import SPECIFIER: the pane's import is relative
    // (`../kernel/history.js`), so a path segment would survive only in prose, and a comment
    // pinning itself is not a pin.
    assert.match(
      readRaw("wiring/pane.ts"),
      /from ["']\.\.\/kernel\/history\.js["']/,
      "the pane renders the history",
    );
  });

  test("history adds no command and no history-named published tool", () => {
    // The pre-split form asserted this against the mounted MCP surface (the module contributed
    // zero tools). With no module there is no such surface to sweep; the equivalent subject is the
    // provider's own published names, which is where a history tool would have to appear.
    for (const rel of providerToolFiles()) {
      for (const m of code(rel).matchAll(/^\s*name:\s*"([^"]+)"/gm)) {
        assert.ok(!/history/i.test(m[1]), `no history tool may be published: ${m[1]}`);
      }
    }
    assert.ok(!/\baddCommand\b/.test(code("wiring/pane.ts")), "the pane registers no command");
  });
});

describe("#101 dispositions-as-data: THE TRIPWIRE — the wrap adds no reachable callable", () => {
  // The descriptor refactor wraps accept/revert/adopt's EXISTING wiring in declared data and adds
  // two new human dispositions (request-changes, withdraw) plus ONE agent tool
  // (governance_submit_revision). These tests pin that the refactor changed reachability NOWHERE:
  // descriptors are pure data, the new human verbs are gesture-only, and the only new agent
  // surface is the published tool built in src/tools/revision.ts.

  test("dispositions.ts is a pure-data leaf: no accept import, no accept-path reference, no obsidian import", () => {
    const d = code("kernel/dispositions.ts");
    assert.ok(!/^\s*import /m.test(readRaw("kernel/dispositions.ts")), "dispositions.ts must import nothing");
    for (const name of ["performAccept", "performAdopt", "acceptNote", "revertNote", "stampAcceptedFrontmatter", "setBaseline", "runGuardedAdopt"]) {
      assert.ok(!new RegExp(`\\b${name}\\b`).test(d), `dispositions.ts must not reference ${name}`);
    }
    assert.ok(!/from ["']obsidian["']/.test(readRaw("kernel/dispositions.ts")));
  });

  test("wiring.ts: performRequestChanges / performWithdraw are module-scope, never instance methods, this.<members>, or exports", () => {
    const wiring = code("wiring/wiring.ts");
    for (const fn of ["performRequestChanges", "performWithdraw", "listRevising", "listProposed"]) {
      assert.match(wiring, new RegExp(`\\n(?:async )?function ${fn}\\s*\\(`), `${fn} must be a module-scope function`);
      assert.ok(!new RegExp(`\\bthis\\.${fn}\\b`).test(wiring), `this.${fn} must not exist`);
      assert.ok(!new RegExp(`export\\s+(?:async\\s+)?function\\s+${fn}\\b`).test(wiring), `${fn} must NOT be exported`);
      assert.ok(!new RegExp(`export\\s+\\{[^}]*\\b${fn}\\b`).test(wiring), `${fn} must NOT be re-exported`);
    }
  });

  test("pane.ts: the request-changes and withdraw buttons are addEventListener-wired and isRealGesture-gated", () => {
    const paneRaw = readRaw("wiring/pane.ts");
    const pane = code("wiring/pane.ts");
    for (const el of ["requestBtn", "withdrawBtn"]) {
      assert.ok(!new RegExp(`\\b${el}\\.onclick\\s*=`).test(pane), `${el}.onclick = … is the forgeable wiring`);
      const lines = paneRaw.split("\n");
      let found = false;
      for (let i = 0; i < lines.length; i++) {
        if (new RegExp(`${el}\\.addEventListener\\(`).test(lines[i])) {
          assert.match(lines.slice(i, i + 5).join("\n"), /isRealGesture/, `${el} handler must gate on isRealGesture`);
          found = true;
        }
      }
      assert.ok(found, `${el} must be wired with addEventListener`);
    }
  });

  test("wiring.ts: NO menu-item onClick is accept-capable — each only opens the confirmation modal", () => {
    // A MenuItem handler can carry LAYER 2 (isRealGesture) but structurally cannot carry LAYER 1
    // (unreachability): `workspace.trigger("file-menu", <fake menu>, file, "…")` is public API, so
    // renderer-JS can hand this registration a stub menu that CAPTURES the onClick callback and
    // then calls it with a real, trusted MouseEvent kept from an earlier unrelated click. So the
    // menu path must reach the accept only THROUGH a modal whose own confirm button carries both
    // layers (pane.ts ConfirmModal: addEventListener + isRealGesture).
    const wiring = code("wiring/wiring.ts");
    const lines = wiring.split("\n");
    for (const evt of ['"file-menu"', '"files-menu"']) {
      assert.match(wiring, new RegExp(`workspace\\.on\\(${evt}`), `${evt} must be registered via plugin.app.workspace.on`);
    }
    // Any parameter name, optional `async` — a renamed parameter must not silently opt a handler
    // out of this tripwire. No fixed count either: EVERY onClick found is checked, so a third
    // menu item added later is covered without editing a number here.
    const onClick = /\.onClick\(\s*(?:async\s*)?\(\s*\w*\s*\)?/;
    let onClickCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!onClick.test(lines[i])) continue;
      onClickCount++;
      const body = lines.slice(i, i + 4).join("\n");
      // Deliberately NOT asserting isRealGesture on the menu callback. #299 added it as defence
      // in depth; a live smoke test on 0.15.0 (file explorer, left sidebar) then showed Obsidian
      // renders this as a NATIVE Electron menu whose onClick receives no DOM Event, so the check
      // rejected every real click and the item was inert. Asserting it here would pin the feature
      // broken. The invariant that matters is unchanged and enforced below: a menu callback may
      // hand off to the modal flow and may NOT reach an accept-capable call.
      assert.match(body, /runMenuAccept/, "menu item onClick must only hand off to the confirm-modal flow");
      // The accept-capable calls must NOT be reachable from the menu callback itself.
      assert.ok(!/acceptThroughGate|acceptViaMenu|\bdeps\.accept\b/.test(body),
        "a menu onClick must never call the accept path directly — it opens confirmMenuAccept instead");
    }
    assert.ok(onClickCount >= 2, "the single-file and multi-select Accept menu items must both be onClick-wired");
    // The hand-off itself: the batch confirm modal is the ONLY way the menu flow reaches accept.
    const flow = wiring.match(/const runMenuAccept[\s\S]{0,600}/);
    assert.ok(flow, "runMenuAccept must exist");
    assert.match(flow[0], /confirmMenuAccept\(/, "runMenuAccept must open the confirmation modal first");
    assert.match(flow[0], /if \(!confirmed\) return/, "an unconfirmed modal must accept nothing");
    // ONE modal for the whole batch, then per-file accepts (a per-file confirm would be both worse
    // UX and a different gate); the per-file loop is what keeps one failure from aborting the rest.
    assert.match(flow[0], /for \(const t of targets\) await acceptViaMenu\(/,
      "the confirmed batch runs the per-file accepts independently");
  });

  test("pane.ts: confirmMenuAccept routes through the addEventListener+isRealGesture ConfirmModal", () => {
    const pane = code("wiring/pane.ts");
    assert.match(pane, /export function confirmMenuAccept\(/, "the menu-accept confirmation must live in the pane");
    const fn = pane.match(/export function confirmMenuAccept\([\s\S]{0,900}/);
    assert.match(fn[0], /new ConfirmModal\(/, "it must reuse the gesture-gated ConfirmModal, not a bespoke dialog");
    // It must say Accept edits nothing (#599): no stamp, no accepted-by identity.
    assert.ok(!/acceptedBy|accepted-by/.test(fn[0]), "the confirmation must not promise a stamp");
    assert.match(fn[0], /not edited/, "the confirmation must say the note is not edited");
  });

  test("pane.ts: the request-changes modal's confirm button is gesture-gated like the adopt confirm", () => {
    const paneRaw = readRaw("wiring/pane.ts");
    // Both modal confirm buttons are named `confirm`; every one must be addEventListener-wired
    // (the shared .onclick tripwire above covers the forgeable form) and each addEventListener
    // handler must gate on isRealGesture within its opening lines.
    const lines = paneRaw.split("\n");
    let confirms = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/\bconfirm\.addEventListener\(/.test(lines[i])) {
        confirms++;
        assert.match(lines.slice(i, i + 4).join("\n"), /isRealGesture/, "modal confirm must gate on isRealGesture");
      }
    }
    assert.equal(confirms, 2, "both modals (adopt confirm + request-changes confirm) must be addEventListener-wired");
  });

  test("descriptors drive the render but carry NO callable: the pane reads only labels/ids from them", () => {
    const pane = code("wiring/pane.ts");
    // The pane renders from the declared set …
    assert.match(pane, /dispositionsFor\("pending-item"\)/);
    // … and never invokes anything ON a descriptor (data in, no capability out).
    assert.ok(!/\bd\.effect\s*\(/.test(pane), "descriptor.effect must never be called");
    assert.ok(!/\bd\.(run|handler|action|perform)\b/.test(pane), "descriptors must carry no handler-shaped member");
  });

  test("the published tool layer never references the revision GESTURE path (the two human verbs stay pane-only)", () => {
    for (const rel of [...providerToolFiles(), "main.ts"]) {
      const src = code(rel);
      // The module-scope gesture callables + the modal prompt — the names that would indicate the
      // tool layer had grown a way to reach the human dispositions. (Prose like a tool description's
      // "withdraw a revision request" is fine; these identifiers are not.)
      for (const name of ["performRequestChanges", "performWithdraw", "promptRequestChanges", "listRevising", "listProposed", "buildProposedList"]) {
        assert.ok(!new RegExp(`\\b${name}\\b`).test(src), `${rel} must not reference the gesture-path name ${name}`);
      }
    }
  });

  test("both disposition writes clear the human-input record — a modal keystroke must not launder a silent advance", () => {
    // performRequestChanges runs right after the human TYPED (in the modal). If the reviewed note
    // is also the active editor tab, that typing recorded genuine human input for the path, and
    // reconcile would misread the programmatic write as a human edit — silently baseline-advancing
    // the agent's unreviewed content without an Accept. Both writes must clear the record.
    const wiringRaw = readRaw("wiring/wiring.ts");
    for (const fn of ["performRequestChanges", "performWithdraw"]) {
      const m = new RegExp(`async function ${fn}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(wiringRaw);
      assert.ok(m, `${fn} body found`);
      assert.match(m[1], /humanInputMap\(plugin\)\.delete\(path\)/, `${fn} must clear the human-input record`);
    }
  });

  test("no command reaches the new dispositions (wiring/pane register zero commands — re-asserted post-#101)", () => {
    assert.ok(!/\baddCommand\b/.test(code("wiring/wiring.ts")));
    assert.ok(!/\baddCommand\b/.test(code("wiring/pane.ts")));
  });

  test("governance_submit_revision is the ONE agent-expressible disposition, and it is not accept-shaped", () => {
    // Pre-split this asserted that the tool registered in the host's server.ts rather than through
    // the governance module (which contributed zero tools). Post-split there is no module to
    // contrast with, so the surviving claim is the one that always mattered: the submit tool is
    // built in the tool layer, published like any other, and reaches ONLY the pure kernel
    // machinery — never the pane/wiring gesture path.
    const main = code("main.ts");
    assert.match(main, /buildRevisionTools\(/, "the revision tools are published from main.ts");
    const tool = readRaw("tools/revision.ts");
    assert.ok(!/from ["']\.\.\/wiring\/(pane|wiring)\.js["']/.test(tool), "the tool must not import the pane/wiring");
    assert.match(tool, /from ["']\.\.\/kernel\/revision\.js["']/, "it reaches the pure kernel revision module");
  });

  test("the submit tool structurally cannot write acceptance: only setAcceptanceStatusProposed writes status", () => {
    const revision = code("kernel/revision.ts");
    // The one status writer takes NO value parameter and hard-codes `proposed`.
    assert.match(revision, /export function setAcceptanceStatusProposed\(content: string\)/);
    assert.match(revision, /: proposed`/);
    assert.ok(!/accepted/.test(revision.replace(/acceptance[-_][sS]tatus/g, "")), "revision.ts must never name an accepted value");
    // And it must not reference the sanctioned accepted-writer.
    assert.ok(!/\bstampAcceptance\b/.test(revision));
  });
});

describe("governance settings-tab surface: the accept path stays module-private across the NEW home", () => {
  // The settings tab is a SECOND gesture-gated home for adopt-baseline + the auto-accept allowlist.
  // The invariant is unchanged: the file rendering the tab must never hold, receive, or be able to
  // walk an accept-capable callable. It does so by calling a render function `wiring.ts` exposes,
  // handing it only a container — the controls are built INSIDE that module from its own
  // module-private controller.
  //
  // WHAT THE SPLIT DID TO THIS ARGUMENT, stated plainly rather than as an upgrade: pre-split the
  // renderer was `connection-ui.ts`, in a different LAYER of the same plugin. It is now
  // `settings-tab.ts`, in the SAME PACKAGE as the controller — so the argument is weaker than it
  // was, not stronger. `settings-tab.ts`'s own header says the same thing. What holds the boundary
  // is what always held it: the module-private WeakMaps in wiring.ts and pane.ts, and the fact
  // that nothing accept-capable is exported. The tests below pin exactly that, and claim nothing
  // from the package layout.

  test("wiring.ts exposes renderGovernanceSettings as a module-scope function (not an accept export)", () => {
    const wiring = code("wiring/wiring.ts");
    assert.match(wiring, /export function renderGovernanceSettings\(\s*plugin[^,]*,\s*containerEl/,
      "renderGovernanceSettings(plugin, containerEl) must be the exposed entry point");
    // The accept-capable controller + its callables must NOT be exported — only the render fn and
    // the mount-state predicate leave the module. An `export` of any accept verb would let the
    // settings tab (or anything importing wiring) hold an accept callable directly.
    for (const name of ["buildController", "performAdopt", "performAccept", "performRevert", "setClassEnabled", "getStore"]) {
      assert.ok(!new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).test(wiring),
        `${name} must NOT be exported from wiring.ts (it would escape the module boundary)`);
      assert.ok(!new RegExp(`export\\s+\\{[^}]*\\b${name}\\b`).test(wiring),
        `${name} must NOT be re-exported from wiring.ts`);
    }
  });

  test("renderGovernanceSettings builds its accept controls via the SHARED gesture-gated helpers", () => {
    const wiring = code("wiring/wiring.ts");
    // It uses wireAdoptButton + renderAllowlist (the one addEventListener-gated implementation),
    // never a second inline `.addEventListener('click')` accept path or an `.onclick =` handler.
    assert.match(wiring, /wireAdoptButton\(/, "adopt must go through the shared wireAdoptButton");
    assert.match(wiring, /renderAllowlist\(/, "the allowlist must go through the shared renderAllowlist");
    assert.ok(!/\.onclick\s*=/.test(wiring), "wiring.ts must wire no forgeable .onclick accept handler");
    // The adopt confirm is the shared confirmAdopt (gesture- + confirmation-gated), and the allowlist
    // hands renderAllowlist only the three narrow module-scope thunks — never a full controller.
    assert.match(wiring, /confirmAdopt\(plugin\.app\)/, "adopt confirmation uses the shared confirmAdopt");
    assert.match(wiring, /setClassEnabled:\s*\(id,\s*on,\s*evt\)\s*=>\s*setClassEnabled\(plugin,/,
      "the allowlist mutator thunk forwards the event to the gesture-gated module-scope setClassEnabled");
  });

  test("renderGovernanceSettings renders only when governance is MOUNTED, else a hint (no live accept controls)", () => {
    const wiring = code("wiring/wiring.ts");
    assert.match(wiring, /if\s*\(!isGovernanceMounted\(plugin\)\)/,
      "must gate the controls on the live-mount predicate");
    // The mount flag is a plain WeakSet membership — it holds NO callable, so it cannot itself be an
    // accept gadget, and it is deleted on the mount's teardown so a disabled module shows the hint.
    assert.match(wiring, /const mountedPlugins = new WeakSet</, "mount state is a module-private WeakSet");
    assert.match(wiring, /mountedPlugins\.delete\(plugin\)/, "the mount flag is dropped on teardown");
  });

  test("settings-tab.ts renders governance by handing the module a CONTAINER, receiving nothing back", () => {
    // RETARGETED from connection-ui.ts (host source since S3c). Same three assertions, same
    // reasoning, new subject.
    const ui = code("settings-tab.ts");
    assert.match(ui, /renderGovernanceSettings\(this\.plugin,\s*containerEl\)/,
      "the settings tab passes only the plugin and a container");
    assert.ok(!/=\s*renderGovernanceSettings\(/.test(ui),
      "settings-tab must not assign renderGovernanceSettings' result to anything");
    assert.ok(!/\breturn\s+renderGovernanceSettings\(/.test(ui),
      "settings-tab must not propagate a return value it is not supposed to have");
    // And it never references any accept-equivalent callable directly — its only governance touch
    // is the render fn, the pane-mount toggle, and the plain config fields.
    for (const name of [
      "performAccept", "performAdopt", "performRevert", "runGuardedAdopt", "setClassEnabled",
      "acceptNote", "revertNote", "buildController", "confirmAdopt", "wireAdoptButton", "renderAllowlist",
      "setBaseline", "stampAcceptedFrontmatter", "baselinesOf", "setLegacyWriteGuard",
    ]) {
      assert.ok(!new RegExp(`\\b${name}\\b`).test(ui), `settings-tab must not reference the accept-path fn ${name}`);
    }
    // Its imports are the whole story: obsidian's UI primitives, the plain settings defaults, the
    // render fn, and a type. Pinning the SET closes the class rather than the fourteen instances —
    // a new import of anything accept-capable fails here even if it is spelled differently.
    const specifiers = [...readRaw("settings-tab.ts").matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    // Two specifiers were added by #397 and each is admitted on the same test this
    // pin exists to apply — is it accept-capable? Neither is.
    //   • `./host-lookup.js` — `hostGuardedTerritories` READS another plugin's api
    //     and returns strings or null. It writes nothing and exposes no callable.
    //   • `@vault-mcp/core` — `resolveTerritories` is a pure list-or-default fn.
    // The SET is still closed: anything accept-capable still fails here, and the
    // tab still writes no territories key of its own (pinned separately above).
    assert.deepEqual(specifiers.sort(), ["./host-lookup.js", "./kernel/settings.js", "./settings.js", "./wiring/wiring.js", "@vault-mcp/core", "obsidian"]);
    // Admitting `@vault-mcp/core` as a MODULE would reopen the class this pin
    // closes: that package also exports `acceptTransitionReason`,
    // `acceptForbiddenReason`, `scanForAcceptFence` and `AcceptForbiddenError`.
    // So the BINDINGS are pinned too — the tab may take exactly the one pure
    // helper it needs, and a future accept-capable import from that package
    // fails here exactly as a direct one would.
    const coreBindings = [...readRaw("settings-tab.ts").matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@vault-mcp\/core["']/g)]
      .flatMap((m) => m[1].split(",").map((x) => x.trim()).filter(Boolean));
    assert.deepEqual(coreBindings.sort(), ["resolveTerritories"], "settings-tab may import only the pure territory resolver from core");
  });

  test("the fuller auto-accept text is a SHARED constant (both surfaces render the same one, not two literals)", () => {
    const pane = code("wiring/pane.ts");
    // The constant exists and the pane's allowlist renderer uses it (not an inline string that a
    // settings-tab copy could drift from).
    assert.match(pane, /export const AUTO_ACCEPT_DESC\s*=/, "AUTO_ACCEPT_DESC must be exported from pane.ts");
    assert.match(pane, /governance-allowlist-desc["'],\s*text:\s*AUTO_ACCEPT_DESC/,
      "renderAllowlist must render AUTO_ACCEPT_DESC, not an inline string");
    // The settings tab reaches the same text THROUGH renderAllowlist (shared) — so there is exactly
    // one definition. The RUNTIME value's fuller phrasing (spanning the source's string-concat
    // boundary) is pinned behaviorally in governance-settings-tab.test.mjs against the imported
    // constant; here we only pin the single-source STRUCTURE.
    // The adopt description is likewise a shared constant the settings tab reaches through wiring.
    assert.match(pane, /export const ADOPT_BASELINE_DESC\s*=/, "ADOPT_BASELINE_DESC must be exported from pane.ts");
    const wiring = code("wiring/wiring.ts");
    assert.match(wiring, /ADOPT_BASELINE_DESC/, "the settings tab must reference the shared ADOPT_BASELINE_DESC");
  });
});

// ---------------------------------------------------------------------------
// #261 — the event-driven sweep drive + the published pending index.
// Live-diagnosed: Chromium throttles/suspends renderer timers while the
// Obsidian window is occluded, so the 2.5s poll interval does not tick during
// unattended sessions — exactly when agents write. The journal-append nudge was
// the throttling-immune drive.
//
// ⚠ WHAT S3c TOOK AWAY, AND WHAT NOTHING NOW ASSERTS. Pre-split, `main.ts`
// wrapped the kernel's `journal.append` so every append called
// `nudgeGovernanceQueue`, and the test below pinned that wrapper. The journal is
// the HOST's file in the HOST's directory now, and the host's own main.ts
// wrapper (packages/host/src/main.ts) nudges only its own write queue — it makes
// no seam call to the provider, deliberately: its comment says the provider
// "watches the journal file it already read and no longer needs the host to tell
// it the file grew". THE PROVIDER DOES NOT DO THAT. `nudgeGovernanceQueue` has
// exactly one caller in this package (`refreshProjections`, on the admission
// path), and `wiring.ts` registers no watcher over `deps.journalDir`. So #261's
// throttling-immune drive is NOT HELD BY EITHER PACKAGE, and the review queue is
// back to the timer-only refresh whose failure #261 exists to fix. The pin was
// therefore deleted rather than retargeted — there is no true fact to retarget it
// to — and this comment is the record. What survives below is the nudge's own
// shape (exported, mount-gated) so the entry point does not rot while the drive
// is missing.
// ---------------------------------------------------------------------------
describe("governance module: #261 — journal nudge + pending-index publisher", () => {
  test("wiring.ts exports nudgeGovernanceQueue, gated on the mounted set (no-op unmounted)", () => {
    const wiring = code("wiring/wiring.ts");
    assert.match(wiring, /export function nudgeGovernanceQueue\s*\(/, "the nudge must be exported for main.ts");
    const body = wiring.slice(wiring.indexOf("export function nudgeGovernanceQueue"));
    assert.match(body.slice(0, 300), /mountedPlugins\.has\(plugin\)/, "the nudge must check the live-mount set first");
  });

  test("main.ts still calls the nudge (the entry point is live, NOT that the journal drives it)", () => {
    // Deliberately narrow, and labelled so it is not misread as the retired journal-append pin:
    // this asserts only that the export has a caller, so it cannot rot into dead code while the
    // event-driven drive is missing. It asserts NOTHING about throttling immunity.
    const main = code("main.ts");
    assert.match(main, /nudgeGovernanceQueue\(this\)/, "main.ts must still reach the nudge");
    assert.ok(!/journal\.append\s*=/.test(main),
      "the journal is the host's file now — a wrapper here would be writing another plugin's audit path");
  });

  test("refresh() publishes the pending index at the plugin-dir governance path", () => {
    const wiring = code("wiring/wiring.ts");
    assert.match(wiring, /serializePendingIndex\(pending/, "refresh must serialize the freshly computed queue");
    assert.match(wiring, /pendingIndexPath: `\$\{govDir\}\/pending-index\.json`/, "the index lives beside the acceptance log");
  });

  test("unmount retracts the published index (absent index ⇒ the tool's explicit not-published state)", () => {
    const wiring = code("wiring/wiring.ts");
    assert.match(wiring, /adapter\.remove\(paths\(plugin\)\.pendingIndexPath\)/, "teardown must remove the published index");
  });

  test("the poll interval callback contains the rejection guard (no unhandled rejection into the interval)", () => {
    const wiring = code("wiring/wiring.ts");
    assert.match(wiring, /pollJournal\(plugin\)\.catch\(/, "poll rejections must die in a console.error, never escape");
  });
});
