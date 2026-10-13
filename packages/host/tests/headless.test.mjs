// Running headless (vaultd-host): the `host` setting, the path overrides, the
// claude-registration switch, and the app-only tools (headless.ts).
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installObsidianStub } from "./obsidian-stub.mjs";

installObsidianStub();
const H = await import("../src/headless.ts");
const P = await import("../src/paths.ts");
const D = await import("../src/discovery.ts");

const ENV = ["VAULT_MCP_HEADLESS", "VAULT_MCP_STATE_DIR", "VAULT_MCP_NO_AUTOREGISTER"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  P.configurePaths({});
});

/** A workspace as the headless host has it (no leaves) or as Obsidian has it (one leaf). */
const appWith = (leaves, layoutReady = true) => ({ workspace: { layoutReady, iterateAllLeaves: (cb) => { for (let i = 0; i < leaves; i++) cb({}); } } });

describe("the host setting", () => {
  test("absent or hand-edited: coerced to the defaults", () => {
    assert.deepEqual(H.normalizeHostSettings(undefined), { headless: "auto", stateDir: "", socketPath: "", autoRegisterClaude: true });
    assert.deepEqual(H.normalizeHostSettings({ headless: "yes", stateDir: 4, socketPath: " /s.sock ", autoRegisterClaude: "no" }), {
      headless: "auto",
      stateDir: "",
      socketPath: "/s.sock",
      autoRegisterClaude: true,
    });
    assert.equal(H.normalizeHostSettings({ autoRegisterClaude: false }).autoRegisterClaude, false);
  });

  test("declared headless: the setting, else VAULT_MCP_HEADLESS; never a probe", () => {
    delete process.env.VAULT_MCP_HEADLESS;
    assert.equal(H.declaredHeadless("on"), true);
    assert.equal(H.declaredHeadless("off"), false);
    assert.equal(H.declaredHeadless("auto"), false);
    process.env.VAULT_MCP_HEADLESS = "1";
    assert.equal(H.declaredHeadless("auto"), true);
    assert.equal(H.declaredHeadless("off"), false, "the setting wins");
  });

  test("headless at call time: auto looks for a workspace leaf once the layout is ready", () => {
    delete process.env.VAULT_MCP_HEADLESS;
    assert.equal(H.isHeadless(appWith(0), "auto"), true, "vaultd-host: no leaves");
    assert.equal(H.isHeadless(appWith(1), "auto"), false, "Obsidian: a leaf");
    assert.equal(H.isHeadless(appWith(0, false), "auto"), false, "layout not ready: no verdict, so not headless");
    assert.equal(H.isHeadless({}, "auto"), false);
    assert.equal(H.isHeadless(appWith(1), "on"), true);
    assert.equal(H.isHeadless(appWith(0), "off"), false);
    process.env.VAULT_MCP_HEADLESS = "0";
    assert.equal(H.isHeadless(appWith(0), "auto"), false, "the variable answers before the probe");
  });

  test("the load-time claude registration: off by the setting, by headless, or by VAULT_MCP_NO_AUTOREGISTER", () => {
    delete process.env.VAULT_MCP_HEADLESS;
    delete process.env.VAULT_MCP_NO_AUTOREGISTER;
    const d = H.normalizeHostSettings({});
    assert.equal(H.autoRegisterAllowed(d), true);
    assert.equal(H.autoRegisterAllowed({ ...d, autoRegisterClaude: false }), false);
    assert.equal(H.autoRegisterAllowed({ ...d, headless: "on" }), false);
    process.env.VAULT_MCP_NO_AUTOREGISTER = "1";
    assert.equal(H.autoRegisterAllowed(d), false);
  });

  test("main.ts asks autoRegisterAllowed before it looks for the claude binary, and configures the paths before it binds", () => {
    const main = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const auto = main.slice(main.indexOf("async autoRegister("));
    assert.ok(auto.indexOf("autoRegisterAllowed(") < auto.indexOf("findClaudeBinary()"), "the switch comes first");
    const load = main.slice(main.indexOf("async onload()"));
    assert.ok(load.indexOf("configurePaths(") > 0 && load.indexOf("configurePaths(") < load.indexOf("socketPath(this.slug)"));
    assert.ok(load.indexOf("configurePaths(") < load.indexOf("writeBridge()"));
  });
});

describe("the state folder and socket", () => {
  test("default: ~/.claude/vault-mcp, with the grace-period copies", () => {
    delete process.env.VAULT_MCP_STATE_DIR;
    assert.equal(P.stateDir(), path.join(os.homedir(), ".claude", "vault-mcp"));
    assert.equal(P.socketPath("v"), path.join(os.homedir(), ".claude", "vault-mcp", "v.sock"));
    assert.equal(P.legacyWrites(), true);
  });

  test("VAULT_MCP_STATE_DIR moves everything and stops the ~/.claude/governor copies; the setting wins over it", () => {
    process.env.VAULT_MCP_STATE_DIR = "/srv/env-state";
    assert.equal(P.stateDir(), "/srv/env-state");
    assert.equal(P.socketPath("v"), "/srv/env-state/v.sock");
    assert.equal(P.bridgeDestPath(), "/srv/env-state/bridge.mjs");
    assert.equal(P.discoveryPath("v"), "/srv/env-state/v.json");
    assert.equal(P.legacyWrites(), false);
    P.configurePaths({ stateDir: "/srv/set-state", socketPath: "/run/vault-mcp/v.sock" });
    assert.equal(P.stateDir(), "/srv/set-state");
    assert.equal(P.socketPath("v"), "/run/vault-mcp/v.sock");
  });

  test("with a state folder set, the bridge and the discovery file land there and nowhere else", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vmcp-state-"));
    P.configurePaths({ stateDir: dir });
    const legacy = P.legacyDiscoveryPath("probe-vault");
    const legacyBefore = fs.existsSync(legacy);
    D.writeBridge();
    D.writeDiscovery("probe-vault", { socket_path: path.join(dir, "probe-vault.sock"), vault_path: "/v", vault_name: "probe-vault", plugin_version: "0", obsidian_version: "0", started_at: "now" });
    assert.ok(fs.existsSync(path.join(dir, "bridge.mjs")));
    assert.ok(fs.existsSync(path.join(dir, "probe-vault.json")));
    assert.equal(fs.existsSync(legacy), legacyBefore, "nothing written into ~/.claude/governor/");
    D.removeDiscovery("probe-vault");
    assert.ok(!fs.existsSync(path.join(dir, "probe-vault.json")));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("the app-only tools", () => {
  test("the five CLI-backed tools and the editor and workspace tools are app-only", () => {
    for (const t of [
      "obsidian_note_history", "obsidian_note_diff", "obsidian_base_create", "obsidian_plugin_install", "obsidian_plugin_uninstall",
      "obsidian_open_in_editor", "obsidian_jump_to", "obsidian_toggle_view_mode", "obsidian_list_workspaces", "obsidian_open_workspace",
    ]) assert.ok(H.APP_ONLY_TOOLS.has(t), t);
    assert.ok(!H.APP_ONLY_TOOLS.has("obsidian_read_note"));
  });

  test("the refusal is typed and names the reason", () => {
    const r = H.headlessRefusal("obsidian_note_history");
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /^Error \[headless_unsupported\]: 'obsidian_note_history' needs the Obsidian app.*File Recovery.*Nothing was done\.$/);
  });
});

describe("the real server wiring", () => {
  async function build(headless, leaves) {
    const { buildMcpServer } = await import("../src/mcp/server.ts");
    const app = {
      vault: {
        adapter: { basePath: "/nonexistent-vault" },
        getName: () => "test",
        getMarkdownFiles: () => [],
        getFiles: () => [],
        getAllLoadedFiles: () => [],
        getAbstractFileByPath: () => null,
        on: () => ({}),
        configDir: ".obsidian",
      },
      metadataCache: { getFileCache: () => null, resolvedLinks: {}, unresolvedLinks: {}, on: () => ({}) },
      workspace: { layoutReady: true, iterateAllLeaves: (cb) => { for (let i = 0; i < leaves; i++) cb({}); }, getActiveFile: () => null, on: () => ({}) },
      plugins: { plugins: {}, manifests: {}, enabledPlugins: new Set() },
      internalPlugins: { getPluginById: () => null },
      commands: { commands: {}, executeCommandById: () => true },
    };
    const ctx = {
      pluginVersion: "0.0.0", socketPath: "/tmp/none.sock", vaultName: "test", enabledPlugins: () => [],
      getSettings: () => ({ allowlist: [], readOnly: false }),
      host: () => ({ headless }),
    };
    return buildMcpServer(app, ctx)._registeredTools;
  }

  test("headless on: the app-only tools are not offered; the rest are", async () => {
    const tools = await build("on", 0);
    for (const t of ["obsidian_open_in_editor", "obsidian_jump_to", "obsidian_toggle_view_mode", "obsidian_list_workspaces", "obsidian_open_workspace"]) {
      assert.equal(tools[t], undefined, t);
    }
    assert.ok(tools.obsidian_read_note, "an ordinary tool is still offered");
  });

  test("headless auto with no workspace leaf: an app-only tool refuses, typed, and does not report success", async () => {
    delete process.env.VAULT_MCP_HEADLESS;
    const tools = await build("auto", 0);
    const r = await tools.obsidian_open_in_editor.handler({ path: "A.md" }, {});
    assert.equal(r.isError, true, JSON.stringify(r));
    assert.match(r.content[0].text, /headless_unsupported/);
  });

  test("headless off (Obsidian): the app-only tools are offered and run", async () => {
    const tools = await build("off", 0);
    assert.ok(tools.obsidian_open_in_editor);
    const r = await tools.obsidian_list_workspaces.handler({}, {});
    assert.doesNotMatch(r.content[0].text, /headless_unsupported/);
  });
});

describe("the bridge finds a state folder outside ~/.claude", () => {
  test("VAULT_MCP_STATE_DIR set: the bridge reads discovery files there and only there", async () => {
    const { loadDiscoveries } = await import("../bridge/bridge.ts");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vmcp-bridge-"));
    fs.writeFileSync(path.join(dir, "headless.json"), JSON.stringify({ socket_path: path.join(dir, "headless.sock"), vault_name: "headless", vault_path: "/v" }));
    process.env.VAULT_MCP_STATE_DIR = dir;
    const found = loadDiscoveries();
    assert.deepEqual(found.map((d) => d.vault_name), ["headless"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
