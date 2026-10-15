/**
 * connection-ui.test.mjs — pure helpers behind the settings tab's
 * manifest-driven config fields (#81: config-host), including the
 * generalized `numberFieldProblem`, which lets the generic renderer refuse
 * (loudly, never silently) an unparseable "number"-typed field instead of
 * saving `undefined` with only a footnote — the old `parseFloorField`/
 * `floorFieldProblem` pair this generalizes did save the silently-emptied
 * value; `parseNumberField`/`numberFieldProblem` are used together
 * differently (see connection-ui.ts's `renderConfigField`, "number" case):
 * a non-null problem now means the save is SKIPPED, not merely footnoted.
 *
 * connection-ui.ts imports classes from "obsidian" at module scope (Modal,
 * PluginSettingTab, Setting, Notice — used as base classes / constructed at
 * runtime, not just as types), so it can't load in plain node. Same pattern
 * link-healing.test.mjs uses: installObsidianStub() points the "obsidian"
 * specifier at minimal stand-ins, then this file await-imports the real
 * module. Only the pure, exported helpers are exercised — display()'s DOM
 * wiring is untested, same boundary as every other field in that file today.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { installObsidianStub } from "./obsidian-stub.mjs";

installObsidianStub();
const {
  parseCommaList,
  parseNumberField,
  numberFieldProblem,
  parseLineList,
  addAllowOpaqueEntry,
  buildSettingsTabs,
  resolveActiveTab,
  moduleTabId,
  STATIC_SETTINGS_TABS,
  MODULE_TAB_PREFIX,
} = await import("../src/connection-ui.ts");

// ── parseCommaList (pre-existing, pinned here since it had no test file yet) ──

describe("parseCommaList", () => {
  test("splits, trims, and drops blanks", () => {
    assert.deepEqual(parseCommaList(" 90-99 , 27 ,,  "), ["90-99", "27"]);
  });

  test("all-blank input yields undefined (provider default), not []", () => {
    assert.equal(parseCommaList("   "), undefined);
    assert.equal(parseCommaList(""), undefined);
  });
});

// ── parseLineList (new: the excludedRoots textarea) ─────────────────────────

describe("parseLineList", () => {
  test("splits on newlines, trims, and drops blank lines", () => {
    assert.deepEqual(parseLineList(" Vault archaeology \n\nOther root \n  "), ["Vault archaeology", "Other root"]);
  });

  test("all-blank input yields undefined, not [] — field is removed, not persisted empty", () => {
    assert.equal(parseLineList(""), undefined);
    assert.equal(parseLineList("   \n  \n"), undefined);
  });
});

// ── parseNumberField (generalized from the old JD-specific parseFloorField) ─

describe("parseNumberField", () => {
  test("blank yields undefined (removes the key — 'use the default')", () => {
    assert.equal(parseNumberField(""), undefined);
    assert.equal(parseNumberField("   "), undefined);
  });

  test("a valid integer parses through", () => {
    assert.equal(parseNumberField("5"), 5);
    assert.equal(parseNumberField(" 20 "), 20);
  });

  test("a non-numeric value silently becomes undefined — the exact behavior numberFieldProblem exists to surface, and why the renderer checks numberFieldProblem BEFORE calling this", () => {
    assert.equal(parseNumberField("abc"), undefined);
  });
});

// ── numberFieldProblem ───────────────────────────────────────────────────────

describe("numberFieldProblem — surfaces what parseNumberField cannot express on its own", () => {
  test("blank is never a problem — it's the documented 'use the default' case", () => {
    assert.equal(numberFieldProblem("Content-decimal floor", ""), null);
    assert.equal(numberFieldProblem("Content-decimal floor", "   "), null);
  });

  test("a valid integer is never a problem", () => {
    assert.equal(numberFieldProblem("Content-decimal floor", "5"), null);
    assert.equal(numberFieldProblem("Content-decimal floor", " 20 "), null);
  });

  test("a non-numeric value is reported, naming the field label and the offending text", () => {
    const problem = numberFieldProblem("Content-decimal floor", "abc");
    assert.equal(typeof problem, "string");
    assert.match(problem, /Content-decimal floor/);
    assert.match(problem, /abc/);
  });

  test("the message says the value was NOT saved — the loud-refusal contract the renderer relies on (never a silent coerce-to-default)", () => {
    assert.match(numberFieldProblem("X", "abc"), /not saved/);
  });

  test("different fields get their own label in the message, so two fields' problems are distinguishable", () => {
    assert.match(numberFieldProblem("Retry limit", "abc"), /Retry limit/);
  });

  test("a value that parses but is out of a module's own range is NOT this function's concern (that's manifest.config.validate's job downstream)", () => {
    // 500 is a valid NUMBER (Number("500") is not NaN) — numberFieldProblem
    // only catches "not a number at all"; range checking is the module's
    // own validate()'s job on the resulting config.
    assert.equal(numberFieldProblem("Content-decimal floor", "500"), null);
  });
});

// ── Gap B: the vocab-instance form helpers were tested HERE ─────────────────
//
// `parseVocabConfig` / `stringifyVocabConfig` / `coerceVocabInstances` /
// `validateVocabInstances` and the three array mutations moved to
// `packages/vocab/src/settings.ts` at the read-tier satellite extraction
// (suite split, S7), with their tests. They were the settings form for the
// vocab MODULE's `settings.vocabularies` list; the module is now the
// `vaultmcp-vocab` plugin and renders its own tab. Nothing was copied — this
// file's coverage moved, it did not fork.

describe("addAllowOpaqueEntry — the 'Add a command' picker's append+dedupe", () => {
  const validIds = { "quickadd:choice:New Area note": {}, "app:reload": {} };

  test("appends a real, currently-registered command id", () => {
    const before = ["app:reload"];
    const after = addAllowOpaqueEntry(before, "quickadd:choice:New Area note", validIds);
    assert.deepEqual(after, ["app:reload", "quickadd:choice:New Area note"]);
    assert.deepEqual(before, ["app:reload"], "input is not mutated");
  });

  test("a value that isn't a registered command id is a no-op (same reference)", () => {
    const before = ["app:reload"];
    const after = addAllowOpaqueEntry(before, "not-a-real-command", validIds);
    assert.equal(after, before, "returns the SAME array — nothing changed");
  });

  test("re-adding an already-listed id is a no-op (same reference)", () => {
    const before = ["app:reload"];
    const after = addAllowOpaqueEntry(before, "app:reload", validIds);
    assert.equal(after, before);
  });

  test("a command id containing a newline is refused, even if somehow registered", () => {
    const before = [];
    const idsWithNewline = { "evil:id\nsmuggled:id": {} };
    const after = addAllowOpaqueEntry(before, "evil:id\nsmuggled:id", idsWithNewline);
    assert.equal(after, before, "refused — would split into two entries on the next textarea round-trip");
  });

  test("an empty allowOpaque list still appends normally", () => {
    const after = addAllowOpaqueEntry([], "app:reload", validIds);
    assert.deepEqual(after, ["app:reload"]);
  });
});

// ── tabbed settings UI: the pure, DOM-free half ─────────────────────────────

describe("buildSettingsTabs — data-driven tab derivation from the module set", () => {
  test("the two fixed tabs lead, in order, before any module (Conformance, #403, left with the rail for vaultmcp-conformance on 2026-10-14)", () => {
    const tabs = buildSettingsTabs([]);
    assert.deepEqual(tabs, [
      { id: "connection", name: "Connection" },
      { id: "security", name: "Security" },
    ]);
  });

  test("one tab per module follows the fixed tabs, in registry order", () => {
    const tabs = buildSettingsTabs([{ id: "scheme" }, { id: "vocab" }, { id: "health" }]);
    assert.deepEqual(
      tabs.map((t) => t.id),
      ["connection", "security", "module:scheme", "module:vocab", "module:health"],
    );
    // tab NAME is the module id (matching the section header the renderer uses)
    assert.deepEqual(
      tabs.slice(2).map((t) => t.name),
      ["scheme", "vocab", "health"],
    );
  });

  test("a NEW module automatically yields a NEW tab (no per-module code)", () => {
    const before = buildSettingsTabs([{ id: "scheme" }]);
    const after = buildSettingsTabs([{ id: "scheme" }, { id: "brandnew" }]);
    assert.equal(after.length, before.length + 1);
    assert.equal(after.at(-1).id, "module:brandnew");
    assert.equal(after.at(-1).name, "brandnew");
  });

  test("module tab ids are prefixed so a module id can't collide with a static tab", () => {
    const tabs = buildSettingsTabs([{ id: "connection" }, { id: "security" }]);
    // The static tabs keep their bare ids; the same-named modules get prefixed ids.
    assert.deepEqual(tabs.map((t) => t.id), [
      "connection",
      "security",
      "module:connection",
      "module:security",
    ]);
    assert.equal(moduleTabId("connection"), `${MODULE_TAB_PREFIX}connection`);
  });

  test("STATIC_SETTINGS_TABS is the leading two: Connection and Security (the Conformance tab moved to the vaultmcp-conformance plugin)", () => {
    assert.deepEqual([...STATIC_SETTINGS_TABS], [
      { id: "connection", name: "Connection" },
      { id: "security", name: "Security" },
    ]);
  });
});

describe("resolveActiveTab — remember last, fall back to first", () => {
  const tabs = buildSettingsTabs([{ id: "scheme" }, { id: "vocab" }]);

  test("no remembered tab defaults to the first (Connection)", () => {
    assert.equal(resolveActiveTab(tabs, undefined), "connection");
  });

  test("a remembered tab that still exists is kept", () => {
    assert.equal(resolveActiveTab(tabs, "security"), "security");
    assert.equal(resolveActiveTab(tabs, "module:vocab"), "module:vocab");
  });

  test("a remembered module tab that no longer exists falls back to the first", () => {
    // e.g. the 'vocab' module was disabled/removed since the last render
    assert.equal(resolveActiveTab(buildSettingsTabs([{ id: "scheme" }]), "module:vocab"), "connection");
  });

  test("an empty tab list yields undefined (never happens — static tabs always present)", () => {
    assert.equal(resolveActiveTab([], "connection"), undefined);
  });
});
