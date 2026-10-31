// Schemes are opt-in (01.33 "Move the scheme tools out of vault-mcp core",
// pick A, step b): a fresh install has no scheme, the Johnny Decimal
// provider's own defaults expand nothing, an install that predates the
// `schemes` key keeps the one jd instance it had, and a machine's expansions
// can come from the machine-local override (#579). Every expansion, path and
// value here is made up.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { installObsidianStub } from "./obsidian-stub.mjs";
import { FIXTURE_JD_CONFIG } from "./scheme-fixture.mjs";

installObsidianStub();
const L = await import("../src/local-settings.ts");
const VaultMcpPlugin = (await import("../src/main.ts")).default;
const { makeRegistry, DEFAULT_SCHEMES, JD_SCHEME_INSTANCE, schemesOnLoad, refuseSchemeRefs } = await import("../src/kernel/scheme/registry.ts");
const { DEFAULT_JD_CONFIG, jdProvider } = await import("../src/kernel/scheme/jd.ts");

const LOC = { path: "/opt/example/state/local/settings.json", source: "default" };

/** A plugin over an in-memory data.json (the local-settings suite's harness, trimmed). */
function harness(data, override, adopted) {
  const p = new VaultMcpPlugin();
  const state = { disk: data === undefined ? null : structuredClone(data), writes: 0 };
  p.loadData = async () => (state.disk === null ? null : structuredClone(state.disk));
  p.saveData = async (d) => {
    state.writes++;
    state.disk = structuredClone(d);
  };
  p.localSettings = override ? { state: "loaded", location: LOC, override, keys: L.overridePaths(override) } : { state: "absent", location: LOC };
  if (adopted) p.adoptedSettings = structuredClone(adopted);
  return { p, state };
}

const PLAIN_JD = [{ id: "jd", provider: "johnny-decimal" }];

/** A made-up expansion: one area band and one category with 5-digit items. */
const MADE_UP = { expandedAreas: ["50-59"], expandedCategories: ["34"] };
const NOTES = [
  "00-09 System/06 Tooling/06.11 Bridge.md",
  "50-59 Projects/52 Builds/52021 Big thing/52021.md",
  "50-59 Projects/52 Builds/52021 Big thing/52021.10 Sub.md",
  "30-39 Home/34 Garden/34001 Seeds.md",
  "30-39 Home/34 Garden/34002 Tools.md",
];

describe("the shipped defaults", () => {
  test("DEFAULT_SCHEMES is empty and DEFAULT_JD_CONFIG expands nothing", () => {
    assert.deepEqual(DEFAULT_SCHEMES, []);
    assert.deepEqual(DEFAULT_JD_CONFIG, { expandedAreas: [], expandedCategories: [] });
    assert.deepEqual({ ...JD_SCHEME_INSTANCE }, { id: "jd", provider: "johnny-decimal" }, "the opt-in row carries no config");
  });

  test("with no scheme, a jd: string is an ordinary path, not refused", () => {
    assert.doesNotThrow(() => refuseSchemeRefs({ path: "jd:06.11" }, makeRegistry(DEFAULT_SCHEMES)));
  });
});

describe("schemesOnLoad", () => {
  test("no stored settings (a fresh install): no scheme, saved", () => {
    assert.deepEqual(schemesOnLoad(null), { schemes: [], persist: true });
  });
  test("stored settings without the key (an older install): the plain jd instance, saved once", () => {
    assert.deepEqual(schemesOnLoad({ readOnly: false }), { schemes: PLAIN_JD, persist: true });
  });
  test("a saved list is kept as it is, and not saved again", () => {
    assert.deepEqual(schemesOnLoad({ schemes: [] }), { schemes: [], persist: false });
    const custom = [{ id: "num", provider: "johnny-decimal", config: { expandedCategories: ["41"] } }];
    assert.deepEqual(schemesOnLoad({ schemes: custom }), { schemes: custom, persist: false });
  });
  test("settings adopted from the pre-split plugin count as an existing install, and are saved", () => {
    assert.deepEqual(schemesOnLoad(null, { readOnly: true }), { schemes: PLAIN_JD, persist: true });
    assert.deepEqual(schemesOnLoad(null, { schemes: [] }), { schemes: [], persist: true });
  });
  test("a stored value that is not a list reads as no scheme", () => {
    assert.deepEqual(schemesOnLoad({ schemes: "jd" }).schemes, []);
  });
});

describe("the plugin's loadSettings", () => {
  test("a fresh install gets schemes: [] and writes it, so a later load keeps it", async () => {
    const h = harness(undefined);
    await h.p.loadSettings();
    assert.deepEqual(h.p.settings.schemes, []);
    assert.deepEqual(h.state.disk.schemes, []);
    assert.equal(makeRegistry(h.p.settings.schemes).instances().length, 0);
    const again = harness(h.state.disk);
    await again.p.loadSettings();
    assert.deepEqual(again.p.settings.schemes, []);
    assert.equal(again.state.writes, 0, "nothing to persist on the second load");
  });

  test("an install that never saved the key keeps the plain jd instance and writes it once", async () => {
    const h = harness({ readOnly: false, guardedTerritories: [], recordFolders: { enabled: false, folders: [], archivePattern: "" }, host: { autoRegisterClaude: false } });
    await h.p.loadSettings();
    assert.deepEqual(h.p.settings.schemes, PLAIN_JD);
    assert.deepEqual(h.state.disk.schemes, PLAIN_JD);
    assert.equal(h.state.writes, 1);
    const again = harness(h.state.disk);
    await again.p.loadSettings();
    assert.equal(again.state.writes, 0, "written once: the second load finds the key");
  });

  test("a saved list is kept, empty or not", async () => {
    for (const schemes of [[], PLAIN_JD, [{ id: "num", provider: "johnny-decimal", config: MADE_UP }]]) {
      const h = harness({ readOnly: false, schemes, guardedTerritories: [], recordFolders: { enabled: false, folders: [], archivePattern: "" }, host: { autoRegisterClaude: false } });
      await h.p.loadSettings();
      assert.deepEqual(h.p.settings.schemes, schemes);
      assert.equal(h.state.writes, 0);
    }
  });
});

describe("expansions from the machine-local override", () => {
  const synced = { readOnly: false, schemes: PLAIN_JD, guardedTerritories: [], recordFolders: { enabled: false, folders: [], archivePattern: "" }, host: { autoRegisterClaude: false } };
  const overrideWith = (config) => ({ schemes: [{ id: "jd", provider: "johnny-decimal", config }] });

  test("the override's shape check takes a list of scheme rows, and refuses a row that is not an object", () => {
    const shape = { schemes: [] };
    assert.deepEqual(L.checkOverride(overrideWith(MADE_UP), shape), []);
    assert.deepEqual(L.checkOverride({ schemes: ["jd"] }, shape), ["schemes[0] must be an object"]);
    assert.deepEqual(L.checkOverride({ schemes: { id: "jd" } }, shape), ["schemes must be a list, not an object"]);
  });

  test("a row the registry would skip is a use-time problem, so the plugin refuses to serve", async () => {
    const registers = (rows) => makeRegistry(rows).instances().length === rows.length;
    const quiet = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(L.useTimeProblems(overrideWith(MADE_UP), () => true, registers), []);
      assert.equal(L.useTimeProblems(overrideWith({ expandedAreas: "50-59" }), () => true, registers).length, 1);
      assert.equal(L.useTimeProblems({ schemes: [{ id: "jd", provider: "no-such-provider" }] }, () => true, registers).length, 1);
      assert.equal(L.useTimeProblems({ schemes: [...PLAIN_JD, ...PLAIN_JD] }, () => true, registers).length, 1, "a repeated id");
      const h = harness(synced, overrideWith({ expandedCategories: ["3"] }));
      await assert.rejects(h.p.loadSettings(), /schemes holds a row the scheme registry does not take/);
      assert.equal(h.state.writes, 0, "a refused override never reaches a save");
    } finally {
      console.error = quiet;
    }
  });

  test("a synced jd instance with no config plus an override with expansions answers as an expanded vault", async () => {
    const h = harness(synced, overrideWith(MADE_UP));
    await h.p.loadSettings();
    const reg = makeRegistry(h.p.settings.schemes);
    const jd = reg.get("jd");
    const lookUp = (addr) => reg.resolve(jd, jd.provider.parse(addr), NOTES);
    // Expanded area: 5-digit items and their fractal ids.
    assert.equal(jd.provider.parse("52021")?.kind, "expanded-item");
    assert.equal(jd.provider.parse("52021.10")?.kind, "fractal-id");
    assert.deepEqual(lookUp("52021.10"), ["50-59 Projects/52 Builds/52021 Big thing/52021.10 Sub.md"]);
    // Expanded category: flat 5-digit items, and the next free one.
    assert.equal(jd.provider.parse("34001")?.kind, "expanded-item");
    assert.deepEqual(lookUp("34002"), ["30-39 Home/34 Garden/34002 Tools.md"]);
    assert.equal(jd.provider.format(jd.provider.nextFree({ kind: "category", token: "34" }, NOTES)), "34003");
    // Plain JD is unchanged.
    assert.deepEqual(lookUp("06.11"), ["00-09 System/06 Tooling/06.11 Bridge.md"]);
    // Without the override the same synced row expands nothing.
    const bare = makeRegistry(synced.schemes).get("jd");
    assert.equal(bare.provider.parse("52021"), null);
    assert.equal(bare.provider.parse("34001"), null);
  });

  test("the override gives the same answers a provider built with those expansions gives", async () => {
    const h = harness(synced, overrideWith(FIXTURE_JD_CONFIG));
    await h.p.loadSettings();
    const viaOverride = makeRegistry(h.p.settings.schemes).get("jd").provider;
    const direct = jdProvider({ ...DEFAULT_JD_CONFIG, ...FIXTURE_JD_CONFIG });
    for (const token of ["06.11", "06", "00-09", "92021", "92021.10", "27001", "27", "90-99", "91", "26 2.18"]) {
      assert.deepEqual(viaOverride.parse(token), direct.parse(token), token);
    }
    const listing = ["90-99 Projects/92 Builds/92021 Thing/92021.md", "20-29 Home/27 Garden/27001 Seeds.md"];
    for (const scope of [{ kind: "category", token: "27" }, { kind: "area", token: "90-99" }]) {
      assert.deepEqual(viaOverride.nextFree(scope, listing), direct.nextFree(scope, listing), scope.token);
    }
  });

  test("a save keeps the override out of data.json: the synced file keeps its plain jd row", async () => {
    const h = harness(synced, overrideWith(MADE_UP));
    await h.p.loadSettings();
    h.p.settings.readOnly = true;
    await h.p.saveSettings();
    assert.deepEqual(h.state.disk.schemes, PLAIN_JD);
    assert.deepEqual(h.p.settings.schemes[0].config, MADE_UP, "memory keeps this machine's expansions");
  });
});
