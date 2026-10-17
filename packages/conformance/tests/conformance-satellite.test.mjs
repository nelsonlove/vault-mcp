/**
 * conformance-satellite.test.mjs — what the move out of the host (2026-10-14)
 * changed, pinned:
 *
 *   • THE PUBLICATION CONTRACT: the wire names (`vaultmcp_conformance_debt`,
 *     `vaultmcp_conformance_debt_render`), the untrusted read-only claim, that
 *     NO argument is a host path key (which is what makes the host refuse the
 *     whole surface under an allowlist), the re-applied schema bounds, and the
 *     coded refusal rendering;
 *   • the one-shot adoption of the host's `vaultConventions` and
 *     `modules["conformance-debt"].config`, including that a host not ready and
 *     a failed persist both HOLD THE LATCH OPEN;
 *   • `conventionsFromHostData`, the rule the adoption and the CLI share;
 *   • the host lookup: the territories are the host's, and "cannot tell"
 *     refuses rather than walking unguarded;
 *   • that no shipped code line names the retired `obsidian_conformance_*` tools.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishInto, HOST_PATH_KEYS, OWNER } from "./host-shim.mjs";
import { buildConformanceTools } from "../src/tools.ts";
import {
  adoptHostSettings,
  runAdoption,
  settingsOf,
  conventionsNow,
  ADOPTABLE_CONFIG_KEYS,
  DEFAULT_PLUGIN_SETTINGS,
  DEBT_FIELDS,
} from "../src/settings.ts";
import { conventionsFromHostData } from "../src/kernel/conventions-policy.ts";
import { EMPTY_VAULT_CONVENTIONS, LEGACY_CONVENTIONS_SEED } from "../src/kernel/vault-conventions.ts";
import {
  findHostPlugin,
  hostGuardedTerritories,
  territoriesOrRefuse,
  hostSettingsOf,
  declaredHeadless,
  TERRITORIES_UNKNOWN,
} from "../src/host-lookup.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The baseline seed prefers the BASELINE_REL env override; clear it for the run.
const BASELINE_ENV = ["GOVERNOR_BASELINE_REL", "ASSENT_BASELINE_REL"];
const saved = BASELINE_ENV.map((k) => [k, process.env[k]]);
before(() => { for (const k of BASELINE_ENV) delete process.env[k]; });
after(() => { for (const [k, v] of saved) if (v !== undefined) process.env[k] = v; else delete process.env[k]; });

function fakeSource(writes = []) {
  return {
    liveFindings: async () => [],
    baselineText: async () => "```ratchet-baseline\n```\n",
    sidecar: async () => ({ version: 1, entries: {} }),
    defaultRegisterDir: () => "R",
    baselineNotePath: () => "R/Conformance baseline.md",
    writeNote: async (p, t) => writes.push({ path: p, text: t }),
  };
}

describe("publication", () => {
  test("the plugin id is the namespace: two tools, published as vaultmcp_conformance_*", () => {
    assert.equal(OWNER, "vaultmcp_conformance");
    const { tools } = publishInto(buildConformanceTools(fakeSource(), { config: () => ({}) }));
    assert.deepEqual([...tools.keys()], ["vaultmcp_conformance_debt", "vaultmcp_conformance_debt_render"]);
  });

  test("the report CLAIMS read-only and the host distrusts the claim by default; the render is mutating", () => {
    const untrusted = publishInto(buildConformanceTools(fakeSource(), { config: () => ({}) })).tools;
    assert.equal(untrusted.get("vaultmcp_conformance_debt").def.claimsReadOnly, true);
    assert.equal(untrusted.get("vaultmcp_conformance_debt").def.annotations.readOnlyHint, false, "untrusted ⇒ registered as mutating");
    const trusted = publishInto(buildConformanceTools(fakeSource(), { config: () => ({}) }), { trusted: true }).tools;
    assert.equal(trusted.get("vaultmcp_conformance_debt").def.annotations.readOnlyHint, true);
    assert.equal(trusted.get("vaultmcp_conformance_debt_render").def.claimsReadOnly, false);
    assert.equal(trusted.get("vaultmcp_conformance_debt_render").def.annotations.readOnlyHint, false);
  });

  test("NOT ONE argument is a host path key — so the host refuses both tools outright under an allowlist", () => {
    // Vacuity guard: the snapshot does hold the keys a path argument would use.
    assert.ok(HOST_PATH_KEYS.includes("path") && HOST_PATH_KEYS.includes("note_path"));
    for (const spec of buildConformanceTools(fakeSource(), { config: () => ({}) })) {
      for (const arg of Object.keys(spec.inputSchema ?? {})) {
        assert.ok(!HOST_PATH_KEYS.includes(arg), `${spec.name}.${arg} must not be a host path key`);
      }
    }
  });

  test("the dropped schema bounds are re-applied: an empty or non-string filter, a bad group_by ⇒ Error [invalid_argument]", async () => {
    const debt = publishInto(buildConformanceTools(fakeSource(), { config: () => ({}) })).tools.get("vaultmcp_conformance_debt");
    for (const args of [{ folder: "" }, { pack: 7 }, { check: "" }, { kind: null }, { group_by: "nope" }]) {
      const res = await debt.handler(args);
      assert.equal(res.isError, true, JSON.stringify(args));
      assert.match(res.content[0].text, /^Error \[invalid_argument\]: /, JSON.stringify(args));
    }
    const ok = await debt.handler({ folder: "A", group_by: "pack" });
    assert.ok(!ok.isError, ok.content[0].text);
  });

  test("a kernel throw renders uncoded, as the host's fail(e) did", async () => {
    const src = { ...fakeSource(), baselineText: async () => { throw new Error("no conformance baseline is configured: x"); } };
    const debt = publishInto(buildConformanceTools(src, { config: () => ({}) })).tools.get("vaultmcp_conformance_debt");
    const res = await debt.handler({});
    assert.equal(res.content[0].text, "Error: no conformance baseline is configured: x");
  });

  test("config is read PER CALL, never captured at build", async () => {
    const config = {};
    const writes = [];
    const render = publishInto(buildConformanceTools(fakeSource(writes), { config: () => config })).tools.get("vaultmcp_conformance_debt_render");
    await render.handler({});
    config.registerDir = "Elsewhere";
    await render.handler({});
    assert.deepEqual(writes.map((w) => w.path), ["R/Conformance debt.md", "Elsewhere/Conformance debt.md"]);
  });

  test("no shipped code line names the retired obsidian_conformance_* tools (comments excluded)", () => {
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
        else if (p.endsWith(".ts") && /obsidian_conformance/.test(code(fs.readFileSync(p, "utf8")))) hits.push(p);
      }
    };
    walk(path.join(HERE, "..", "src"));
    assert.deepEqual(hits, []);
  });
});

describe("settings adoption from the host (one shot)", () => {
  const hostSettings = {
    vaultConventions: { registriesRoot: "Reg", systemRoot: "Sys", ungovernedRoots: ["U"], baselineRel: "B/Base.md" },
    modules: { "conformance-debt": { config: { staleAfterDays: 30, debtBudget: 5, strictBudget: true, registerDir: "Out", registerMaxRows: 10, stray: 1 } } },
  };

  test("adopts the conventions and every debt config key, never an unknown key, and latches", () => {
    const next = adoptHostSettings({ ...DEFAULT_PLUGIN_SETTINGS, config: {} }, hostSettings, {});
    assert.equal(next.adoptedFromHost, true);
    // The host's record predates the shape pack's key, which adopts blank (dead until the operator names the folder).
    assert.deepEqual(next.vaultConventions, { ...hostSettings.vaultConventions, fileclassesRoot: "" });
    assert.deepEqual(next.config, { staleAfterDays: 30, debtBudget: 5, strictBudget: true, registerDir: "Out", registerMaxRows: 10 });
    assert.deepEqual([...ADOPTABLE_CONFIG_KEYS].sort(), ["debtBudget", "registerDir", "registerMaxRows", "staleAfterDays", "strictBudget"]);
    assert.equal(adoptHostSettings(next, hostSettings, {}), null, "latched: never again");
  });

  test("the satellite's own values win", () => {
    const own = { config: { staleAfterDays: 7 }, adoptedFromHost: false, vaultConventions: { ...EMPTY_VAULT_CONVENTIONS, baselineRel: "Mine.md" } };
    const next = adoptHostSettings(own, hostSettings, {});
    assert.equal(next.config.staleAfterDays, 7);
    assert.equal(next.config.debtBudget, 5);
    assert.equal(next.vaultConventions.baselineRel, "Mine.md");
  });

  test("host absent or NOT READY (settings undefined) holds the latch open", () => {
    const cur = { ...DEFAULT_PLUGIN_SETTINGS, config: {} };
    assert.equal(adoptHostSettings(cur, undefined, {}), null);
    const plugins = { "vault-mcp": { api: {}, settings: undefined } };
    assert.equal(hostSettingsOf(plugins), undefined, "an unassigned settings field reads as not ready");
    assert.equal(adoptHostSettings(cur, hostSettingsOf(plugins), {}), null);
  });

  test("a host with neither key still latches, and adopts EMPTY conventions", () => {
    const next = adoptHostSettings({ ...DEFAULT_PLUGIN_SETTINGS, config: {} }, { readOnly: false }, {}, () => false);
    assert.equal(next.adoptedFromHost, true);
    assert.deepEqual(next.vaultConventions, EMPTY_VAULT_CONVENTIONS);
    assert.deepEqual(next.config, {});
  });

  test("a THROWING save leaves the latch open (in memory and for the next load), and the retry succeeds", async () => {
    const cur = { ...DEFAULT_PLUGIN_SETTINGS, config: {} };
    const failed = await runAdoption(cur, hostSettings, async () => { throw new Error("disk full"); }, {});
    assert.equal(failed.adopted, false);
    assert.equal(failed.settings.adoptedFromHost, false);
    assert.equal(failed.settings, cur, "the current record is kept unchanged");
    let saved = null;
    const retried = await runAdoption(failed.settings, hostSettings, async (s) => { saved = s; }, {});
    assert.equal(retried.adopted, true);
    assert.equal(saved.adoptedFromHost, true);
  });

  test("settingsOf: no stored conventions ⇒ absent (the rail reads EMPTY); a stored record is kept; a corrupt data.json degrades", () => {
    const fresh = settingsOf(null, {});
    assert.equal(fresh.settings.vaultConventions, undefined);
    assert.deepEqual(conventionsNow(fresh.settings), EMPTY_VAULT_CONVENTIONS);
    assert.equal(fresh.persist, false);
    const stored = settingsOf({ vaultConventions: { baselineRel: "X.md" }, config: { debtBudget: 1 }, adoptedFromHost: true }, {});
    assert.equal(stored.settings.vaultConventions.baselineRel, "X.md");
    assert.equal(stored.settings.adoptedFromHost, true);
    assert.equal(stored.persist, false);
    const lacking = settingsOf({ vaultConventions: { systemRoot: "S" } }, {});
    assert.equal(lacking.settings.vaultConventions.baselineRel, LEGACY_CONVENTIONS_SEED.baselineRel, "#493 seed for a record lacking only the key");
    assert.equal(lacking.persist, true);
    assert.deepEqual(settingsOf("garbage", {}).settings, { config: {}, adoptedFromHost: false });
  });

  test("one debt-register field per adoptable config key", () => {
    assert.deepEqual(DEBT_FIELDS.map((f) => f.key).sort(), [...ADOPTABLE_CONFIG_KEYS].sort());
  });
});

describe("conventionsFromHostData — what the satellite adopts and the CLI falls back to", () => {
  test("a host record WITH the key: conventionsOnLoad's rule (stored kept; a record lacking only baselineRel seeded)", () => {
    assert.equal(conventionsFromHostData({ vaultConventions: { baselineRel: "A.md" } }, {}).baselineRel, "A.md");
    assert.equal(conventionsFromHostData({ vaultConventions: { systemRoot: "S" } }, {}).baselineRel, LEGACY_CONVENTIONS_SEED.baselineRel);
  });
  test("a host record WITHOUT the key: the legacy seed only when the legacy baseline note exists; else EMPTY (or the env override)", () => {
    assert.deepEqual(conventionsFromHostData({ readOnly: false }, {}, () => false), EMPTY_VAULT_CONVENTIONS);
    assert.deepEqual(conventionsFromHostData({ readOnly: false }, {}, (r) => r === LEGACY_CONVENTIONS_SEED.baselineRel), LEGACY_CONVENTIONS_SEED);
    assert.deepEqual(conventionsFromHostData({ readOnly: false }, { GOVERNOR_BASELINE_REL: "Env.md" }, () => false), { ...EMPTY_VAULT_CONVENTIONS, baselineRel: "Env.md" });
  });
});

describe("host lookup", () => {
  test("only a plugin exposing `api` is the host; vault-mcp first", () => {
    assert.equal(findHostPlugin({ governor: { settings: {} } }), null, "the governance provider has no api");
    const host = { api: {}, settings: {} };
    assert.equal(findHostPlugin({ governor: { settings: {} }, "vault-mcp": host }), host);
  });

  test("territories come from api.guardedTerritories(); 'cannot tell' is null and the rail REFUSES", () => {
    assert.deepEqual(hostGuardedTerritories({ "vault-mcp": { api: { guardedTerritories: () => ["80-89"] } } }), ["80-89"]);
    assert.deepEqual(hostGuardedTerritories({ "vault-mcp": { api: { guardedTerritories: () => [] } } }), [], "an empty list guards nothing, honestly");
    for (const plugins of [undefined, {}, { "vault-mcp": { api: {} } }, { "vault-mcp": { api: { guardedTerritories: () => "x" } } }, { "vault-mcp": { api: { guardedTerritories: () => { throw new Error(); } } } }]) {
      assert.equal(hostGuardedTerritories(plugins), null);
      assert.throws(() => territoriesOrRefuse(plugins), (e) => e.message === TERRITORIES_UNKNOWN);
    }
  });

  test("headless is declared by the host's setting, else VAULT_MCP_HEADLESS", () => {
    assert.equal(declaredHeadless({ "vault-mcp": { api: {}, settings: { host: { headless: "on" } } } }, {}), true);
    assert.equal(declaredHeadless({ "vault-mcp": { api: {}, settings: { host: { headless: "off" } } } }, { VAULT_MCP_HEADLESS: "1" }), false);
    assert.equal(declaredHeadless(undefined, { VAULT_MCP_HEADLESS: "true" }), true);
    assert.equal(declaredHeadless(undefined, {}), false);
  });
});

describe("the territory thunk is FORWARDED, never dropped (#396 review, moved from the host's territory-policy test)", () => {
  // The #397 defect in miniature, twice: a parameter accepted and never passed
  // on. `obsidianDebtRenderSource(app, territories)` once spread
  // `obsidianDebtSource(app)`, and the drift wiring once built
  // `obsidianDriftSource(app)`. Both walks ran unguarded.
  const src = (rel) => fs.readFileSync(path.join(HERE, "..", "src", rel), "utf8");
  test("the render source hands BOTH thunks to the inner source", () => {
    assert.match(src("obsidian-debt-source.ts"), /\.\.\.obsidianDebtSource\(app, territories, conventions\)/);
  });
  test("main.ts supplies the host's territories, read per run, to the tools AND the Drift pane", () => {
    const main = src("main.ts");
    assert.match(main, /private territories = \(\): readonly string\[\] => territoriesOrRefuse\(this\.plugins\(\)\);/);
    assert.match(main, /obsidianDebtRenderSource\(this\.app, this\.territories, this\.conventions\)/);
    assert.match(main, /obsidianDriftSource\(this\.app, this\.territories, this\.conventions\)/);
  });
  test("both sources call the thunk inside the run, so a refusal surfaces per call", () => {
    for (const f of ["obsidian-debt-source.ts", "obsidian-drift-source.ts"]) {
      assert.match(src(f), /territories: territories\?\.\(\),/, f);
    }
  });
});
