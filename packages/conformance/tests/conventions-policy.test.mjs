/**
 * conventions-policy.test.mjs — #403: the vault conventions (three since #412) are a
 * setting with EMPTY defaults (the host's until 2026-10-14, the vaultmcp-conformance
 * satellite's since); the former shipped paths are a one-time
 * migration seed with exactly one reader; the in-app sources read the setting
 * per call; the CLI reads VAULT_MCP_CONVENTIONS. Source-scan pins say WHO
 * supplies the value, because "threaded but never read" is this repository's
 * recurring defect and a thunk nobody passes is exactly that.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conventionsOnLoad, CONVENTION_FIELDS, conventionFieldValue, commitConvention, withBaselineSeed } from "../src/kernel/conventions-policy.ts";
import { deadConventionPaths, conventionsFromEnv, CONVENTIONS_ENV } from "../src/kernel/vault-conventions.ts";
import { EMPTY_VAULT_CONVENTIONS, LEGACY_CONVENTIONS_SEED } from "../src/kernel/vault-conventions.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// withBaselineSeed (used by conventionsOnLoad) prefers the BASELINE_REL env
// override, so the suite clears both spellings for its whole run.
const BASELINE_ENV = ["GOVERNOR_BASELINE_REL", "ASSENT_BASELINE_REL"];
const savedBaselineEnv = BASELINE_ENV.map((k) => [k, process.env[k]]);
before(() => { for (const k of BASELINE_ENV) delete process.env[k]; });
after(() => { for (const [k, v] of savedBaselineEnv) if (v !== undefined) process.env[k] = v; else delete process.env[k]; });
const src = (rel) => fs.readFileSync(path.join(HERE, "..", "src", rel), "utf8");

describe("conventionsOnLoad — seed once, fresh empty, present kept", () => {
  test("a fresh install (no data.json, nothing adopted) starts EMPTY and persists the key", () => {
    assert.deepEqual(conventionsOnLoad(null), { conventions: EMPTY_VAULT_CONVENTIONS, persist: true });
    assert.deepEqual(conventionsOnLoad(undefined, undefined), { conventions: EMPTY_VAULT_CONVENTIONS, persist: true });
  });
  test("an existing install whose data.json predates the key is seeded ONCE with the former shipped paths", () => {
    const r = conventionsOnLoad({ readOnly: false, guardedTerritories: [] });
    assert.deepEqual(r, { conventions: LEGACY_CONVENTIONS_SEED, persist: true });
  });
  test("an ADOPTED install (no own data.json, provider settings adopted) is an existing install: seeded", () => {
    assert.deepEqual(conventionsOnLoad(null, { readOnly: true }).conventions, LEGACY_CONVENTIONS_SEED);
  });
  test("an install that has the key keeps exactly what it has, coerced, even when empty", () => {
    assert.deepEqual(conventionsOnLoad({ vaultConventions: { registriesRoot: " R ", baselineRel: " B.md " } }), { conventions: { ...EMPTY_VAULT_CONVENTIONS, registriesRoot: "R", baselineRel: "B.md" }, persist: false });
    assert.deepEqual(conventionsOnLoad({ vaultConventions: { baselineRel: "" } }), { conventions: EMPTY_VAULT_CONVENTIONS, persist: false });
    assert.deepEqual(conventionsOnLoad({ vaultConventions: "garbage" }), { conventions: EMPTY_VAULT_CONVENTIONS, persist: false });
  });
  test("#493: stored conventions that LACK baselineRel take the former constant's path ONCE (and persist); only that key is seeded", () => {
    const r = conventionsOnLoad({ vaultConventions: { registriesRoot: " R ", systemRoot: "", ungovernedRoots: ["U"] } });
    assert.deepEqual(r, { conventions: { registriesRoot: "R", systemRoot: "", ungovernedRoots: ["U"], baselineRel: LEGACY_CONVENTIONS_SEED.baselineRel }, persist: true }, "the other keys are kept as stored, not re-seeded");
    assert.deepEqual(conventionsOnLoad({ vaultConventions: {} }), { conventions: EMPTY_VAULT_CONVENTIONS, persist: true }, "an all-blank record lacking the key stays blank (nothing says it was the seeded vault); the key is still persisted");
    // Once persisted, the next load has the key and keeps it: seeded once, not every load.
    assert.deepEqual(conventionsOnLoad({ vaultConventions: r.conventions }), { conventions: r.conventions, persist: false });
  });
  test("withBaselineSeed: an upgraded record (some other key set) is seeded; an all-blank one is not; a present key is kept", () => {
    const seedNoEnv = (stored) => withBaselineSeed(stored, {});
    const seed = LEGACY_CONVENTIONS_SEED.baselineRel;
    assert.equal(seedNoEnv({ registriesRoot: "R" }).baselineRel, seed, "registriesRoot set");
    assert.equal(seedNoEnv({ systemRoot: "S" }).baselineRel, seed, "systemRoot set");
    assert.equal(seedNoEnv({ ungovernedRoots: ["U"] }).baselineRel, seed, "a non-empty ungovernedRoots");
    assert.deepEqual(seedNoEnv({ registriesRoot: " R ", ungovernedRoots: ["U", " "] }), { registriesRoot: "R", systemRoot: "", ungovernedRoots: ["U"], baselineRel: seed }, "only baselineRel is added; the rest is coerced as stored");
    for (const blank of [{}, { registriesRoot: "  ", systemRoot: "", ungovernedRoots: [] }, { ungovernedRoots: ["", " "] }]) {
      assert.deepEqual(seedNoEnv(blank), EMPTY_VAULT_CONVENTIONS, JSON.stringify(blank));
    }
    assert.equal(seedNoEnv({ registriesRoot: "R", baselineRel: "" }).baselineRel, "", "a present blank key is kept");
    assert.equal(seedNoEnv({ registriesRoot: "R", baselineRel: " Mine.md " }).baselineRel, "Mine.md", "a present key is kept, trimmed");
    for (const junk of [null, undefined, "garbage", ["R"]]) assert.deepEqual(seedNoEnv(junk), EMPTY_VAULT_CONVENTIONS, String(junk));
  });

  test("withBaselineSeed: an upgraded record takes the BASELINE_REL env override when set, else the legacy seed", () => {
    const seed = LEGACY_CONVENTIONS_SEED.baselineRel;
    assert.equal(withBaselineSeed({ registriesRoot: "R" }, { GOVERNOR_BASELINE_REL: " Env/B.md " }).baselineRel, "Env/B.md", "the override, trimmed");
    assert.equal(withBaselineSeed({ registriesRoot: "R" }, { ASSENT_BASELINE_REL: "Old/B.md" }).baselineRel, "Old/B.md", "the legacy spelling");
    assert.equal(withBaselineSeed({ registriesRoot: "R" }, { GOVERNOR_BASELINE_REL: "  " }).baselineRel, seed, "a blank override: the seed");
    assert.equal(withBaselineSeed({ registriesRoot: "R" }, {}).baselineRel, seed);
    assert.equal(withBaselineSeed({}, { GOVERNOR_BASELINE_REL: "Env/B.md" }).baselineRel, "Env/B.md", "an ALL-BLANK record lacking the key takes the override too (that install read it before #493)");
    assert.equal(withBaselineSeed({ ungovernedRoots: [] }, { ASSENT_BASELINE_REL: "Old/B.md" }).baselineRel, "Old/B.md");
    assert.equal(withBaselineSeed({ registriesRoot: "R", baselineRel: "" }, { GOVERNOR_BASELINE_REL: "Env/B.md" }).baselineRel, "", "a present key is kept");
    // The default env is process.env.
    process.env.GOVERNOR_BASELINE_REL = "Proc/B.md";
    try {
      assert.equal(withBaselineSeed({ systemRoot: "S" }).baselineRel, "Proc/B.md");
      assert.equal(conventionsOnLoad({ vaultConventions: { systemRoot: "S" } }).conventions.baselineRel, "Proc/B.md", "conventionsOnLoad seeds through it");
    } finally {
      delete process.env.GOVERNOR_BASELINE_REL;
    }
  });

  test("withBaselineSeed exists(): an all-blank record lacking the key takes the legacy path only when that note EXISTS in the vault; the override still wins", () => {
    const seed = LEGACY_CONVENTIONS_SEED.baselineRel;
    const asked = [];
    const yes = (rel) => { asked.push(rel); return true; };
    assert.equal(withBaselineSeed({}, {}, yes).baselineRel, seed, "the note is on disk: the operator who blanked every folder still measured against it");
    assert.deepEqual(asked, [seed], "exists() is asked about the legacy path, nothing else");
    assert.equal(withBaselineSeed({}, {}, () => false).baselineRel, "", "no such note: a fresh install stays without a baseline");
    assert.equal(withBaselineSeed({}, {}).baselineRel, "", "no exists(): the all-blank case takes only the override");
    assert.equal(withBaselineSeed({}, { GOVERNOR_BASELINE_REL: "Env/B.md" }, yes).baselineRel, "Env/B.md", "the override beats the on-disk legacy note");
    assert.equal(withBaselineSeed({ registriesRoot: "R" }, {}, () => false).baselineRel, seed, "an upgraded record takes the legacy path whether or not it exists");
    assert.equal(withBaselineSeed({ baselineRel: "" }, { GOVERNOR_BASELINE_REL: "Env/B.md" }, yes).baselineRel, "", "a present key is kept, even blank");
    for (const junk of [null, "garbage", ["R"]]) assert.deepEqual(withBaselineSeed(junk, { GOVERNOR_BASELINE_REL: "Env/B.md" }, yes), EMPTY_VAULT_CONVENTIONS, `${String(junk)}: not an object, plain coercion`);
  });

  test("conventionsOnLoad passes env and exists() through to the seed", () => {
    const seed = LEGACY_CONVENTIONS_SEED.baselineRel;
    assert.equal(conventionsOnLoad({ vaultConventions: {} }, undefined, {}, () => true).conventions.baselineRel, seed);
    assert.equal(conventionsOnLoad({ vaultConventions: {} }, undefined, {}, () => false).conventions.baselineRel, "");
    assert.equal(conventionsOnLoad({ vaultConventions: {} }, undefined, { GOVERNOR_BASELINE_REL: "Env/B.md" }).conventions.baselineRel, "Env/B.md");
    assert.equal(conventionsOnLoad({ vaultConventions: {} }, undefined, {}, () => true).persist, true);
  });

  test("the pre-#403 branch (stored has no vaultConventions key) honours the BASELINE_REL override, else the legacy seed path", () => {
    const pre = { readOnly: false, guardedTerritories: [] };
    assert.deepEqual(conventionsOnLoad(pre, undefined, { GOVERNOR_BASELINE_REL: " Env/B.md " }), { conventions: { ...LEGACY_CONVENTIONS_SEED, baselineRel: "Env/B.md" }, persist: true }, "the override, trimmed; the other keys are the seed");
    assert.equal(conventionsOnLoad(pre, undefined, { ASSENT_BASELINE_REL: "Old/B.md" }).conventions.baselineRel, "Old/B.md", "the legacy spelling");
    assert.deepEqual(conventionsOnLoad(pre, undefined, { GOVERNOR_BASELINE_REL: "  " }).conventions, LEGACY_CONVENTIONS_SEED, "a blank override: the seed");
    assert.deepEqual(conventionsOnLoad(pre, undefined, {}).conventions, LEGACY_CONVENTIONS_SEED);
    assert.equal(conventionsOnLoad(null, { readOnly: true }, { GOVERNOR_BASELINE_REL: "Env/B.md" }).conventions.baselineRel, "Env/B.md", "an ADOPTED install too");
    assert.deepEqual(conventionsOnLoad(null, undefined, { GOVERNOR_BASELINE_REL: "Env/B.md" }).conventions, EMPTY_VAULT_CONVENTIONS, "a fresh install is EMPTY, override or not");
  });

  test("the CLI env path (VAULT_MCP_CONVENTIONS) is NOT seeded: a record lacking baselineRel reads blank (the CLI falls back to the plugin's data.json instead)", () => {
    const env = (o) => conventionsFromEnv({ [CONVENTIONS_ENV]: JSON.stringify(o) }, () => {});
    assert.equal(env({ registriesRoot: "R" }).baselineRel, "", "an upgraded record lacking the key");
    assert.equal(env({ ungovernedRoots: ["U"] }).baselineRel, "");
    assert.equal(env({}).baselineRel, "");
    assert.equal(env({ registriesRoot: "R", baselineRel: " Mine.md " }).baselineRel, "Mine.md", "a present key is read, trimmed");
    assert.equal(conventionsFromEnv({ GOVERNOR_VAULT_CONVENTIONS: JSON.stringify({ systemRoot: "S" }) }, () => {}).baselineRel, "", "the legacy spelling too");
  });

  test("#493: a STORED blank baselineRel is kept blank — the operator cleared it; it is not re-seeded", () => {
    assert.deepEqual(conventionsOnLoad({ vaultConventions: { registriesRoot: "R", baselineRel: "" } }), { conventions: { ...EMPTY_VAULT_CONVENTIONS, registriesRoot: "R" }, persist: false });
    assert.deepEqual(conventionsOnLoad({ vaultConventions: { baselineRel: "   " } }).conventions.baselineRel, "");
    assert.equal(conventionsOnLoad({ vaultConventions: { baselineRel: "   " } }).persist, false);
  });
  test("#493: the seed's baselineRel is the former DEFAULT_BASELINE_REL note, under its folder's current name (#505), so an upgrade reads the same note", () => {
    assert.equal(LEGACY_CONVENTIONS_SEED.baselineRel, "00-09 System/00 System management/00.89 vault-mcp/Archive/Build/Conformance baseline.md");
    assert.ok(LEGACY_CONVENTIONS_SEED.baselineRel.startsWith(LEGACY_CONVENTIONS_SEED.ungovernedRoots[0] + "/"), "the baseline sits in the seed's own ungoverned root");
    assert.equal(EMPTY_VAULT_CONVENTIONS.baselineRel, "", "the plugin ships no baseline path");
  });
});

describe("the settings fields — one per key of the record", () => {
  test("CONVENTION_FIELDS covers every key of the record exactly once, and each key's kind matches its value shape", () => {
    assert.deepEqual(CONVENTION_FIELDS.map((f) => f.key).sort(), Object.keys(EMPTY_VAULT_CONVENTIONS).sort());
    for (const f of CONVENTION_FIELDS) {
      assert.equal(f.kind, Array.isArray(EMPTY_VAULT_CONVENTIONS[f.key]) ? "paths" : "path", f.key);
      assert.ok(f.help.length > 20 && f.label.length > 3);
    }
  });
  test("commitConvention: what the tab stores is what the next run reads — a blanked path field is a DEAD convention on that run; a list field commits its lines", () => {
    const reg = CONVENTION_FIELDS.find((f) => f.key === "registriesRoot");
    const ung = CONVENTION_FIELDS.find((f) => f.key === "ungovernedRoots");
    const blanked = commitConvention(LEGACY_CONVENTIONS_SEED, reg, "   ");
    assert.equal(blanked.registriesRoot, "");
    assert.deepEqual(blanked.systemRoot, LEGACY_CONVENTIONS_SEED.systemRoot, "the other keys are untouched");
    const walk = { dirs: [LEGACY_CONVENTIONS_SEED.systemRoot, ...LEGACY_CONVENTIONS_SEED.ungovernedRoots], files: [] };
    assert.deepEqual(deadConventionPaths(blanked, walk), [{ key: "registriesRoot", path: "" }], "the blank field is the one dead convention of the next run");
    const pointed = commitConvention(blanked, reg, ` ${LEGACY_CONVENTIONS_SEED.registriesRoot} `);
    assert.deepEqual(deadConventionPaths(pointed, { ...walk, dirs: [...walk.dirs, LEGACY_CONVENTIONS_SEED.registriesRoot] }), [], "pointing it at a live folder revives it");
    assert.deepEqual(commitConvention({}, ung, " A \n\nB/ ").ungovernedRoots, ["A", "B/"]);
    assert.deepEqual(commitConvention("garbage", reg, "R"), { ...EMPTY_VAULT_CONVENTIONS, registriesRoot: "R" }, "a corrupt current value cannot crash the tab");
  });

  test("conventionFieldValue: a path trims; paths split lines, trim, drop blanks", () => {
    const pathF = CONVENTION_FIELDS.find((f) => f.key === "registriesRoot");
    const listF = CONVENTION_FIELDS.find((f) => f.key === "ungovernedRoots");
    assert.equal(conventionFieldValue(pathF, "  R/x  "), "R/x");
    assert.equal(conventionFieldValue(pathF, "   "), "");
    assert.deepEqual(conventionFieldValue(listF, " A \n\nB/\n"), ["A", "B/"]);
  });
});

describe("#493: baselineRel is a setting, not a pack convention", () => {
  test("deadConventionPaths never names baselineRel — blank or set, the file present or absent", () => {
    const dirs = [LEGACY_CONVENTIONS_SEED.registriesRoot, LEGACY_CONVENTIONS_SEED.systemRoot, ...LEGACY_CONVENTIONS_SEED.ungovernedRoots];
    const rel = LEGACY_CONVENTIONS_SEED.baselineRel;
    const cases = [
      ["blank, nothing walked", { ...EMPTY_VAULT_CONVENTIONS, baselineRel: "" }, { dirs: [], files: [] }],
      ["blank, seed folders live", { ...LEGACY_CONVENTIONS_SEED, baselineRel: "" }, { dirs, files: [] }],
      ["set, file present", LEGACY_CONVENTIONS_SEED, { dirs, files: [rel] }],
      ["set, file absent", LEGACY_CONVENTIONS_SEED, { dirs, files: [] }],
      ["set, a FOLDER at the path", LEGACY_CONVENTIONS_SEED, { dirs: [...dirs, rel], files: [] }],
    ];
    for (const [name, conv, walk] of cases) {
      assert.ok(!deadConventionPaths(conv, walk).some((d) => d.key === "baselineRel"), name);
    }
    assert.deepEqual(deadConventionPaths(LEGACY_CONVENTIONS_SEED, { dirs, files: [rel] }), [], "seed folders live: nothing dead at all");
    assert.deepEqual(deadConventionPaths({ ...EMPTY_VAULT_CONVENTIONS, baselineRel: "" }, { dirs: [], files: [] }).map((d) => d.key), ["registriesRoot", "systemRoot"], "the blank SCALAR keys are still dead");
  });

  test("no file under src names 'Conformance baseline.md' in code, except LEGACY_CONVENTIONS_SEED in vault-conventions.ts (comments excluded)", () => {
    const srcRoot = path.join(HERE, "..", "src");
    // Strip comments: block comments, then whole-line `//` comments and `*` continuation lines, then trailing `// …` after code.
    const code = (text) =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
        .split("\n")
        .map((l) => (/^\s*(\/\/|\*)/.test(l) ? "" : l.replace(/\s\/\/\s.*$/, "")))
        .join("\n");
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && /\.(ts|mjs|js)$/.test(p)) {
          code(fs.readFileSync(p, "utf8")).split("\n").forEach((l, i) => {
            if (l.includes("Conformance baseline.md")) hits.push(`${path.relative(srcRoot, p)}:${i + 1}`);
          });
        }
      }
    };
    walk(srcRoot);
    assert.equal(hits.length, 1, `exactly one code line names the note: ${hits.join(", ")}`);
    assert.match(hits[0], /^kernel\/vault-conventions\.ts:\d+$/);
    const vc = src("kernel/vault-conventions.ts");
    const seedBlock = vc.slice(vc.indexOf("export const LEGACY_CONVENTIONS_SEED"), vc.indexOf("};", vc.indexOf("export const LEGACY_CONVENTIONS_SEED")));
    assert.match(seedBlock, /baselineRel: "[^"]*Conformance baseline\.md"/, "the one hit is the seed's baselineRel");
  });
});

describe("who supplies the conventions — source-scan pins against 'threaded but never read'", () => {
  test("LEGACY_CONVENTIONS_SEED has exactly ONE reader in the satellite beside its definition: conventions-policy.ts", () => {
    const readers = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && p.endsWith(".ts") && fs.readFileSync(p, "utf8").includes("LEGACY_CONVENTIONS_SEED")) readers.push(path.relative(path.join(HERE, "..", "src"), p));
      }
    };
    walk(path.join(HERE, "..", "src"));
    assert.deepEqual(readers.sort(), ["kernel/conventions-policy.ts", "kernel/vault-conventions.ts"]);
  });
  test("runConformance reads NO environment for conventions; runCli supplies them from VAULT_MCP_CONVENTIONS", () => {
    const cli = src("kernel/cli.ts");
    assert.ok(!/vaultConventionsFrom|GOVERNOR_VAULT_CONVENTIONS/.test(cli), "the old reader and the old knob are gone from the runner");
    assert.match(cli, /const conventions = conventionsFromEnv\(process\.env\);/, "runCli reads the conventions from the environment ONCE");
    assert.match(cli, /const baselineRel = baselineRelFrom\(process\.env, conventions\) \|\| pluginRel;/, "…and the baseline path from that same read, the plugin's data.json as the fallback (#493)");
    assert.match(cli, /rebaselineTargetRefusal\(baselinePath, root, \[\s*baselineRel,\s*conventions\.baselineRel,\s*pluginRel,\s*pluginBaselineRel\(root, \{\}\),?\s*\]\)/, "--rebaseline guards EVERY live path it can see: the invocation's, the conventions' own (when the env override shadows it), and the plugin's, with and without this shell's override");
    assert.match(cli, /const exists = \(r: string\) => existsSync\(join\(vault, r\)\);/, "pluginBaselineRel asks the disk whether a note exists");
    assert.match(cli, /conventionsOnLoad\(own, undefined, env, exists\)/, "pluginBaselineRel derives the satellite's path by the plugin's own load rule, not the raw key");
    assert.match(cli, /conventionsFromHostData\(host, env, exists\)/, "…and the host's by the rule the satellite adopts by");
    assert.match(cli, /^\s*conventions,\s*$/m, "…and fills the runner's option with that same read");
    assert.equal((cli.match(/conventionsFromEnv\(process\.env\)/g) ?? []).length, 1, "one read, in runCli — no second");
    assert.match(cli, /const conv = opts\.conventions;/, "the runner reads the option, nothing else");
  });
  test("the in-app sources are handed a per-call conventions thunk from the live settings", () => {
    const main = src("main.ts");
    assert.match(main, /private conventions = \(\) => conventionsNow\(this\.settings\);/, "main.ts reads the live settings per call");
    assert.match(main, /obsidianDebtRenderSource\(this\.app, this\.territories, this\.conventions\)/, "main.ts supplies the debt source's conventions thunk as the THIRD argument");
    assert.match(main, /obsidianDriftSource\(this\.app, this\.territories, this\.conventions\)/, "main.ts supplies the drift pane's thunk");
    assert.match(src("obsidian-debt-source.ts"), /conventions: conventions\?\.\(\) \?\? EMPTY_VAULT_CONVENTIONS/, "the debt source reads the thunk per run, EMPTY without one");
    assert.match(src("obsidian-drift-source.ts"), /conventions: conventions\?\.\(\) \?\? EMPTY_VAULT_CONVENTIONS/, "the drift source reads the thunk per run, EMPTY without one");
    for (const f of ["obsidian-debt-source.ts", "obsidian-drift-source.ts"]) {
      assert.match(src(f), /inAppBaselineRefusal\([^;]*, inAppBaselineFromEnv\(conventions\?\.\(\)\)\)/, `${f} tells the refusal where the path came from, per call`);
    }
  });
  test("the settings tab is wired: every field commits through commitConvention on blur and saves", () => {
    const tab = src("settings-tab.ts");
    assert.match(tab, /for \(const field of CONVENTION_FIELDS\)/, "one field per CONVENTION_FIELDS entry, not a hand-written subset");
    assert.match(tab, /void this\.host\.setConventions\(commitConvention\(this\.host\.getConventions\(\), field, raw\)\);/, "the commit is the pure rule, then a save");
    assert.equal((tab.match(/addEventListener\("blur", \(\) => commit\(t\.inputEl\.value\)\)/g) ?? []).length, 2, "both field kinds commit on blur (textarea and text)");
    assert.match(tab, /import \{ CONVENTION_FIELDS, commitConvention \} from "\.\/kernel\/conventions-policy\.js"/);
    assert.match(src("main.ts"), /setConventions: async \(next\) => \{\s*this\.settings\.vaultConventions = next;\s*await this\.saveData\(this\.settings\);/, "main.ts stores and saves what the tab commits");
  });

  test("settings.ts loads a stored record through conventionsOnLoad(raw, undefined, env, exists) and main.ts persists when asked", () => {
    const settings = src("settings.ts");
    assert.match(settings, /const loaded = conventionsOnLoad\(r, undefined, env, exists\);/, "the env and an on-disk exists() reach the seed");
    assert.match(src("main.ts"), /const loaded = settingsOf\(await this\.loadData\(\), process\.env, this\.exists\);\s*this\.settings = loaded\.settings;\s*if \(loaded\.persist\)/);
    assert.match(settings, /return resolveConventions\(settings\.vaultConventions \?\? EMPTY_VAULT_CONVENTIONS\);/, "with no stored record the rail reads EMPTY");
  });
});
