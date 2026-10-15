/**
 * vault-conventions.test.mjs — a dead convention path is loud, never "checked
 * and clean" (#298). Six of the seven shipped paths had silently died across
 * two vault renumberings; nothing noticed because a path that names nothing
 * never errors. `deadConventionPaths` is the detector; this pins its rules.
 * Since #412 the record has THREE keys: `registriesRoot` (structure's
 * blueprint registry), `systemRoot` (drift's J) and `ungovernedRoots`
 * (structure); the three keys whose only readers were the retired drift
 * checks are gone, not blank. #493 added a fourth key, `baselineRel` (the
 * accepted-debt baseline note): a setting no pack reads, so it is never a dead
 * convention.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deadConventionPaths, CONVENTION_PACKS, LEGACY_CONVENTIONS_SEED, EMPTY_VAULT_CONVENTIONS, resolveConventions, conventionsFromEnv, SCALAR_CONVENTION_KEYS, LIST_CONVENTION_KEYS } from "../src/kernel/vault-conventions.ts";

const conv = {
  registriesRoot: "Sys/Registries",
  systemRoot: "Sys",
  ungovernedRoots: ["Sys/Framework"],
};
const liveWalk = {
  dirs: ["Sys", "Sys/Registries", "Sys/Framework"],
  files: ["Sys/Plugin stack.md"],
};

describe("deadConventionPaths", () => {
  test("every path present in the walk → nothing dead", () => {
    assert.deepEqual(deadConventionPaths(conv, liveWalk), []);
  });

  test("every key is a directory key, checked against dirs — a FILE at the path is not the folder, so it is dead", () => {
    const dead = deadConventionPaths(conv, { dirs: ["Sys", "Sys/Framework"], files: ["Sys/Registries"] });
    assert.deepEqual(dead, [{ key: "registriesRoot", path: "Sys/Registries" }]);
  });

  test("the shipped defaults over an empty walk: every key is dead — the #298 finding, as a test that would have caught it", () => {
    const dead = deadConventionPaths(LEGACY_CONVENTIONS_SEED, { dirs: [], files: [] });
    assert.deepEqual(dead.map((d) => d.key).sort(), ["registriesRoot", "systemRoot", "ungovernedRoots"]);
  });

  test("a path under an excluded root is skipped, not reported — the walk pruned it, so its absence says nothing", () => {
    const dead = deadConventionPaths(conv, { dirs: ["Sys"], files: [] }, { excludedRoots: ["Sys/Registries"] });
    assert.deepEqual(dead, [{ key: "ungovernedRoots", path: "Sys/Framework" }]);
  });

  test("a trailing slash on either side is not a difference; an empty entry is ignored", () => {
    const c = { ...conv, registriesRoot: "Sys/Registries/", ungovernedRoots: ["", "Sys/Framework/"] };
    assert.deepEqual(deadConventionPaths(c, { ...liveWalk, dirs: [...liveWalk.dirs.filter((d) => d !== "Sys/Registries"), "Sys/Registries/"] }), []);
  });

  test("a path under a SKIPPED TERRITORY or a skip-dir segment is unobserved, not dead (#401 review)", () => {
    const dead = deadConventionPaths({ ...conv, registriesRoot: "80-89 Sensitive/Registries", ungovernedRoots: [".obsidian/plugins/x"] }, { dirs: ["Sys"], files: [] }, { skippedTerritories: [{ path: "80-89 Sensitive" }], skipDirs: new Set([".obsidian"]) });
    assert.deepEqual(dead, [], "the walk chose not to look there; absence says nothing");
  });

  test("an ABSENT listing throws — never reads as everything-dead", () => {
    assert.throws(() => deadConventionPaths(conv, { files: [] }), /needs the walk's 'dirs' and 'files'/);
    assert.throws(() => deadConventionPaths(conv, { dirs: [] }), /needs the walk's 'dirs' and 'files'/);
  });

  test("CONVENTION_PACKS names every key of VaultConventions and every PACK that reads it — pinned against the packs' own sources", () => {
    assert.deepEqual(Object.keys(CONVENTION_PACKS).sort(), Object.keys(LEGACY_CONVENTIONS_SEED).sort());
    for (const v of Object.values(CONVENTION_PACKS)) for (const id of v) assert.ok(["drift_audit", "conformance_check", "port_lint", "ste_lint"].includes(id), id);
    // structure.ts reads conv.registriesRoot (blueprint registry) and conv.ungovernedRoots; drift.ts reads conv.systemRoot and nothing else (#412).
    // baselineRel (#493) is read by the debt/drift sources and the CLI, not by a pack: it feeds none.
    assert.deepEqual(CONVENTION_PACKS, { registriesRoot: ["conformance_check"], systemRoot: ["drift_audit"], ungovernedRoots: ["conformance_check"], baselineRel: [] });
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const read = (rel) => fs.readFileSync(path.join(HERE, "..", "src", "kernel", "packs", rel), "utf8");
    const drift = read("drift.ts"), structure = read("structure.ts");
    assert.match(drift, /conv\.systemRoot/); assert.doesNotMatch(drift, /conv\.registriesRoot|conv\.ungovernedRoots/);
    assert.match(structure, /registriesRoot/); assert.match(structure, /ungovernedRoots/); assert.doesNotMatch(structure, /systemRoot/);
    // ste_lint reads registriesRoot only to NARROW its editable bucket (#411) and is deliberately not listed; port_lint reads nothing.
    const ste = read("ste.ts"), port = read("port.ts");
    assert.match(ste, /conv\.registriesRoot/); assert.doesNotMatch(ste, /conv\.(systemRoot|ungovernedRoots)/); assert.ok(!("ste_lint" in Object.fromEntries(Object.values(CONVENTION_PACKS).flat().map((id) => [id, 1]))), "ste_lint is not a listed reader");
    assert.doesNotMatch(port, /conv\./);
  });

  test("#412: the three keys the retired drift checks read are GONE from the record, not blank — a key nobody reads is a setting that lies", () => {
    for (const key of ["artifactsRoot", "pluginStackPath", "uidExemptPaths"]) {
      assert.ok(!(key in EMPTY_VAULT_CONVENTIONS), key);
      assert.ok(!(key in LEGACY_CONVENTIONS_SEED), key);
      assert.ok(!(key in CONVENTION_PACKS), key);
    }
    // A data.json that still carries them (written by a build before #412) coerces to the record: the stale keys are dropped, not kept (baselineRel, absent here, coerces to "").
    const stale = { ...conv, artifactsRoot: "Sys/Artifacts", pluginStackPath: "Sys/Plugin stack.md", uidExemptPaths: ["Sys/T/Daily.md"] };
    assert.deepEqual(resolveConventions(stale), { ...conv, baselineRel: "" });
  });
});

describe("#403 — EMPTY is what ships; blank scalar = dead, empty list = none; coercion; the CLI env knob", () => {
  test("EMPTY conventions: the two scalar keys are dead with path '', the list key is not", () => {
    const dead = deadConventionPaths(EMPTY_VAULT_CONVENTIONS, { dirs: [], files: [] });
    assert.deepEqual(dead.map((d) => d.key).sort(), [...SCALAR_CONVENTION_KEYS].sort());
    assert.deepEqual([...SCALAR_CONVENTION_KEYS].sort(), ["registriesRoot", "systemRoot"]);
    assert.ok(dead.every((d) => d.path === ""));
    assert.deepEqual([...SCALAR_CONVENTION_KEYS, ...LIST_CONVENTION_KEYS, "baselineRel"].sort(), Object.keys(EMPTY_VAULT_CONVENTIONS).sort(), "the two key lists cover the record exactly, beside baselineRel (#493)");
    assert.ok(![...SCALAR_CONVENTION_KEYS, ...LIST_CONVENTION_KEYS].includes("baselineRel"), "baselineRel is in neither list: a blank one is none configured, not a dead convention");
  });

  test("a blank ENTRY inside a list key is skipped, not dead; a named entry that is absent is dead", () => {
    const conv = { ...EMPTY_VAULT_CONVENTIONS, registriesRoot: "R", systemRoot: "S", ungovernedRoots: ["", "  ", "U/x"] };
    const dead = deadConventionPaths(conv, { dirs: ["R", "S"], files: [] });
    assert.deepEqual(dead, [{ key: "ungovernedRoots", path: "U/x" }]);
  });

  test("resolveConventions coerces anything to a full record: trims, drops blanks, never throws, never guesses", () => {
    assert.deepEqual(resolveConventions(undefined), EMPTY_VAULT_CONVENTIONS);
    assert.deepEqual(resolveConventions("nonsense"), EMPTY_VAULT_CONVENTIONS);
    assert.deepEqual(resolveConventions({ registriesRoot: "  R ", ungovernedRoots: "a\n\n b ", systemRoot: [1], extra: 1 }),
      { ...EMPTY_VAULT_CONVENTIONS, registriesRoot: "R", ungovernedRoots: ["a", "b"] });
    assert.deepEqual(resolveConventions({ ungovernedRoots: [1, " U "] }).ungovernedRoots, ["U"]);
    assert.deepEqual(resolveConventions(LEGACY_CONVENTIONS_SEED), LEGACY_CONVENTIONS_SEED, "the seed is already canonical");
  });

  test("conventionsFromEnv: VAULT_MCP_CONVENTIONS first; the two old spellings read once more, each with a warning naming the new one; unset is EMPTY, not the seed", () => {
    const warned = [];
    const w = (m) => warned.push(m);
    const v = JSON.stringify({ registriesRoot: "V" }), g = JSON.stringify({ registriesRoot: "G" }), a = JSON.stringify({ registriesRoot: "A" });
    assert.equal(conventionsFromEnv({ VAULT_MCP_CONVENTIONS: v, GOVERNOR_VAULT_CONVENTIONS: g, ASSENT_VAULT_CONVENTIONS: a }, w).registriesRoot, "V");
    assert.equal(warned.length, 0, "the new spelling warns about nothing");
    assert.equal(conventionsFromEnv({ GOVERNOR_VAULT_CONVENTIONS: g, ASSENT_VAULT_CONVENTIONS: a }, w).registriesRoot, "G");
    assert.match(warned.at(-1), /GOVERNOR_VAULT_CONVENTIONS is a legacy spelling — set VAULT_MCP_CONVENTIONS/);
    assert.equal(conventionsFromEnv({ ASSENT_VAULT_CONVENTIONS: a }, w).registriesRoot, "A");
    assert.match(warned.at(-1), /ASSENT_VAULT_CONVENTIONS is a legacy spelling/);
    assert.deepEqual(conventionsFromEnv({}, w), EMPTY_VAULT_CONVENTIONS, "unset: EMPTY, never the seed");
    assert.deepEqual(conventionsFromEnv({ VAULT_MCP_CONVENTIONS: "   " }, w), EMPTY_VAULT_CONVENTIONS, "set-but-blank: EMPTY");
    const n = warned.length;
    assert.deepEqual(conventionsFromEnv({ VAULT_MCP_CONVENTIONS: "{not json" }, w), EMPTY_VAULT_CONVENTIONS, "malformed: EMPTY, loudly");
    assert.match(warned[n], /not valid JSON — every convention reads as EMPTY/);
    assert.deepEqual(conventionsFromEnv({ VAULT_MCP_CONVENTIONS: v }, w).ungovernedRoots, [], "keys the JSON omits are EMPTY, not seeded");
  });
});
