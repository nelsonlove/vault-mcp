// Follow-ups to #621 (schemes are opt-in, 01.33 pick A step b): the host's JD
// model comes from its own schemes, an unreadable saved value is warned about
// and kept, the settings page writes a scheme row only for a real value and
// has a plain on/off, and the scheme panes and command follow whether a
// scheme exists. Every id, path and expansion here is made up.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installObsidianStub, TFile } from "./obsidian-stub.mjs";

installObsidianStub();
const VaultMcpPlugin = (await import("../src/main.ts")).default;
const { ObsidianBackend } = await import("../src/mcp/obsidian-backend.ts");
const { builtinModules, setSchemeOn, schemeModuleEnabled } = await import("../src/mcp/modules-mount.ts");
const { jdModelFromSchemes, schemesOnLoad } = await import("@vault-mcp/core");

const LOC = { path: "/opt/example/state/local/settings.json", source: "default" };
function harness(data) {
  const p = new VaultMcpPlugin();
  const state = { disk: data === undefined ? null : structuredClone(data), writes: 0 };
  p.loadData = async () => (state.disk === null ? null : structuredClone(state.disk));
  p.saveData = async (d) => {
    state.writes++;
    state.disk = structuredClone(d);
  };
  p.localSettings = { state: "absent", location: LOC };
  return { p, state };
}
const BASE = { readOnly: false, guardedTerritories: [], recordFolders: { enabled: false, folders: [], archivePattern: "" }, host: { autoRegisterClaude: false } };
const PLAIN_JD = [{ id: "jd", provider: "johnny-decimal" }];
const MADE_UP = [{ id: "jd", provider: "johnny-decimal", config: { expandedAreas: ["50-59"] } }];

describe("2. the host's matched_by uses the host's own schemes, never VAULT_MCP_SCHEMES", () => {
  const dest = new TFile("50-59 Builds/52021 Thing.md");
  const plainDest = new TFile("00-09 System/06 Tooling/06.11 Probe.md");
  const app = (file) => ({ metadataCache: { getFirstLinkpathDest: () => file }, vault: {} });

  test("a host JD scheme with the expansion reports jd-id; with no scheme, not", async () => {
    const withJd = new ObsidianBackend(app(dest), undefined, undefined, undefined, () => jdModelFromSchemes(MADE_UP));
    assert.equal((await withJd.resolve(["52021"]))[0].matched_by, "jd-id");
    const plain = new ObsidianBackend(app(plainDest), undefined, undefined, undefined, () => jdModelFromSchemes(PLAIN_JD));
    assert.equal((await plain.resolve(["06.11"]))[0].matched_by, "jd-id");
    const none = new ObsidianBackend(app(plainDest));
    assert.notEqual((await none.resolve(["06.11"]))[0].matched_by, "jd-id");
  });

  test("a malformed VAULT_MCP_SCHEMES in the host's environment never makes a resolve throw", async () => {
    const saved = process.env.VAULT_MCP_SCHEMES;
    process.env.VAULT_MCP_SCHEMES = "{not json";
    try {
      const b = new ObsidianBackend(app(plainDest), undefined, undefined, undefined, () => jdModelFromSchemes(PLAIN_JD));
      assert.equal((await b.resolve(["06.11"]))[0].matched_by, "jd-id");
      const none = new ObsidianBackend(app(plainDest));
      await assert.doesNotReject(() => none.resolve(["06.11"]));
    } finally {
      if (saved === undefined) delete process.env.VAULT_MCP_SCHEMES;
      else process.env.VAULT_MCP_SCHEMES = saved;
    }
  });

  test("jdModelFromSchemes: none for no JD row or a config the provider refuses; never throws", () => {
    assert.equal(jdModelFromSchemes([]), null);
    assert.equal(jdModelFromSchemes("jd"), null);
    assert.equal(jdModelFromSchemes([{ id: "x", provider: "other" }]), null);
    assert.equal(jdModelFromSchemes([{ id: "jd", provider: "johnny-decimal", config: { expandedAreas: "50-59" } }]), null);
    assert.deepEqual([...jdModelFromSchemes(MADE_UP).expandedAreas], ["50-59"]);
  });

  test("server.ts hands the backend a model from the host's settings", () => {
    const src = readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
    assert.match(src, /recordIdentification, \(\) => jdModelFromSchemes\(ctx\.getSettings\(\)\.schemes\)\)/);
  });
});

describe("5. a saved schemes value that is not a list", () => {
  test("schemesOnLoad warns and does not ask to save", () => {
    const r = schemesOnLoad({ schemes: "jd" });
    assert.deepEqual(r.schemes, []);
    assert.equal(r.persist, false);
    assert.match(r.warning, /not a list/);
  });

  test("the plugin warns, runs with no scheme, and a save keeps the saved value as it was", async () => {
    const h = harness({ ...BASE, schemes: { id: "jd" } });
    const warned = [];
    const warn = console.warn;
    console.warn = (m) => warned.push(String(m));
    try {
      await h.p.loadSettings();
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(h.p.settings.schemes, []);
    assert.ok(warned.some((m) => /schemes.*not a list/.test(m)), "warned");
    h.p.settings.readOnly = true;
    await h.p.saveSettings();
    assert.deepEqual(h.state.disk.schemes, { id: "jd" }, "the saved value is not rewritten");
    // Once a real list is set, it is saved.
    h.p.settings.schemes = PLAIN_JD;
    await h.p.saveSettings();
    assert.deepEqual(h.state.disk.schemes, PLAIN_JD);
  });
});

describe("6. the settings page: a row only for a real value, and a plain on/off", () => {
  const binding = builtinModules({ getSettings: () => ({}), schemeNotes: () => [] }).find((m) => m.id === "scheme").configBinding;

  test("typing in a field and clearing it writes no row, so JD stays off", () => {
    const s0 = { schemes: [] };
    assert.equal(binding.write(s0, { expandedAreas: [] }), s0, "an empty value writes nothing");
    assert.equal(binding.write(s0, { contentDecimalFloor: undefined }), s0);
    const s1 = binding.write(s0, { expandedAreas: ["50-59"] });
    assert.equal(s1.schemes.length, 1, "a real value turns JD on");
    const s2 = binding.write(s1, { expandedAreas: [] });
    assert.deepEqual(s2.schemes, [], "clearing the only value removes the row the page made");
  });

  test("an existing row is never removed by clearing a field", () => {
    const s = binding.write({ schemes: [{ ...PLAIN_JD[0], config: { expandedAreas: ["50-59"] } }] }, { expandedAreas: [] });
    assert.equal(s.schemes.length, 1);
  });

  test("setSchemeOn with no row: on adds the plain jd row", () => {
    const on = setSchemeOn({ schemes: [] }, true);
    assert.deepEqual(on.schemes, PLAIN_JD);
    const same = { schemes: MADE_UP };
    assert.equal(setSchemeOn(same, true), same, "already on: unchanged");
  });

  test("on -> off -> on returns the user's own rows byte for byte; off keeps them, marked off", () => {
    const rows = [
      { id: "jd", provider: "johnny-decimal", config: { expandedAreas: ["50-59"], expandedCategories: ["34"], contentDecimalFloor: 20 }, excludedRoots: ["Old stuff"] },
      { id: "num", provider: "johnny-decimal", config: { expandedCategories: ["41"] } },
      { id: "odd", provider: "not-a-real-provider" },
    ];
    const start = { readOnly: true, schemes: structuredClone(rows) };
    const before = JSON.stringify(start);
    const off = setSchemeOn(start, false);
    assert.equal(off.schemes.length, 3, "no row is deleted");
    assert.ok(off.schemes.every((r) => r.enabled === false));
    assert.equal(schemeModuleEnabled(off), false, "off: as with no rows");
    const on = setSchemeOn(off, true);
    assert.equal(JSON.stringify(on), before, "byte for byte");
    assert.equal(JSON.stringify(start), before, "the input is not changed");
  });

  test("off: no scheme tools, no addressing, and the rows still validate", async () => {
    const { mountModules } = await import("../src/mcp/modules-mount.ts");
    const { fakeServer } = await import("./fake-server.mjs");
    const { makeRegistry, allSchemeRowsTaken } = await import("../src/kernel/scheme/registry.ts");
    const off = setSchemeOn({ schemes: MADE_UP }, false);
    const server = fakeServer();
    mountModules((n, d, h) => server.registerTool(n, d, h), { getSettings: () => off, schemeNotes: () => [] });
    assert.deepEqual([...server.tools.keys()], []);
    const reg = makeRegistry(off.schemes);
    assert.equal(reg.instances().length, 0);
    assert.equal(reg.parseRef("jd:06.11"), null);
    assert.deepEqual(reg.offIds(), ["jd"]);
    assert.equal(allSchemeRowsTaken(off.schemes), true, "an off row is a good row");
    assert.equal(jdModelFromSchemes(off.schemes), null);
  });

  test("a missing flag means on, so an existing install does not change; a non-boolean flag is refused", async () => {
    const { makeRegistry, allSchemeRowsTaken } = await import("../src/kernel/scheme/registry.ts");
    assert.equal(makeRegistry(PLAIN_JD).instances().length, 1);
    assert.equal(schemeModuleEnabled({ schemes: PLAIN_JD }), true);
    assert.equal(makeRegistry([{ ...PLAIN_JD[0], enabled: true }]).instances().length, 1);
    const quiet = console.error;
    console.error = () => {};
    try {
      assert.equal(allSchemeRowsTaken([{ ...PLAIN_JD[0], enabled: "no" }]), false);
    } finally {
      console.error = quiet;
    }
  });

  test("the override still wins and locks the on/off; a save never writes it", async () => {
    const { p, state } = (() => {
      const p = new VaultMcpPlugin();
      const state = { disk: { ...BASE, schemes: PLAIN_JD }, writes: 0 };
      p.loadData = async () => structuredClone(state.disk);
      p.saveData = async (d) => { state.writes++; state.disk = structuredClone(d); };
      const override = { schemes: MADE_UP };
      p.localSettings = { state: "loaded", location: LOC, override, keys: ["schemes"] };
      return { p, state };
    })();
    await p.loadSettings();
    assert.deepEqual(p.settings.schemes, MADE_UP);
    // A turn-off attempted anyway (the tab locks the control) is set back before the save writes.
    p.settings = setSchemeOn(p.settings, false);
    await p.saveSettings();
    assert.deepEqual(state.disk.schemes, PLAIN_JD, "the synced file keeps its own rows");
    assert.deepEqual(p.settings.schemes, MADE_UP, "memory keeps the override");
  });

  test("the settings tab renders the on/off, locked by an override of schemes", () => {
    const ui = readFileSync(new URL("../src/connection-ui.ts", import.meta.url), "utf8");
    assert.match(ui, /this\.lock\(new Setting\(section\), "schemes"\)\s*\.setName\("Use a scheme \(Johnny Decimal\)"\)/);
    assert.match(ui, /setSchemeOn\(this\.plugin\.settings, value\)/);
  });
});

describe("7. the scheme panes and command follow whether a scheme exists", () => {
  test("a save reconciles the panes: none with no scheme, mounted once one is added", async () => {
    const h = harness({ ...BASE, schemes: [] });
    await h.p.loadSettings();
    const calls = [];
    h.p.setSchemePanesMounted = async (v) => calls.push(v);
    h.p.schemeSurfaceLive = true;
    await h.p.saveSettings();
    h.p.settings.schemes = PLAIN_JD;
    await h.p.saveSettings();
    h.p.settings.modules = { scheme: { enabled: false } };
    await h.p.saveSettings();
    assert.deepEqual(calls, [false, true, false]);
    assert.equal(schemeModuleEnabled({ schemes: [] }), false);
  });

  test("onload mounts on schemeModuleEnabled, and the command is offered only while it holds", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    assert.match(main, /if \(!headlessAtLoad && schemeModuleEnabled\(this\.settings\)\) \{\s*void this\.setSchemePanesMounted\(true\);/);
    assert.match(main, /registerSchemeCommands\(this, \(\) => schemeModuleEnabled\(this\.settings\)\)/);
    const wiring = readFileSync(new URL("../src/scheme/wiring.ts", import.meta.url), "utf8");
    assert.match(wiring, /checkCallback: \(checking: boolean\) => \{\s*if \(!isEnabled\(\)\) return false;/);
  });
});

