/**
 * settings-projection.test.mjs — every setting reaches the server, or is
 * deliberately withheld.
 *
 * The bug this exists to prevent, found by review rather than by a test:
 *
 *   `main.ts` declares `captureObservations` and `captureMaxBytes`, the
 *   settings UI writes them, `main.ts` sanitizes them on load — and
 *   `ctx.getSettings()` did not pass them on. `server.ts` read
 *   `ctx.getSettings().captureObservations`, got `undefined`, and the toggle
 *   did nothing at all. No test failed. The typechecker said nothing, because
 *   `ServerCtx`'s new fields are declared optional — so an omission is a
 *   legal program, and the feature was inert in production while every unit
 *   test passed against hand-built fixtures.
 *
 * That is a general hazard, not a one-off: `getSettings()` is a hand-written
 * object literal, and a hand-written projection of a growing interface drifts
 * from it silently and permanently. So this scans the source and requires that
 * every declared setting is either forwarded or listed below as withheld ON
 * PURPOSE, with the reason written down.
 *
 * DENY BY DEFAULT: a new setting fails this test until somebody decides which
 * of the two it is. That is the point — the decision is cheap when you are
 * adding the field and expensive six months later when a feature turns out to
 * have never worked.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(HERE, "..", "src", "main.ts");

/**
 * Settings that stay in the plugin and never reach an MCP connection.
 *
 * Each entry is a claim that the server has no business knowing this, and the
 * reason has to survive being read out loud.
 */
const WITHHELD = {
  setupAcknowledged: "First-run UI state. Nothing on the wire depends on whether a human dismissed a notice.",
  enabled: "Decides whether the socket exists at all; a live connection has already answered it.",
  protectedProperties: "Consumed by the frontmatter guard inside the plugin, which the server calls rather than reimplements.",
  vocabularies: "Reaches the server by its own accessor, ctx.getVocabularies() — forwarded, just not through this literal.",
  enforceRecordImmutability: "Read live per call through its own thunk: obsidianProbe's second argument for the kernel's guard, and ctx.enforceRecordImmutability for the per-connection probe in server.ts. Deliberately not snapshotted per connection.",
  devToolRunner: "Gates an in-Obsidian command surface. No MCP connection can reach it.",
  refusalLog: "Read live per call through its own thunk, Kernel.refusalLog, which main.ts sets to the setting; the guard, the kernel and server.ts read it through ctx.kernel.refusalLogOn(). Deliberately not snapshotted per connection, so turning it on or off takes effect on the next call.",
  recordIdentification: "Read live per call through its own thunk (obsidianProbe's third argument for the kernel's guard; ctx.recordIdentification for server.ts's probe, the moves and obsidian_rename_heading), the same way enforceRecordImmutability is — deliberately not snapshotted per connection, so an operator's edit takes effect on the next write without a reconnect.",
  createNoteFlow: "The vault-relative path of flow.js for obsidian_create_note (#531), read through its own thunk (ctx.createNoteFlow) when the server is built: the tool is registered only when it is set.",
  host: "The headless-host setting (headless.ts): main.ts reads it at load for the paths, the commands and the claude registration, and the server reads it through its own thunk (ctx.host) for which app-only tools to offer and when to refuse them. Not in the getSettings literal.",
  syncGuard: "The Sync guard (01.43, pick A of 2026-10-12), read live per call through its own thunk (ctx.syncGuard, coerced by normalizeSyncGuard in server.ts's guard hook and in obsidian_doctor), like recordFolders: not snapshotted per connection, so a change in the settings tab takes effect on the next write.",
  recordFolders: "The folder indicator (#482), read live per call through its own thunk (ctx.recordFolders, composed with recordIdentification in server.ts for the moves, and the archive pattern for the bracket rule), like recordIdentification: not snapshotted per connection, so an operator's edit takes effect on the next move.",
};

/** The `field: type;` declarations inside `interface VaultMcpSettings`. */
function declaredSettings(src) {
  const open = src.indexOf("interface VaultMcpSettings");
  assert.ok(open > 0, "interface VaultMcpSettings not found — this test is scanning the wrong file");
  const brace = src.indexOf("{", open);
  // Bounded by brace depth rather than by the next `}`, because the interface
  // body contains block comments and nested type literals.
  let depth = 0;
  let end = -1;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end > 0, "interface VaultMcpSettings never closed");
  const body = src.slice(brace + 1, end);
  // Strip comments first so prose inside them cannot look like a field.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const names = new Set();
  for (const m of code.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)) names.add(m[1]);
  return names;
}

/** The keys of the `getSettings: () => ({ … })` literal in the ctx object. */
function forwardedSettings(src) {
  const at = src.indexOf("getSettings: () => ({");
  assert.ok(at > 0, "the getSettings projection was not found — did its shape change?");
  const brace = src.indexOf("{", src.indexOf("({", at));
  let depth = 0;
  let end = -1;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end > 0, "the getSettings projection never closed");
  const code = src.slice(brace + 1, end).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const names = new Set();
  for (const m of code.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) names.add(m[1]);
  return names;
}

describe("settings projection — declared settings reach the server or are withheld on purpose", () => {
  const src = fs.readFileSync(MAIN, "utf8");
  const declared = declaredSettings(src);
  const forwarded = forwardedSettings(src);

  test("the scanners find something, so a silent no-op cannot pass", () => {
    assert.ok(declared.size >= 10, `expected the settings interface to have real fields, got ${declared.size}`);
    assert.ok(forwarded.size >= 5, `expected the projection to forward real fields, got ${forwarded.size}`);
  });

  test("every declared setting is forwarded or explicitly withheld", () => {
    const unaccounted = [...declared].filter((k) => !forwarded.has(k) && !(k in WITHHELD));
    assert.deepEqual(
      unaccounted,
      [],
      `these settings reach neither the server nor the withheld list:\n` +
        unaccounted.map((k) => `  • ${k}`).join("\n") +
        `\n\nAdd them to the getSettings projection in main.ts, or to WITHHELD in this file with the reason.`
    );
  });

  test("the withheld list has no stale entries", () => {
    // A setting that was removed, or that later started being forwarded, must
    // not leave a justification behind claiming otherwise.
    const stale = Object.keys(WITHHELD).filter((k) => !declared.has(k) || forwarded.has(k));
    assert.deepEqual(stale, [], `WITHHELD lists settings that are gone or now forwarded: ${stale.join(", ")}`);
  });

  test("the capture settings specifically are forwarded", () => {
    // Named, because this is the case that shipped broken. A general test that
    // could be satisfied by adding the field to WITHHELD would not have caught
    // it — capture is worthless if the server cannot see the toggle.
    assert.ok(forwarded.has("captureObservations"), "captureObservations must reach the server or the toggle does nothing");
    assert.ok(forwarded.has("captureMaxBytes"), "captureMaxBytes must reach the server or the cap is the default regardless of the setting");
  });
});
