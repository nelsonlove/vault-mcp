// The machine-local settings override (#579, src/local-settings.ts): a file
// outside the vault whose keys win over the synced data.json. Every path and
// value here is made up.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installObsidianStub } from "./obsidian-stub.mjs";
import { fakeServer } from "./fake-server.mjs";
import { spawnSync } from "node:child_process";

installObsidianStub();
const L = await import("../src/local-settings.ts");
const P = await import("../src/paths.ts");
const { registerCoreTools } = await import("../src/mcp/tools-core.ts");
const D = await import("../src/discovery.ts");
const { loadDiscoveryDir } = await import("../bridge/bridge.ts");
const VaultMcpPlugin = (await import("../src/main.ts")).default;

/** A settings shape like the plugin's defaults: fixed objects, open maps, lists. */
const SHAPE = {
  readOnly: false,
  allowlist: [],
  captureMaxBytes: 1024,
  redactConfig: "",
  modules: {},
  schemes: [{ id: "jd", provider: "johnny-decimal" }],
  protectedProperties: [{ key: "k", grade: "agent-forbidden" }],
  writeScope: { mode: "all", paths: [] },
  host: { headless: "auto", stateDir: "", socketPath: "", autoRegisterClaude: false },
  cliPolicy: { deny: [], allowOpaque: [], neverOpaque: [], opaqueWildcards: [], opaqueSnapshot: {} },
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-local-"));
const write = (dir, text) => {
  const p = path.join(dir, L.LOCAL_SETTINGS_FILE);
  fs.writeFileSync(p, text);
  return p;
};
const at = (p, source = "default") => ({ path: p, source });

const ENV = ["VAULT_MCP_STATE_DIR", "VAULT_MCP_LOCAL_SETTINGS"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  P.configurePaths({});
});

describe("where the override is looked up", () => {
  test("the variable when set, else local/settings.json under the base state dir (never beside the discovery files)", () => {
    assert.deepEqual(L.localSettingsLocation("/opt/example/state", {}), { path: "/opt/example/state/local/settings.json", source: "default" });
    assert.deepEqual(L.localSettingsLocation("/opt/example/state", { VAULT_MCP_LOCAL_SETTINGS: " /etc/example/vm.json " }), { path: "/etc/example/vm.json", source: "env" });
    assert.equal(L.localSettingsLocation("/opt/example/state", { VAULT_MCP_LOCAL_SETTINGS: "  " }).source, "default", "a blank variable is unset");
  });

  test("the base state dir ignores the host.stateDir setting: a synced value cannot move the override", () => {
    delete process.env.VAULT_MCP_STATE_DIR;
    P.configurePaths({ stateDir: "/srv/example/synced-state" });
    assert.equal(P.stateDir(), "/srv/example/synced-state", "the setting still moves the socket and the bridge");
    assert.equal(P.baseStateDir(), path.join(os.homedir(), ".claude", "vault-mcp"));
    process.env.VAULT_MCP_STATE_DIR = "/srv/example/env-state";
    assert.equal(P.baseStateDir(), "/srv/example/env-state", "the environment does move it");
  });

  test("main.ts reads the override first in onload, through baseStateDir, before settings load and before any path is configured", () => {
    const main = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const load = main.slice(main.indexOf("async onload()"));
    const read = load.indexOf("readLocalSettings(");
    assert.ok(read > 0);
    assert.ok(load.slice(read, read + 200).includes("baseStateDir()"), "looked up through the environment only");
    for (const later of ["runHostAdoption(", "this.loadSettings()", "configurePaths(", "writeBridge()", "listener.listen()", "this.autoRegister()"]) {
      assert.ok(read < load.indexOf(later), `${later} comes after the override is read`);
    }
    assert.match(load.slice(read, load.indexOf("runHostAdoption(")), /state === "error"[\s\S]*refuseToServe\([\s\S]*return;/, "an unusable file stops onload");
  });
});

describe("reading the file", () => {
  test("an absent file is no override", () => {
    const dir = tmp();
    const r = L.readLocalSettings(at(path.join(dir, L.LOCAL_SETTINGS_FILE)), SHAPE);
    assert.equal(r.state, "absent");
    assert.deepEqual(L.localSettingsReport(r), { path: path.join(dir, L.LOCAL_SETTINGS_FILE), source: "default", found: false, overridden_keys: [] });
  });

  test("a file the variable names but that is absent fails closed", () => {
    const r = L.readLocalSettings(at(path.join(tmp(), "missing.json"), "env"), SHAPE);
    assert.equal(r.state, "error");
    assert.match(r.error, /no file there/);
  });

  test("a relative path fails closed", () => {
    const r = L.readLocalSettings(at("example/vm.json", "env"), SHAPE);
    assert.equal(r.state, "error");
    assert.match(r.error, /absolute/);
  });

  test("bad JSON fails closed, never an empty override", () => {
    const r = L.readLocalSettings(at(write(tmp(), '{"readOnly": true,')), SHAPE);
    assert.equal(r.state, "error");
    assert.match(r.error, /not valid JSON/);
  });

  test("not a regular file fails closed: a folder, and a link to nothing", () => {
    const dir = tmp();
    const folder = path.join(dir, L.LOCAL_SETTINGS_FILE);
    fs.mkdirSync(folder);
    assert.match(L.readLocalSettings(at(folder), SHAPE).error, /not a regular file/);
    const dir2 = tmp();
    const link = path.join(dir2, L.LOCAL_SETTINGS_FILE);
    fs.symlinkSync(path.join(dir2, "gone.json"), link);
    const r = L.readLocalSettings(at(link), SHAPE);
    assert.equal(r.state, "error");
    assert.match(r.error, /link to nothing/);
  });

  test("a link to a regular file is read", () => {
    const dir = tmp();
    const real = path.join(dir, "real.json");
    fs.writeFileSync(real, '{"readOnly": true}');
    const link = path.join(dir, L.LOCAL_SETTINGS_FILE);
    fs.symlinkSync(real, link);
    const r = L.readLocalSettings(at(link), SHAPE);
    assert.equal(r.state, "loaded");
    assert.deepEqual(r.keys, ["readOnly"]);
  });

  test("a wrong type for a known key fails closed", () => {
    for (const [text, why] of [
      ['{"readOnly": "yes"}', /readOnly must be a boolean, not string/],
      ['{"allowlist": "Projects"}', /allowlist must be a list/],
      ['{"allowlist": ["Projects", 4]}', /allowlist\[1\] must be a string/],
      ['{"host": "on"}', /host must be an object/],
      ['{"host": {"autoRegisterClaude": "no"}}', /host.autoRegisterClaude must be a boolean/],
      ['{"schemes": ["jd"]}', /schemes\[0\] must be an object/],
      ['{"writeScope": null}', /writeScope is null/],
      ['[1, 2]', /one JSON object, not list/],
    ]) {
      const r = L.readLocalSettings(at(write(tmp(), text)), SHAPE);
      assert.equal(r.state, "error", text);
      assert.match(r.error, why, text);
    }
  });

  test("unknown keys: refused at the top and under a fixed object, accepted under an open map", () => {
    const top = L.readLocalSettings(at(write(tmp(), '{"writescope": {"mode": "create-only"}}')), SHAPE);
    assert.equal(top.state, "error", "a misspelt key would do nothing, which for a stricter machine is loosening");
    assert.match(top.error, /writescope is not a setting/);
    const nested = L.readLocalSettings(at(write(tmp(), '{"host": {"headles": "on"}}')), SHAPE);
    assert.match(nested.error, /host.headles is not a setting/);
    const open = L.readLocalSettings(at(write(tmp(), '{"modules": {"scheme": {"enabled": false, "config": {"x": [1]}}}}')), SHAPE);
    assert.equal(open.state, "loaded");
    assert.deepEqual(open.keys, ["modules.scheme.config.x", "modules.scheme.enabled"]);
  });

  test("a key that would reach a prototype is refused", () => {
    const r = L.readLocalSettings(at(write(tmp(), '{"modules": {"__proto__": {"polluted": true}}}')), SHAPE);
    assert.equal(r.state, "error");
    assert.match(r.error, /__proto__ is not an allowed key/);
    assert.equal({}.polluted, undefined);
  });
});

describe("the merge", () => {
  const synced = {
    readOnly: false,
    allowlist: ["Projects", "Areas"],
    host: { headless: "off", stateDir: "", socketPath: "", autoRegisterClaude: true },
    writeScope: { mode: "all", paths: ["Inbox/*.md"] },
    modules: { scheme: { enabled: true, config: { a: 1 } } },
  };

  test("objects merge key by key: the override's keys win, the rest stay synced", () => {
    const out = L.mergeOverride(synced, { host: { headless: "on", autoRegisterClaude: false } });
    assert.deepEqual(out.host, { headless: "on", stateDir: "", socketPath: "", autoRegisterClaude: false });
    assert.deepEqual(out.allowlist, ["Projects", "Areas"]);
    assert.equal(synced.host.headless, "off", "the synced object is not changed");
  });

  test("a list replaces, it does not merge", () => {
    assert.deepEqual(L.mergeOverride(synced, { allowlist: ["Inbox"] }).allowlist, ["Inbox"]);
  });

  test("an empty list replaces a full one", () => {
    const out = L.mergeOverride(synced, { writeScope: { mode: "create-only", paths: [] } });
    assert.deepEqual(out.writeScope, { mode: "create-only", paths: [] });
  });

  test("deep merge reaches into open maps", () => {
    const out = L.mergeOverride(synced, { modules: { scheme: { config: { b: 2 } } } });
    assert.deepEqual(out.modules.scheme, { enabled: true, config: { a: 1, b: 2 } });
  });

  test("the result shares no object with the override", () => {
    const override = { allowlist: ["Inbox"] };
    const out = L.mergeOverride(synced, override);
    out.allowlist.push("Other");
    assert.deepEqual(override.allowlist, ["Inbox"]);
  });

  test("the overridden key names are the leaves, sorted; an empty object sets nothing", () => {
    assert.deepEqual(L.overridePaths({ writeScope: { mode: "create-only", paths: [] }, readOnly: true, modules: {} }), ["readOnly", "writeScope.mode", "writeScope.paths"]);
  });

  test("a value the setting's normalizer changes is caught", () => {
    const override = { host: { headless: "onn", stateDir: "/srv/example/state" } };
    const normalized = { host: { headless: "auto", stateDir: "/srv/example/state" } };
    assert.deepEqual(L.normalizedMismatches(normalized, override, L.overridePaths(override)), ["host.headless"]);
    assert.deepEqual(L.normalizedMismatches({ p: [{ grade: "g", key: "k" }] }, { p: [{ key: "k", grade: "g" }] }, ["p"]), [], "key order does not count");
  });

  test("main.ts merges before the normalizers and refuses a value they change, before any save", () => {
    const main = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const load = main.slice(main.indexOf("async loadSettings()"), main.indexOf("async saveSettings()"));
    const merge = load.indexOf("mergeOverride(");
    assert.ok(merge > 0 && merge < load.indexOf("normalizeHostSettings("), "merged before the normalizers");
    const check = load.indexOf("normalizedMismatches(");
    assert.ok(check > load.indexOf("normalizeHostSettings(") && check < load.indexOf("await this.saveSettings()"), "checked after them, before the persist");
  });
});

describe("saving", () => {
  test("a save never writes overridden keys: the synced file keeps its own value", () => {
    const settings = { readOnly: true, allowlist: ["Projects"], host: { headless: "on", stateDir: "/srv/example/state", autoRegisterClaude: false } };
    const paths = ["host.autoRegisterClaude", "host.headless", "host.stateDir", "readOnly"];
    const now = { readOnly: false, allowlist: ["Old"], host: { headless: "off", autoRegisterClaude: true } };
    const base = { readOnly: false, allowlist: ["Old"], host: { headless: "auto", stateDir: "", autoRegisterClaude: true } };
    const out = L.forSyncedFile(settings, paths, now, base);
    assert.deepEqual(out, {
      readOnly: false,
      allowlist: ["Projects"],
      host: { headless: "off", stateDir: "", autoRegisterClaude: true },
    }, "the file's current value wins; a key the file lacks takes the value it had at load; other keys are saved as edited");
    assert.equal(settings.host.headless, "on", "the in-memory settings keep the override");
  });

  test("a key neither the file nor the load had is left out of the file", () => {
    const out = L.forSyncedFile({ host: { headless: "on" }, readOnly: false }, ["host.headless"], null, null);
    assert.deepEqual(out, { readOnly: false }, "and the object it leaves empty goes too");
  });

  test("the override is set again in memory after a save", () => {
    const settings = { writeScope: { mode: "all", paths: ["x"] } };
    const override = { writeScope: { mode: "create-only" } };
    L.reapplyOverride(settings, override, ["writeScope.mode"]);
    assert.deepEqual(settings.writeScope, { mode: "create-only", paths: ["x"] });
  });

  test("a save round trip on disk: data.json never holds the override's values", () => {
    const dir = tmp();
    const dataJson = path.join(dir, "data.json");
    const syncedFile = { readOnly: false, writeScope: { mode: "all", paths: [] }, allowlist: [] };
    fs.writeFileSync(dataJson, JSON.stringify(syncedFile));
    const load = L.readLocalSettings(at(write(dir, '{"writeScope": {"mode": "create-only", "paths": ["Inbox/*.md"]}, "readOnly": true}')), SHAPE);
    assert.equal(load.state, "loaded");
    const base = JSON.parse(fs.readFileSync(dataJson, "utf8"));
    const settings = L.mergeOverride(base, load.override);
    settings.allowlist = ["Projects"]; // an edit of a key the override does not set
    fs.writeFileSync(dataJson, JSON.stringify(L.forSyncedFile(settings, load.keys, JSON.parse(fs.readFileSync(dataJson, "utf8")), base)));
    const onDisk = JSON.parse(fs.readFileSync(dataJson, "utf8"));
    assert.deepEqual(onDisk, { readOnly: false, writeScope: { mode: "all", paths: [] }, allowlist: ["Projects"] });
  });

  test("main.ts saves through forSyncedFile, with the override set back before and after", () => {
    const main = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const save = main.slice(main.indexOf("async saveSettings()"), main.indexOf("private discoveryCount()"));
    const first = save.indexOf("this.keepOverrides();");
    assert.ok(first > 0 && first < save.indexOf("await this.loadData()"), "the override is set back before the first await");
    assert.ok(save.indexOf("forSyncedFile(") > 0 && save.indexOf("finally {") > save.indexOf("forSyncedFile("));
    assert.ok(save.slice(save.indexOf("finally {")).includes("this.keepOverrides();"), "and again in finally");
    // The plain save writes the settings (through withUnreadableSchemes, which only keeps an unreadable saved `schemes` value as it was).
    assert.equal((save.match(/this\.saveData\(this\.withUnreadableSchemes\(this\.settings /g) ?? []).length, 1, "the plain save is only the no-override branch");
    assert.ok(save.indexOf("saveData(this.withUnreadableSchemes(this.settings ") > save.indexOf("} else {"));
  });
});

describe("the settings tab and obsidian_doctor", () => {
  test("overridesTouching: the key, a key under it, a key above it", () => {
    const paths = ["host.headless", "writeScope", "modules.scheme.enabled"];
    assert.deepEqual(L.overridesTouching(paths, "host.headless"), ["host.headless"]);
    assert.deepEqual(L.overridesTouching(paths, "host"), ["host.headless"]);
    assert.deepEqual(L.overridesTouching(paths, "writeScope.mode"), ["writeScope"]);
    assert.deepEqual(L.overridesTouching(paths, "host.stateDir"), []);
    assert.deepEqual(L.overridesTouching(paths, "modules.schemes"), [], "a shared prefix is not a parent");
  });

  test("the settings tab locks every settings control it renders", () => {
    const ui = fs.readFileSync(new URL("../src/connection-ui.ts", import.meta.url), "utf8");
    const unlocked = [...ui.matchAll(/new Setting\((containerEl|section)\)\s*\.setName\("([^"]+)"\)/g)].map((m) => m[2]);
    // "Registration" holds the Connect and Disconnect buttons, which write no setting.
    assert.deepEqual(unlocked, ["Registration"], "every control that writes a setting is wrapped in this.lock(…)");
    assert.ok(ui.includes("for (const apply of this.pendingLocks) apply();"), "the locks are applied after every control exists");
  });

  test("obsidian_doctor reports the path, whether it was found, and the key names only", async () => {
    const dir = tmp();
    const load = L.readLocalSettings(at(write(dir, '{"writeScope": {"mode": "create-only", "paths": ["Inbox/*.md"]}, "host": {"stateDir": "/srv/example/state"}}')), SHAPE);
    const server = fakeServer();
    registerCoreTools(server, {}, {
      pluginVersion: "0.0.0",
      socketPath: "/tmp/example.sock",
      vaultName: "Example",
      enabledPlugins: () => [],
      getSettings: () => ({ readOnly: false, allowlist: [] }),
      localSettings: () => L.localSettingsReport(load),
    });
    const res = await server.tools.get("obsidian_doctor").handler({});
    const report = res.structuredContent.local_settings;
    assert.deepEqual(report, {
      path: path.join(dir, L.LOCAL_SETTINGS_FILE),
      source: "default",
      found: true,
      overridden_keys: ["host.stateDir", "writeScope.mode", "writeScope.paths"],
    });
    const text = JSON.stringify(res);
    assert.ok(!text.includes("/srv/example/state") && !text.includes("Inbox/*.md"), "no value of the override is reported");
  });
});

describe("a stray JSON file in the state dir is never read as a vault (#582 review 1)", () => {
  const stateWithStray = () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "notes.json"), JSON.stringify({ readOnly: true }));
    fs.writeFileSync(path.join(dir, "list.json"), "[1, 2]");
    return dir;
  };
  const entry = { vault_name: "Example", socket_path: "/tmp/vault-mcp-example-none.sock" };

  test("the plugin's registration check counts only discovery entries", () => {
    const dir = stateWithStray();
    assert.equal(D.countDiscoveries(dir), 0);
    fs.writeFileSync(path.join(dir, "example.json"), JSON.stringify(entry));
    assert.equal(D.countDiscoveries(dir), 1, "one vault stays one vault: auto-registration is not skipped as ambiguous");
    const main = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    assert.match(main.slice(main.indexOf("private discoveryCount()")), /^private discoveryCount\(\): number \{[\s\S]*?return countDiscoveries\(stateDir\(\)\);/);
  });

  test("the bridge skips it", () => {
    const dir = stateWithStray();
    assert.deepEqual(loadDiscoveryDir(dir), []);
    fs.writeFileSync(path.join(dir, "example.json"), JSON.stringify(entry));
    assert.deepEqual(loadDiscoveryDir(dir).map((d) => d.vault_name), ["Example"]);
  });

  test("the SessionStart health hook skips it and still reports", () => {
    const home = tmp();
    const dir = path.join(home, ".claude", "vault-mcp");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.json"), JSON.stringify({ readOnly: true }));
    const hook = fileURLToPathSafe(new URL("../cc-plugin/hooks/scripts/vault-mcp-health.mjs", import.meta.url));
    const run = () => spawnSync(process.execPath, [hook, "--verbose"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    let r = run();
    assert.match(r.stdout, /no vault discovery found/, "a stray file alone is no vault");
    fs.writeFileSync(path.join(dir, "example.json"), JSON.stringify(entry));
    r = run();
    assert.match(r.stdout, /DOWN — discovery exists \(Example\)/, "the down warning is not lost to the stray file");
    assert.doesNotMatch(r.stderr, /DEP0187/);
  });

  test("the default override file is not in the discovery folder", () => {
    const loc = L.localSettingsLocation("/opt/example/state", {});
    assert.notEqual(path.dirname(loc.path), "/opt/example/state");
  });
});

function fileURLToPathSafe(u) {
  return decodeURIComponent(u.pathname);
}

describe("more file checks (#582 review 1)", () => {
  test("a key with a dot, or an empty key, is refused", () => {
    for (const text of ['{"modules": {"a.b": {"enabled": false}}}', '{"modules": {"": 1}}']) {
      const r = L.readLocalSettings(at(write(tmp(), text)), SHAPE);
      assert.equal(r.state, "error", text);
      assert.match(r.error, /not an allowed key/);
    }
  });

  test("at the default path ENOTDIR is absent; through the variable it fails closed", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "local"), "a file where the folder would be");
    const p = path.join(dir, "local", "settings.json");
    assert.equal(L.readLocalSettings(at(p), SHAPE).state, "absent");
    assert.equal(L.readLocalSettings(at(p, "env"), SHAPE).state, "error");
  });

  test("ELOOP at the default path fails closed", () => {
    const dir = tmp();
    const p = path.join(dir, "settings.json");
    fs.symlinkSync(p, p);
    const r = L.readLocalSettings(at(p), SHAPE);
    assert.equal(r.state, "error");
  });

  test("an empty object the synced file never had is not written", () => {
    const out = L.forSyncedFile({ modules: { scheme: { enabled: false } }, readOnly: true }, ["modules.scheme.enabled"], { modules: {} }, { modules: {} });
    assert.deepEqual(out, { modules: {}, readOnly: true });
    const out2 = L.forSyncedFile({ modules: { a: { b: { c: 1 } } } }, ["modules.a.b.c"], null, null);
    assert.deepEqual(out2, {}, "every level the synced side lacks is left out");
  });

  test("an archive pattern that does not compile is a use-time problem", () => {
    const ok = (p) => { try { new RegExp(p); return true; } catch { return false; } };
    assert.deepEqual(L.useTimeProblems({ recordFolders: { archivePattern: "(" } }, ok), ["recordFolders.archivePattern does not compile as a regular expression"]);
    assert.deepEqual(L.useTimeProblems({ recordFolders: { archivePattern: "" } }, ok), []);
  });
});

describe("the plugin class, with a fake loadData and saveData (#582 review 1)", () => {
  const LOC = { path: "/opt/example/state/local/settings.json", source: "default" };
  /** A plugin over an in-memory data.json; `fail` makes the next read or write throw. */
  function harness(data, override) {
    const p = new VaultMcpPlugin();
    const state = { disk: data === undefined ? null : structuredClone(data), failRead: false, failWrite: false, writes: 0 };
    p.loadData = async () => {
      if (state.failRead) throw new Error("read failed");
      return state.disk === null ? null : structuredClone(state.disk);
    };
    p.saveData = async (d) => {
      if (state.failWrite) throw new Error("write failed");
      state.writes++;
      state.disk = structuredClone(d);
    };
    p.localSettings = override ? { state: "loaded", location: LOC, override, keys: L.overridePaths(override) } : { state: "absent", location: LOC };
    return { p, state };
  }
  const synced = { readOnly: false, guardedTerritories: ["Private"], recordFolders: { enabled: true, folders: [], archivePattern: "" }, writeScope: { mode: "all", paths: [] }, host: { headless: "off", stateDir: "", socketPath: "", autoRegisterClaude: true } };

  test("autoRegisterClaude (#598): a fresh install is off and saved; a saved true or false stays; an install without the key keeps on", async () => {
    const fresh = harness(undefined);
    await fresh.p.loadSettings();
    assert.equal(fresh.p.settings.host.autoRegisterClaude, false);
    const savedFresh = fresh.state.disk;
    assert.equal(savedFresh?.host?.autoRegisterClaude, false, "the key is written, so a later load keeps false");
    for (const [stored, want] of [[true, true], [false, false]]) {
      const h = harness({ ...synced, host: { ...synced.host, autoRegisterClaude: stored } });
      await h.p.loadSettings();
      assert.equal(h.p.settings.host.autoRegisterClaude, want);
    }
    const old = harness({ readOnly: false, host: { headless: "off" } });
    await old.p.loadSettings();
    assert.equal(old.p.settings.host.autoRegisterClaude, true, "no key: unchanged for an existing install");
    const noHost = harness({ readOnly: false });
    await noHost.p.loadSettings();
    assert.equal(noHost.p.settings.host.autoRegisterClaude, true);
  });

  test("no override: load and save behave as before (no extra read)", async () => {
    const { p, state } = harness(synced);
    let reads = 0;
    const read = p.loadData;
    p.loadData = async () => { reads++; return read(); };
    await p.loadSettings();
    await p.saveSettings();
    assert.equal(reads, 1, "only loadSettings reads");
    assert.equal(state.disk.writeScope.mode, "all");
  });

  test("load merges the override; a save keeps it out of data.json", async () => {
    const override = { writeScope: { mode: "create-only", paths: ["Inbox/*.md"] }, host: { headless: "on" }, modules: { scheme: { enabled: false } } };
    const { p, state } = harness(synced, override);
    await p.loadSettings();
    assert.equal(p.settings.writeScope.mode, "create-only");
    assert.equal(p.settings.host.headless, "on");
    assert.equal(p.settings.host.socketPath, "", "the synced half of host stays");
    p.settings.allowlist = ["Projects"];
    await p.saveSettings();
    assert.deepEqual(state.disk.writeScope, { mode: "all", paths: [] });
    assert.equal(state.disk.host.headless, "off");
    assert.deepEqual(state.disk.allowlist, ["Projects"]);
    assert.equal(state.disk.modules.scheme, undefined, "no empty object written for an override-only open-map key");
    assert.equal(p.settings.writeScope.mode, "create-only", "memory keeps the override");
  });

  test("an edit of an overridden key never takes effect, even across the save's awaits", async () => {
    const { p } = harness(synced, { readOnly: true });
    await p.loadSettings();
    p.settings.readOnly = false; // what a derived write could do
    const saving = p.saveSettings();
    assert.equal(p.settings.readOnly, true, "set back before the first await");
    await saving;
    assert.equal(p.settings.readOnly, true);
  });

  test("a throwing saveData or loadData leaves the override in memory and data.json untouched", async () => {
    const { p, state } = harness(synced, { readOnly: true });
    await p.loadSettings();
    const before = structuredClone(state.disk);
    for (const flag of ["failWrite", "failRead"]) {
      state[flag] = true;
      p.settings.readOnly = false;
      await assert.rejects(p.saveSettings());
      assert.equal(p.settings.readOnly, true, `${flag}: memory keeps the override`);
      assert.deepEqual(state.disk, before, `${flag}: nothing written`);
      state[flag] = false;
    }
  });

  test("the wildcard expansion's derived write cannot change an overridden allowOpaque", () => {
    const ui = fs.readFileSync(new URL("../src/connection-ui.ts", import.meta.url), "utf8");
    const save = ui.slice(ui.indexOf("const saveOpaque ="), ui.indexOf("new Setting(containerEl)", ui.indexOf("const saveOpaque =")));
    const assign = save.indexOf("this.plugin.settings.cliPolicy = res.policy;");
    assert.ok(assign > 0 && save.indexOf("this.plugin.keepOverrides();") > assign && save.indexOf("this.plugin.keepOverrides();") < save.indexOf("await this.plugin.saveSettings()"));
  });

  test("adoption: an adopted install takes the override too, and the save writes the adopted values, not the override's", async () => {
    const { p, state } = harness(undefined, { readOnly: true });
    p.adoptedSettings = { readOnly: false, allowlist: ["Adopted"], guardedTerritories: ["Private"] };
    await p.loadSettings();
    assert.equal(p.settings.readOnly, true);
    assert.deepEqual(p.settings.allowlist, ["Adopted"]);
    await p.saveSettings();
    assert.equal(state.disk.readOnly, false, "the adopted (synced-side) value is what the file gets");
    assert.deepEqual(state.disk.allowlist, ["Adopted"]);
  });

  test("a value a normalizer would change is refused, before any save", async () => {
    for (const override of [{ host: { headless: "onn" } }, { recordFolders: { folders: ["/"] } }, { recordFolders: { folders: ["  "] } }, { recordFolders: { archivePattern: "(" } }]) {
      const { p, state } = harness({ ...synced, guardedTerritories: undefined }, override);
      delete state.disk.guardedTerritories; // the territory seed would persist, if the refusal came late
      await assert.rejects(p.loadSettings(), /does not take|does not compile/, JSON.stringify(override));
      assert.equal(state.writes, 0, `${JSON.stringify(override)}: nothing written`);
    }
  });

  test("a refusal at load leaves no ready host: the API throws, as when the file itself is bad", async () => {
    const dir = tmp();
    const file = path.join(dir, "vm.json");
    fs.writeFileSync(file, JSON.stringify({ host: { headless: "onn" } }));
    process.env.VAULT_MCP_LOCAL_SETTINGS = file;
    const p = new VaultMcpPlugin();
    p.app = { vault: { configDir: ".obsidian", adapter: { exists: async () => false, list: async () => ({ files: [], folders: [] }) } } };
    p.manifest = { id: "vault-mcp", dir: ".obsidian/plugins/vault-mcp", version: "0.0.0" };
    p.loadData = async () => structuredClone(synced);
    p.saveData = async () => { throw new Error("must not save"); };
    await p.onload();
    assert.equal(p.settings, undefined);
    assert.throws(() => p.api.guardedTerritories());
    fs.writeFileSync(file, "{ not json");
    const q = new VaultMcpPlugin();
    q.app = p.app;
    q.manifest = p.manifest;
    await q.onload();
    assert.throws(() => q.api.guardedTerritories(), undefined, "path 1 throws the same way");
  });
});
