/**
 * conformance-cli.test.mjs — the CLI's testable core `runConformance`: snapshot
 * → build packs from settings → engine → ratchet vs a baseline → result +
 * report. The thin `main` (argv/env/read/print/exit) is not unit-tested; this
 * pins the wiring.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runConformance, runCli, guardedTerritoryRefusal, NON_PATH_KEYED_CHECKS } from "../src/kernel/cli.ts";
import fs from "node:fs";
import { ENGINE_ID } from "../src/kernel/engine.ts";
import { coverageRefusal, baselinePackIds, RETIRED_CHECKS, retiredClears } from "../src/kernel/cli.ts";
import { parseBaseline } from "../src/kernel/ratchet.ts";
import { fileURLToPath } from "node:url";
import { LEGACY_CONVENTIONS_SEED as SEED } from "../src/kernel/vault-conventions.ts";

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "conf-cli-"));
  await mkdir(path.join(root, "Notes"), { recursive: true });
  // an unregistered tag → a vocab finding (no vocab registry configured here, so
  // an empty registry means every tag is unregistered — deterministic)
  await writeFile(path.join(root, "Notes", "A.md"), "---\ntitle: A\ntags:\n  - rogue\n---\nbody\n");
  return root;
}

describe("runConformance", () => {
  test("empty baseline → the note's findings are all NEW and the run fails", async () => {
    const root = await vault();
    try {
      const res = await runConformance({
        root,
        conventions: SEED,
        baselineText: "",
        vocabularies: [{ id: "reg", provider: "blueprint", root: "Reg" }], // Reg is empty → 'rogue' unregistered
        schemes: [],
      });
      assert.ok(res.ratchet.newKeys.length >= 1, "at least the unregistered tag is NEW");
      assert.equal(res.ratchet.failed, true);
      assert.equal(res.exitCode, 1);
      assert.ok(res.report.includes("NEW"), "report mentions NEW findings");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("baseline containing the finding → carried, run passes", async () => {
    const root = await vault();
    try {
      // first run to learn the exact keys, then baseline them. Legacy packs
      // OFF: this pins the vocab ratchet round-trip, and over a fixture whose
      // conventions are dead the engine's `dead_convention` finding is NEW on
      // every run BY DESIGN (#298 — it describes configuration, not debt, and
      // is never rebaseline text), which would fail the "everything carried"
      // claim for a reason that is not this test's subject.
      const first = await runConformance({ root, conventions: SEED, baselineText: "", vocabularies: [{ id: "reg", provider: "blueprint", root: "Reg" }], schemes: [], legacyPacks: false });
      const baselineText = "```ratchet-baseline\n" + first.rebaseline + "\n```\n";
      const second = await runConformance({ root, conventions: SEED, baselineText, vocabularies: [{ id: "reg", provider: "blueprint", root: "Reg" }], schemes: [], legacyPacks: false });
      assert.equal(second.ratchet.newKeys.length, 0, "everything now carried");
      assert.equal(second.ratchet.failed, false);
      assert.equal(second.exitCode, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rebaseline output is the sorted key body for the live findings", async () => {
    const root = await vault();
    try {
      const res = await runConformance({ root, conventions: SEED, baselineText: "", vocabularies: [{ id: "reg", provider: "blueprint", root: "Reg" }], schemes: [] });
      // every rebaseline line is a 4-field key
      for (const line of res.rebaseline.split("\n").filter(Boolean)) {
        assert.equal(line.split("|").length >= 4, true, `key has >=4 fields: ${line}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("writeFence", () => {
  test("inserts a body containing $-sequences literally (no String.replace pattern expansion)", async () => {
    const { writeFence } = await import("../src/kernel/cli.ts");
    const note = "prose\n\n```ratchet-baseline\nold|a|b|c\n```\n\nmore\n";
    const body = "vocab_findings|unregistered_tag|Notes/Price $& Deal.md|rogue";
    const out = writeFence(note, body);
    assert.ok(out.includes("Notes/Price $& Deal.md"), "literal $& preserved");
    assert.equal(out.includes("old|a|b|c"), false, "old fence body replaced");
    assert.equal((out.match(/```ratchet-baseline/g) || []).length, 1, "exactly one fence");
  });
  test("appends a fence when the note has none", async () => {
    const { writeFence } = await import("../src/kernel/cli.ts");
    const out = writeFence("# just prose\n", "s|c|t|k");
    assert.ok(out.includes("```ratchet-baseline\ns|c|t|k\n```"));
  });
  test("throws on an opening marker with no complete fence (corrupt baseline) rather than silently no-op", async () => {
    const { writeFence } = await import("../src/kernel/cli.ts");
    assert.throws(() => writeFence("```ratchet-baseline\nunclosed key line\n", "s|c|t|k"), /corrupt|complete fence/);
  });
});

// The gate's DEFAULT was inverted here by #116, and the reason is measured, not
// stylistic: the accepted-debt baseline's keys are exclusively legacy-pack keys,
// so a default run without these packs reported the ENTIRE baseline (124 of 124)
// as CLEARED on every invocation — a guaranteed false "all accepted debt is now
// fixed" result. The opt-IN this suite originally pinned (#103 follow-up) was
// correct while the ports were unproven and became wrong once the baseline was
// restored and measured against them. The gate itself is unchanged and still
// tested; only which way it points by default moved.
describe("legacyPacks gate — default ON since #116, opt-out with legacyPacks:false", () => {
  test("legacy packs ON by default; OFF with legacyPacks:false", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const pth = (await import("node:path")).default;
    const { runConformance } = await import("../src/kernel/cli.ts");
    const root = await mkdtemp(pth.join(tmpdir(), "conf-gate2-"));
    try {
      await mkdir(pth.join(root, "N"), { recursive: true });
      await writeFile(pth.join(root, "N", "A.md"), "prose with a semicolon; here\n");
      const byDefault = await runConformance({ root, conventions: SEED, baselineText: "", vocabularies: [], schemes: [] });
      assert.equal(byDefault.findings.some((f) => f.script === "ste_lint"), true, "legacy packs ON by default (#116)");
      const off = await runConformance({ root, conventions: SEED, baselineText: "", vocabularies: [], schemes: [], legacyPacks: false });
      assert.equal(off.findings.some((f) => f.script === "ste_lint" || f.script === "port_lint" || f.script === "conformance_check"), false, "legacy packs off with explicit opt-out");
      const on = await runConformance({ root, conventions: SEED, baselineText: "", vocabularies: [], schemes: [], legacyPacks: true });
      assert.equal(on.findings.some((f) => f.script === "ste_lint"), true, "legacy packs on when asked explicitly");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("baselineMissingRefusal (#116 — a missing baseline must fail loudly)", () => {
  test("missing baseline refuses, naming the path and both escapes", async () => {
    const { baselineMissingRefusal } = await import("../src/kernel/cli.ts");
    const r = baselineMissingRefusal("/vault/Assent/Build/conformance/Conformance baseline.md", false, false);
    assert.ok(r, "expected a refusal");
    assert.match(r, /baseline not found/);
    assert.match(r, /Conformance baseline\.md/);
    assert.match(r, /--baseline=/);
    assert.match(r, /--no-baseline/);
  });

  test("an existing baseline proceeds", async () => {
    const { baselineMissingRefusal } = await import("../src/kernel/cli.ts");
    assert.equal(baselineMissingRefusal("/x", true, false), null);
  });

  test("--no-baseline is the explicit from-zero opt-in, even when missing", async () => {
    const { baselineMissingRefusal } = await import("../src/kernel/cli.ts");
    assert.equal(baselineMissingRefusal("/x", false, true), null);
  });

  test("the refusal is about SILENCE, not about forbidding zero baselines", async () => {
    const { baselineMissingRefusal } = await import("../src/kernel/cli.ts");
    // missing + explicit opt-in => allowed; missing + no opt-in => refused.
    assert.equal(baselineMissingRefusal("/x", false, true), null);
    assert.ok(baselineMissingRefusal("/x", false, false));
  });
});

describe("#398 — a guarded territory inside the root is skipped, reported, and never a silent CLEARED", () => {
  const vocab = [{ id: "reg", provider: "blueprint", root: "Reg" }];

  test("the run completes, the skipped folder is in the result and named in the report, and nothing under it was read", async () => {
    const root = await vault();
    try {
      await mkdir(path.join(root, "80-89 Sensitive"), { recursive: true });
      await writeFile(path.join(root, "80-89 Sensitive", "L.md"), "---\ntitle: L\ntags:\n  - rogue\n---\nprivate\n");
      const res = await runConformance({ root, conventions: SEED, baselineText: "", vocabularies: vocab, schemes: [], territories: ["80-89"] });
      assert.deepEqual(res.skippedTerritories, [{ path: "80-89 Sensitive", territory: "80-89" }]);
      assert.match(res.report, /guarded \(not scanned, no claim made\): 80-89 Sensitive \(guarded territory '80-89'\)/, "the report names the folder and the entry");
      assert.ok(!res.findings.some((f) => f.target.startsWith("80-89 Sensitive/")), "no finding came out of the territory — it was never read");
      assert.ok(res.findings.some((f) => f.target === "Notes/A.md"), "the rest of the vault was measured");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an accepted-baseline key under a skipped territory REFUSES the run instead of reporting CLEARED", async () => {
    const root = await vault();
    try {
      await mkdir(path.join(root, "80-89 Sensitive"), { recursive: true });
      await writeFile(path.join(root, "80-89 Sensitive", "L.md"), "---\ntitle: L\ntags:\n  - rogue\n---\nprivate\n");
      // Baseline taken while the territory was NOT listed: its key is accepted debt.
      const first = await runConformance({ root, conventions: SEED, baselineText: "", vocabularies: vocab, schemes: [] });
      assert.ok(first.rebaseline.includes("80-89 Sensitive/L.md"), "fixture: the baseline holds a key inside the folder");
      const baselineText = "```ratchet-baseline\n" + first.rebaseline + "\n```\n";
      await assert.rejects(
        () => runConformance({ root, conventions: SEED, baselineText, vocabularies: vocab, schemes: [], territories: ["80-89"] }),
        /refusing to run: a guarded territory was skipped \(80-89 Sensitive\)[\s\S]*inside a guarded territory this run skipped[\s\S]*CLEARED/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("guardedTerritoryRefusal: segment-bounded, names the way out, silent when nothing is stranded", () => {
    assert.equal(guardedTerritoryRefusal(new Set(["ste_lint|editable|Notes/x.md|"]), ["80-89 Sensitive"]), null);
    assert.equal(guardedTerritoryRefusal(new Set(["ste_lint|editable|80-89 Sensitive notes/x.md|"]), ["80-89 Sensitive"]), null, "a sibling folder is not swept in");
    const r = guardedTerritoryRefusal(new Set(["ste_lint|editable|80-89 Sensitive/x.md|"]), ["80-89 Sensitive"]);
    assert.ok(r);
    assert.match(r, /take the folder off the guarded-territories list|remove the keys from the baseline/);
    assert.equal(guardedTerritoryRefusal(new Set(["ste_lint|editable|80-89 Sensitive/x.md|"]), []), null, "nothing skipped, nothing stranded");
  });
});

describe("#398 / #400 review — a uid-keyed baseline key must not clear silently behind a skip", () => {
  const vocab = [{ id: "reg", provider: "blueprint", root: "Reg" }];

  test("a uid-keyed baseline key the live run does not reproduce: CLEARED when nothing was skipped, REFUSED when something was", async () => {
    // Drift's E key carries a uid, not a path, so the strand
    // check cannot place them inside or outside a skipped folder. The bare
    // fixture cannot make the drift pack emit one (it needs vault scaffolding —
    // #298), so the key is planted in the baseline: what is under test is the
    // rule, not drift's appetite.
    const root = await vault();
    try {
      await mkdir(path.join(root, "80-89 Sensitive"), { recursive: true });
      await writeFile(path.join(root, "80-89 Sensitive", "L.md"), "---\ntitle: L\n---\nprivate\n");
      const eKey = "drift_audit|E|01234567-89ab-7cde-8f01-23456789abcd|dup-uid";
      const baselineText = "```ratchet-baseline\n" + eKey + "\n```\n";
      const plain = await runConformance({ root, conventions: SEED, baselineText, vocabularies: vocab, schemes: [] });
      assert.ok(plain.ratchet.clearedKeys.includes(eKey), "nothing skipped: the unreproduced key is an ordinary CLEARED");
      await assert.rejects(
        () => runConformance({ root, conventions: SEED, baselineText, vocabularies: vocab, schemes: [], territories: ["80-89"] }),
        /keyed by uid, not by path[\s\S]*\|E\|/,
        "a skip plus a cleared uid key refuses: nothing can tell whether the skip is what cleared it",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("NON_PATH_KEYED_CHECKS names exactly the checks drift.ts keys without a path (pinned at the source)", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const drift = fs.readFileSync(path.join(here, "..", "src", "kernel", "packs", "drift.ts"), "utf8");
    assert.match(drift, /push\("E",[\s\S]{0,200}target: uid,/, "E is keyed by uid");
    assert.doesNotMatch(drift, /push\(\s*"F"/, "F is retired (#412), so it must not be listed either");
    assert.deepEqual([...NON_PATH_KEYED_CHECKS].sort(), ["drift_audit|E"]);
  });

  test("guardedTerritoryRefusal is silent with nothing skipped, even over a cleared uid key", () => {
    assert.equal(guardedTerritoryRefusal(new Set(), [], ["drift_audit|E|x|dup-uid"]), null);
    assert.ok(guardedTerritoryRefusal(new Set(), ["80-89 Sensitive"], ["drift_audit|E|x|dup-uid"]));
    assert.equal(guardedTerritoryRefusal(new Set(), ["80-89 Sensitive"], ["ste_lint|editable|Notes/x.md|"]), null, "a path-keyed clear outside the folder is a real clear");
  });
});

describe("#298 — a dead convention path is a loud finding and an unmeasured pack, never a clean report", () => {
  const vocab = [{ id: "reg", provider: "blueprint", root: "Reg" }];

  test("over a vault where the seed's conventions name nothing: one dead_convention finding per key, both dependent packs unmeasured, the report says so", async () => {
    const root = await vault();
    try {
      const res = await runConformance({ root, conventions: SEED, baselineText: "", vocabularies: vocab, schemes: [] });
      const dead = res.findings.filter((f) => f.script === ENGINE_ID && f.check === "dead_convention");
      assert.deepEqual(dead.map((f) => f.target).sort(), ["fileclassesRoot", "registriesRoot", "systemRoot", "ungovernedRoots"]);
      assert.deepEqual(res.deadConventions.length, 4);
      assert.ok(res.packIds.includes("drift_audit") && res.packIds.includes("conformance_check"), "the packs still REGISTER");
      assert.ok(!res.coveredPackIds.includes("drift_audit") && !res.coveredPackIds.includes("conformance_check"), "but are NOT covered");
      assert.ok(res.coveredPackIds.includes("port_lint") && res.coveredPackIds.includes("ste_lint"), "packs that read no convention still run");
      assert.ok(!res.findings.some((f) => f.script === "drift_audit"), "a pack with a dead convention emits nothing of its own — not clean, not noise");
      assert.ok(!res.findings.some((f) => f.script === ENGINE_ID && f.check === "pack_error"), "and it does not RUN — it would throw over this fixture (#136), and that throw must not be how it is silenced");
      assert.match(res.report, /DEAD CONVENTION: registriesRoot = .* — 'conformance_check' not measured/);
      assert.match(res.report, /DEAD CONVENTION: systemRoot = .* — 'drift_audit' not measured/);
      assert.ok(!res.rebaseline.includes("conformance_engine|"), "an engine finding is never rebaseline text — it describes the run, and a baseline naming it would refuse every later run as uncovered (#401 review)");
      // The consequence, stated: over a vault whose conventions are dead the run
      // is NEW on every run until the operator re-points or retires the packs.
      // That is the issue's own preference ("silently clean is the one option
      // that should not stay"), and it cannot be silenced through --rebaseline.
      const again = await runConformance({ root, conventions: SEED, baselineText: "```ratchet-baseline\n" + res.rebaseline + "\n```\n", vocabularies: vocab, schemes: [] });
      assert.ok(again.ratchet.newKeys.some((k) => k.startsWith(`${ENGINE_ID}|dead_convention|`)), "still NEW after a rebaseline");
      assert.ok(res.ratchet.newKeys.some((k) => k.startsWith(`${ENGINE_ID}|dead_convention|`)), "and the finding is NEW, so the run fails loudly");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("with the conventions OPTION pointing at live paths, nothing is dead and drift_audit is measured", async () => {
    const root = await vault();
    try {
      for (const d of ["Sys/Registries", "Sys/Framework", "Sys/Fileclasses"]) await mkdir(path.join(root, d), { recursive: true });
      const live = { registriesRoot: "Sys/Registries", systemRoot: "Sys", fileclassesRoot: "Sys/Fileclasses", ungovernedRoots: ["Sys/Framework"] };
      const res = await runConformance({ root, conventions: live, baselineText: "", vocabularies: vocab, schemes: [] });
      assert.deepEqual(res.deadConventions, []);
      assert.ok(!res.findings.some((f) => f.check === "dead_convention"));
      assert.ok(res.coveredPackIds.includes("drift_audit") && res.coveredPackIds.includes("conformance_check"));
      assert.doesNotMatch(res.report, /DEAD CONVENTION/);
      assert.doesNotMatch(res.report, /RETIRED CHECK/, "nothing cleared, nothing retired to name");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("#412: a baseline key of a RETIRED check clears at pack granularity (drift_audit ran) — the report names it as cleared by retirement, not repair; an E key that clears is an ordinary clear", async () => {
    const root = await vault();
    try {
      for (const d of ["Sys/Registries", "Sys/Framework", "Sys/Fileclasses"]) await mkdir(path.join(root, d), { recursive: true });
      const live = { registriesRoot: "Sys/Registries", systemRoot: "Sys", fileclassesRoot: "Sys/Fileclasses", ungovernedRoots: ["Sys/Framework"] };
      const A = "drift_audit|A|choice 'X' is command-enabled but no .action entry names it|", G = "drift_audit|G|x.tag.md title is 'None', the filename says 'x.tag'|", E = "drift_audit|E|01234567-89ab-7cde-8f01-23456789abcd|dup-uid";
      const res = await runConformance({ root, conventions: live, baselineText: "```ratchet-baseline\n" + [A, G, E].join("\n") + "\n```\n", vocabularies: vocab, schemes: [] });
      assert.ok(res.coveredPackIds.includes("drift_audit"), "the pack ran, so the coverage refusal does not fire");
      assert.equal(coverageRefusal(baselinePackIds(parseBaseline("```ratchet-baseline\n" + A + "\n```\n")), new Set(res.coveredPackIds), "run"), null, "pack granularity cannot see a retired check");
      for (const k of [A, G, E]) assert.ok(res.ratchet.clearedKeys.includes(k), `${k} clears`);
      assert.deepEqual(retiredClears(res.ratchet.clearedKeys).sort(), [A, G].sort(), "the two retired keys, not the live E");
      assert.match(res.report, /RETIRED CHECK: 2 of the 3 cleared key\(s\) clear because their check was retired \(#412: drift_audit A\/B\/D\/F\/G\), not because the vault was fixed — prune them by a reviewed rebaseline \(--rebaseline --baseline=<copy>, then a human applies it to the acceptance record\)/);
      assert.deepEqual([...RETIRED_CHECKS].sort(), ["drift_audit|A", "drift_audit|B", "drift_audit|D", "drift_audit|F", "drift_audit|G"]);
      const drift = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "kernel", "packs", "drift.ts"), "utf8");
      for (const c of RETIRED_CHECKS) assert.doesNotMatch(drift, new RegExp(`push\\(\\s*"${c.split("|")[1]}"`), `${c} is indeed retired in the pack`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a baseline that describes drift_audit, over a vault where its convention is dead, is REFUSED by coverageRefusal — the #294 rule, fed by the #298 mechanism", async () => {
    const root = await vault();
    try {
      const baselineText = "```ratchet-baseline\ndrift_audit|J|category number 00 is claimed by 2 folders: 00 A; 00 B|\n```\n";
      const res = await runConformance({ root, conventions: SEED, baselineText, vocabularies: vocab, schemes: [] });
      const refusal = coverageRefusal(baselinePackIds(parseBaseline(baselineText)), new Set(res.coveredPackIds), "run");
      assert.ok(refusal && /drift_audit/.test(refusal), "an unmeasured pack with accepted debt refuses rather than clearing it");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("when coverage refuses because a convention is dead, the refusal names the convention and the settings remedy (#401 review; #403 moved the remedy from an env knob to the Conformance settings) — pinned at the source", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const cli = fs.readFileSync(path.join(here, "..", "src", "kernel", "cli.ts"), "utf8");
    const site = cli.slice(cli.indexOf("const coverage = coverageRefusal(baselineIds, covered"), cli.indexOf("// Trend (#211, A3)"));
    assert.match(site, /res\.deadConventions/, "the refusal consults the run's dead conventions");
    assert.match(site, /set it in the plugin settings \(Conformance\) or \$\{CONVENTIONS_ENV\}/, "and names the remedy, not 'enable the packs'");
  });

  test("the drift pack reads its ONE convention from the injected record, never a module constant (pinned at the source; #298, #403, #412)", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const drift = fs.readFileSync(path.join(here, "..", "src", "kernel", "packs", "drift.ts"), "utf8");
    assert.match(drift, /const SYS_ROOT = conv\.systemRoot;/, "J's spine is the per-run conventions");
    assert.doesNotMatch(drift, /DEFAULT_REGISTRIES_ROOT|DEFAULT_SYSTEM_ROOT/, "no shipped constant");
    assert.doesNotMatch(drift, /conv\.registriesRoot/, "the registry-family checks are retired (#412), so the pack no longer reads that key");
  });
});

describe("#403 — the plugin ships EMPTY conventions: every scalar key dead, loudly; the list keys empty are 'none'", () => {
  test("EMPTY conventions: the three scalar keys are dead_convention findings reported as (empty); the list key is not", async () => {
    const root = await vault();
    try {
      const { EMPTY_VAULT_CONVENTIONS } = await import("../src/kernel/vault-conventions.ts");
      const res = await runConformance({ root, conventions: EMPTY_VAULT_CONVENTIONS, baselineText: "", vocabularies: [{ id: "reg", provider: "blueprint", root: "Reg" }], schemes: [] });
      const dead = res.findings.filter((f) => f.script === ENGINE_ID && f.check === "dead_convention");
      assert.deepEqual(dead.map((f) => f.target).sort(), ["fileclassesRoot", "registriesRoot", "systemRoot"]);
      assert.ok(dead.every((f) => f.kind === "" && /is EMPTY/.test(f.detail)), dead.map((f) => f.detail).join("\n"));
      assert.match(res.report, /DEAD CONVENTION: registriesRoot = \(empty\) — 'conformance_check' not measured; set it in the plugin settings \(Conformance\) or VAULT_MCP_CONVENTIONS/);
      assert.match(res.report, /DEAD CONVENTION: systemRoot = \(empty\) — 'drift_audit' not measured/);
      assert.ok(!res.coveredPackIds.includes("drift_audit") && !res.coveredPackIds.includes("conformance_check"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("#403 — the CLI entry reads VAULT_MCP_CONVENTIONS, and a legacy spelling still reaches the run", () => {
  const ENV_KEYS = ["VAULT_MCP_CONVENTIONS", "GOVERNOR_VAULT_CONVENTIONS", "ASSENT_VAULT_CONVENTIONS"];
  const withEnv = async (set, fn) => {
    const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, set);
    try { return await fn(); } finally {
      for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  };
  const liveFixture = async () => {
    const root = await vault();
    for (const d of ["Sys/Registries", "Sys/Framework"]) await mkdir(path.join(root, d), { recursive: true });
    // A baseline that NAMES drift_audit: with the conventions dead the coverage refusal fires (#294 by way of #298).
    const baseline = path.join(root, "baseline.md");
    await writeFile(baseline, "```ratchet-baseline\ndrift_audit|J|category number 00 is claimed by 2 folders: 00 A; 00 B|\n```\n");
    return { root, baseline };
  };
  const LIVE = JSON.stringify({ registriesRoot: "Sys/Registries", systemRoot: "Sys", ungovernedRoots: ["Sys/Framework"] });
  // runCli sets process.exitCode on a failed ratchet, which the test runner would read as this FILE failing; the run's outcome here is its message, so the code is reset after each call.
  const cli = async (...argv) => {
    const savedCode = process.exitCode;
    try { await runCli(argv); return ""; } catch (e) { return e instanceof Error ? e.message : String(e); } finally { process.exitCode = savedCode ?? 0; }
  };

  test("unset: every convention is dead, and the coverage refusal names the settings remedy and VAULT_MCP_CONVENTIONS", async () => {
    const { root, baseline } = await liveFixture();
    try {
      const msg = await withEnv({}, () => cli(`--root=${root}`, `--baseline=${baseline}`));
      assert.match(msg, /DEAD convention path — set it in the plugin settings \(Conformance\) or VAULT_MCP_CONVENTIONS/);
      assert.match(msg, /registriesRoot = \(empty\)/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("VAULT_MCP_CONVENTIONS pointing at live paths: no dead convention, no coverage refusal", async () => {
    const { root, baseline } = await liveFixture();
    try {
      const msg = await withEnv({ VAULT_MCP_CONVENTIONS: LIVE }, () => cli(`--root=${root}`, `--baseline=${baseline}`));
      assert.doesNotMatch(msg, /DEAD convention/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("the legacy spelling GOVERNOR_VAULT_CONVENTIONS still reaches the run (warned), and VAULT_MCP_CONVENTIONS wins when both are set", async () => {
    const { root, baseline } = await liveFixture();
    try {
      const legacy = await withEnv({ GOVERNOR_VAULT_CONVENTIONS: LIVE }, () => cli(`--root=${root}`, `--baseline=${baseline}`));
      assert.doesNotMatch(legacy, /DEAD convention/);
      const both = await withEnv({ VAULT_MCP_CONVENTIONS: "{}", GOVERNOR_VAULT_CONVENTIONS: LIVE }, () => cli(`--root=${root}`, `--baseline=${baseline}`));
      assert.match(both, /DEAD convention path/, "the new spelling (EMPTY here) wins over the legacy one");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
