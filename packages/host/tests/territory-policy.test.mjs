/**
 * territory-policy.test.mjs — the host's three territory decisions (#396/#397),
 * ruled 2026-09-22: no shipped list, empty guards nothing, capture refuses on
 * empty, and the legacy seed is written ONCE into an upgrading install.
 *
 * Two halves. The first tests the pure functions. The second pins, by source
 * scan, that production actually calls them — because the defect this repo
 * keeps finding is a setting that exists with nothing proving a path reads it
 * (#397 itself: the territory list was threaded through `SnapshotOpts` and no
 * production caller passed it).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { territoriesOnLoad, hasGuardedTerritory, captureAllowed } from "../src/territory-policy.ts";
import { LEGACY_TERRITORY_SEED } from "../../core/src/territories.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => fs.readFileSync(path.join(HERE, "..", "src", rel), "utf8");

describe("territoriesOnLoad — the one-time migration", () => {
  test("a FRESH install (no data.json) starts EMPTY and persists the key", () => {
    for (const own of [null, undefined]) {
      const r = territoriesOnLoad(own);
      assert.deepEqual(r.territories, [], "no shipped default: a new install guards nothing");
      assert.equal(r.persist, true, "the key is written so the seed branch can never run later");
    }
  });

  test("an EXISTING install without the key is seeded with the legacy four, once", () => {
    // This is the whole reason the seed exists: the install predates the
    // setting, and the old built-in default was guarding its legal material.
    const r = territoriesOnLoad({ readOnly: false, captureObservations: true });
    assert.deepEqual(r.territories, [...LEGACY_TERRITORY_SEED]);
    assert.ok(r.territories.includes("80-89"), "the legal area is in the seed");
    assert.equal(r.persist, true, "persisted so the next load sees the key and does NOT seed again");
    assert.notEqual(r.territories, LEGACY_TERRITORY_SEED, "a copy, never the shared constant");
  });

  test("an install that HAS the key keeps exactly what it has — an explicit [] is honoured, not re-seeded", () => {
    const r = territoriesOnLoad({ guardedTerritories: [] });
    assert.deepEqual(r.territories, [], "empty means empty; the seed is not consulted");
    assert.equal(r.persist, false, "nothing to migrate, nothing to write");
  });

  test("a configured list is resolved (trimmed, blanks dropped, leading / stripped) and not persisted", () => {
    const r = territoriesOnLoad({ guardedTerritories: [" Archive/ ", "", "/Private/"] });
    assert.deepEqual(r.territories, ["Archive/", "Private/"]);
    assert.equal(r.persist, false);
  });

  test("a malformed key (non-array) resolves to empty rather than throwing or seeding", () => {
    // A hand-edited data.json. The key EXISTS, so this is not the pre-setting
    // install the seed is for; guarding by the legacy list here would be a
    // default creeping back in through a typo.
    for (const bad of ["80-89", 42, {}, true]) {
      const r = territoriesOnLoad({ guardedTerritories: bad });
      assert.deepEqual(r.territories, [], `${JSON.stringify(bad)} must resolve to empty`);
      assert.equal(r.persist, false);
    }
  });

  test("an install ADOPTED from the pre-split plugin (own absent, adopted present) is an EXISTING install and takes the seed", () => {
    // The #396 review found this exact case classed as fresh: on the first load
    // after the host/provider split, the host has no data.json of its own yet,
    // and everything it knows came over from the old `governor` folder. That
    // operator was guarded by the old built-in list; starting them empty would
    // silently unguard the legal material on the very upgrade the seed is for.
    const r = territoriesOnLoad(null, { readOnly: false, captureObservations: true });
    assert.deepEqual(r.territories, [...LEGACY_TERRITORY_SEED]);
    assert.equal(r.persist, true);
  });

  test("own data.json wins over adopted when both exist; an adopted key is honoured if one ever arrives", () => {
    // Today `splitSettings` (core's HOST_SETTING_KEYS) does not carry
    // `guardedTerritories` across adoption — the setting postdates the split —
    // so production adoption always lands in the seed branch above. The
    // function still honours a key if a future adoption path supplies one.
    assert.deepEqual(territoriesOnLoad(null, { guardedTerritories: ["Mine/"] }).territories, ["Mine/"]);
    assert.deepEqual(territoriesOnLoad({ guardedTerritories: ["Own/"] }, { guardedTerritories: ["Adopted/"] }).territories, ["Own/"]);
    assert.deepEqual(territoriesOnLoad(undefined, undefined), { territories: [], persist: true }, "neither: genuinely fresh");
  });

  test("the seed is never re-applied when the key is present, whatever else the file holds", () => {
    // Regression shape for "a new user saves any other setting, then a later
    // load inherits the legacy operator's folders": once the key is there, the
    // answer is the key's, full stop.
    const r = territoriesOnLoad({ guardedTerritories: ["Mine/"], readOnly: true, allowlist: [] });
    assert.deepEqual(r.territories, ["Mine/"]);
  });
});

describe("hasGuardedTerritory / captureAllowed — capture refuses on an empty list", () => {
  test("hasGuardedTerritory is false for empty, blank, missing and malformed lists", () => {
    for (const s of [{}, { guardedTerritories: [] }, { guardedTerritories: [""] }, { guardedTerritories: "x" }, { guardedTerritories: null }]) {
      assert.equal(hasGuardedTerritory(s), false, JSON.stringify(s));
    }
    assert.equal(hasGuardedTerritory({ guardedTerritories: ["Archive/"] }), true);
  });

  test("captureAllowed needs BOTH: explicitly on AND at least one territory", () => {
    assert.equal(captureAllowed({ captureObservations: true, guardedTerritories: ["Archive/"] }), true);
    assert.equal(captureAllowed({ captureObservations: true, guardedTerritories: [] }), false, "on with nothing guarded is refused");
    assert.equal(captureAllowed({ captureObservations: true }), false, "on with no key at all is refused");
    assert.equal(captureAllowed({ captureObservations: false, guardedTerritories: ["Archive/"] }), false, "off stays off");
  });

  test("only a literal true turns capture on — a corrupt data.json cannot", () => {
    for (const v of ["true", 1, "yes", {}, []]) {
      assert.equal(captureAllowed({ captureObservations: v, guardedTerritories: ["Archive/"] }), false, JSON.stringify(v));
    }
  });
});

describe("production reads these predicates — pinned at the source", () => {
  test("server.ts gates capture on captureAllowed over the LIVE settings, read per call", () => {
    const server = src("mcp/server.ts");
    // A lambda around ctx.getSettings(): hoisting the read to build time is the
    // inert-toggle bug again — an operator's edit would not take effect until
    // the next reconnect.
    assert.match(server, /enabled:\s*\(\)\s*=>\s*captureAllowed\(\s*ctx\.getSettings\(\)\s*\)/, "createCapture's enabled must be captureAllowed(ctx.getSettings())");
    assert.match(server, /import \{ captureAllowed \} from "\.\.\/territory-policy\.js"/, "and it must be the shared predicate, not a local copy");
  });

  test("the settings toggle refuses on the same precondition (hasGuardedTerritory)", () => {
    const ui = src("connection-ui.ts");
    assert.match(ui, /if \(value && !hasGuardedTerritory\(this\.plugin\.settings\)\)/, "the toggle must consult the shared precondition");
    assert.match(ui, /import \{ hasGuardedTerritory \} from "\.\/territory-policy\.js"/);
  });

  test("main.ts applies territoriesOnLoad and persists when it says to", () => {
    const main = src("main.ts");
    assert.match(main, /const territories = territoriesOnLoad\(own, seed\)/, "the migration must see the plugin's OWN data AND the settings adopted from the pre-split plugin");
    assert.match(main, /this\.settings\.guardedTerritories = territories\.territories/);
    assert.match(main, /if \(territories\.persist \|\| recordFoldersLoad\.persist \|\| autoRegisterLoad\.persist \|\| schemesLoad\.persist\) await this\.saveSettings\(\)/, "the key must be written when it was absent, or the seed branch runs again (the record folders ride the same persist since #482; the conventions key did from #403 until it left with the rail)");
    assert.match(main, /const recordFoldersLoad = recordFoldersOnLoad\(own, seed\)/, "the record-folders seed sees the plugin's own data and the adopted settings, as territories do (#482)");
  });

  // "the two conformance sources FORWARD the territory thunk they are handed"
  // (#396 review) moved to packages/conformance/tests/conformance-satellite.test.mjs
  // with the sources, on 2026-10-14. What the host still owes the rail is the
  // list itself, on the api — pinned here:
  test("the host publishes its territories on the api for the conformance satellite, resolved and copied", () => {
    assert.match(src("main.ts"), /guardedTerritories: \(\) => \[\.\.\.resolveTerritories\(this\.settings\.guardedTerritories\)\]/);
  });

  test("LEGACY_TERRITORY_SEED has exactly ONE reader in the host: the migration", () => {
    // The core test says the seed "is read by exactly one caller". Any second
    // reader is the shipped default coming back under another name.
    const readers = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && p.endsWith(".ts") && fs.readFileSync(p, "utf8").includes("LEGACY_TERRITORY_SEED")) readers.push(path.relative(path.join(HERE, "..", "src"), p));
      }
    };
    walk(path.join(HERE, "..", "src"));
    assert.deepEqual(readers, ["territory-policy.ts"]);
  });
});
