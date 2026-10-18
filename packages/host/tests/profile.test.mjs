// The connection profile (#521): a remote connection's tool surface, filtered by name at
// origRegister. Built through the REAL server wiring, with satellites, and over a real MCP client.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { installObsidianStub } from "./obsidian-stub.mjs";

installObsidianStub();
const { buildMcpServer } = await import("../src/mcp/server.ts");
const { buildPreamble, parsePreamble } = await import("../src/preamble.ts");
const { supportsProfile, profileFromEnv } = await import("../bridge/bridge.ts");
const { READ_PROFILE_TOOLS } = await import("@vault-mcp/core");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const FOLDERS = new Set(["00 Inbox area", "00 Inbox area/00.01 Inbox", "Notes"]);
function build(opts = {}, basesResult = { bases: [] }, redact = {}) {
  const app = {
    vault: {
      adapter: { basePath: "/nonexistent-vault" },
      getName: () => "test",
      getMarkdownFiles: () => [],
      getFiles: () => [],
      getAllLoadedFiles: () => [],
      getAbstractFileByPath: (p) => (FOLDERS.has(p) ? { path: p } : null),
      on: () => ({}),
      configDir: ".obsidian",
    },
    metadataCache: { getFileCache: () => null, resolvedLinks: {}, unresolvedLinks: {}, on: () => ({}) },
    workspace: { layoutReady: true, iterateAllLeaves: (cb) => cb({}), getActiveFile: () => null, on: () => ({}) },
    // The satellite owner is present, so its tools answer (the stale-publisher check, F6).
    plugins: { plugins: { "vaultmcp-bases": {} }, manifests: {}, enabledPlugins: new Set() },
    internalPlugins: { getPluginById: () => null },
    commands: { commands: {}, executeCommandById: () => true },
  };
  const ctx = {
    pluginVersion: "0.0.0", socketPath: "/tmp/none.sock", vaultName: "test", enabledPlugins: () => [],
    getSettings: () => ({ allowlist: [], readOnly: false, trustedReadOnlyPlugins: [], ...redact }),
    getExternalTools: () => [
      { ownerId: "vaultmcp-bases", toolName: "vaultmcp_bases_list", spec: { description: "list bases", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, handler: async () => basesResult } },
      { ownerId: "vaultmcp-bases", toolName: "vaultmcp_bases_create", spec: { description: "make a base", inputSchema: { type: "object", properties: { path: { type: "string" } } }, annotations: { readOnlyHint: false } }, handler: async () => ({}) },
    ],
  };
  return buildMcpServer(app, ctx, opts);
}

const names = (server) => Object.keys(server._registeredTools).sort();
const READ = new Set(READ_PROFILE_TOOLS);

async function connect(server) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await client.connect(a);
  return client;
}

describe("the preamble carries the profile", () => {
  test("round trip; absent stays absent; a malformed value is an unknown name, never full", () => {
    assert.deepEqual(parsePreamble(buildPreamble({ codeMode: false, profile: "read" })), { codeMode: false, profile: "read" });
    assert.deepEqual(parsePreamble(buildPreamble({ codeMode: false })), { codeMode: false });
    assert.equal(parsePreamble('{"vault_mcp_preamble":1,"profile":5}').profile, "(invalid)");
    assert.equal(parsePreamble('{"vault_mcp_preamble":1,"profile":""}').profile, "(invalid)");
  });

  test("the bridge sends a profile only to a plugin that advertises it", () => {
    assert.equal(supportsProfile({ capabilities: ["preamble"] }), false);
    assert.equal(supportsProfile({ capabilities: ["preamble", "profile"] }), true);
    assert.equal(supportsProfile({}), false);
    assert.equal(profileFromEnv(undefined), undefined);
    assert.equal(profileFromEnv("  "), undefined);
    assert.equal(profileFromEnv("read"), "read");
  });
});

describe("profile read", () => {
  const full = names(build());
  const read = names(build({ profile: "read" }));

  test("a local connection (no profile) is unchanged: the full surface, writes and satellites included", () => {
    assert.ok(full.includes("obsidian_write_note"));
    assert.ok(full.includes("obsidian_write_notes"));
    assert.ok(full.includes("vaultmcp_bases_create"));
    assert.deepEqual(names(build({ profile: "full" })), full);
  });

  test("tools/list holds exactly the read set, as far as this build registers it", () => {
    assert.deepEqual(read, full.filter((n) => READ.has(n)));
    for (const n of read) assert.ok(READ.has(n), n);
    // The always-registered read tools are all there.
    for (const n of ["obsidian_read_note", "obsidian_list_notes", "obsidian_search_notes", "obsidian_resolve_uid", "obsidian_check_links", "vaultmcp_bases_list"]) {
      assert.ok(read.includes(n), n);
    }
  });

  test("no write tool, no dispatcher, no satellite write", () => {
    for (const n of ["obsidian_write_note", "obsidian_write_notes", "obsidian_delete_note", "obsidian_run_command", "obsidian_call_tool", "vaultmcp_bases_create"]) {
      assert.ok(!read.includes(n), n);
    }
  });

  test("Code Mode asked under a profile: the plain filtered surface, no meta-tools", () => {
    const cm = names(build({ profile: "read", codeMode: true }));
    assert.deepEqual(cm, read);
    assert.ok(!cm.includes("obsidian_call_tool"));
  });

  test("an unknown profile name registers nothing", () => {
    assert.deepEqual(names(build({ profile: "admin" })), []);
  });

  test("over MCP: tools/list is the read set, and a write tool is not callable", async () => {
    const client = await connect(build({ profile: "read" }));
    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(listed, read);
    const r = await client.callTool({ name: "obsidian_write_note", arguments: { path: "Notes/x.md", content: "x" } }).catch((e) => ({ thrown: String(e) }));
    const text = r.thrown ?? JSON.stringify(r);
    assert.match(text, /not found|-32602/i, text);
    await client.close();
  });
});

describe("profile read+inbox", () => {
  const tools = build({ profile: "read+inbox" })._registeredTools;

  test("the read set plus obsidian_write_note, nothing else", () => {
    const n = Object.keys(tools);
    assert.ok(n.includes("obsidian_write_note"));
    for (const x of n) assert.ok(READ.has(x) || x === "obsidian_write_note", x);
  });

  test("a write outside a .01 folder, an overwrite, a missing folder and a uid address are refused before the guard", async () => {
    const h = tools.obsidian_write_note.handler;
    for (const args of [
      { path: "Notes/x.md", content: "x" },
      { path: "00 Inbox area/00.01 Inbox/x.md", content: "x", overwrite: true },
      { path: "00 Inbox area/00.01 Inbox/sub/x.md", content: "x" },
      { path: "07.01 Missing/x.md", content: "x" },
      { path: "uid:0190", content: "x" },
    ]) {
      const r = await h(args, {});
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(r.content[0].text, /write_scope/, JSON.stringify(r));
    }
  });

  test("a satellite read the host treats as mutating (untrusted) is not refused by the profile's write scope", async () => {
    const r = await tools.vaultmcp_bases_list.handler({}, {});
    assert.doesNotMatch(JSON.stringify(r), /write_scope|profile_refused/, JSON.stringify(r));
  });

  test("a new note in a .01 folder passes the profile check (and reaches the guard)", async () => {
    const r = await tools.obsidian_write_note.handler({ path: "00 Inbox area/00.01 Inbox/x.md", content: "x" }, {});
    assert.doesNotMatch(r.content[0].text, /write_scope|profile_refused/, JSON.stringify(r));
  });
});

describe("the secret scanner: off by default, on by setting", () => {
  // Built at run time from parts, so no key-shaped literal is committed; made up.
  const FAKE = ["gh", "p_", "FAKE".repeat(9)].join("");
  const result = { bases: [`Notes/b.base`, `token: ${FAKE}`, `password: fake-pass`, `licence code: fake-lic`], frontmatter: { password: "fake-fm-pass", api_key: 1234567, title: "T", secret: true } };
  const ON = { redactProfiles: ["read+message"] };
  const callRaw = async (profile, redact = {}) => {
    const client = await connect(build(profile ? { profile } : {}, result, redact));
    const r = await client.callTool({ name: "vaultmcp_bases_list", arguments: {} });
    await client.close();
    return r;
  };
  const call = async (profile, redact) => JSON.stringify(await callRaw(profile, redact));

  test("off by default: a read+message reply is the same, byte for byte, as a full one", async () => {
    const m = await callRaw("read+message");
    const f = await callRaw(undefined);
    assert.deepEqual(m, f);
    assert.ok(JSON.stringify(m).includes(FAKE));
  });

  test("on by setting: a reply under read+message is blanked", async () => {
    const r = await call("read+message", ON);
    assert.doesNotMatch(r, /isError":true/, r);
    assert.ok(!r.includes(FAKE), r);
    assert.ok(!r.includes("fake-pass"), r);
    assert.match(r, /redacted:github-token/);
    assert.match(r, /Notes\/b\.base/);
    assert.ok(!r.includes("fake-fm-pass") && !r.includes("1234567"), r);
    assert.ok(r.includes("fake-lic"), "licence code is not a shipped key name");
  });

  test("on by setting: structured content is blanked key-aware, and the text copy still parses", async () => {
    const res = await callRaw("read+message", ON);
    const fm = res.structuredContent?.frontmatter;
    assert.deepEqual(fm, { password: "[redacted:secret]", api_key: "[redacted:secret]", title: "T", secret: true }, JSON.stringify(res));
    for (const c of res.content) if (c.type === "text" && /^\s*[{[]/.test(c.text)) assert.doesNotThrow(() => JSON.parse(c.text), c.text);
  });

  test("on by setting: profiles not listed are sent as they are", async () => {
    for (const p of [undefined, "read"]) assert.ok((await call(p, ON)).includes(FAKE), String(p));
  });

  test("a config extends the key names", async () => {
    const r = await call("read+message", { ...ON, redactConfig: JSON.stringify({ extraKeyNames: ["licence code"] }) });
    assert.ok(!r.includes("fake-lic") && !r.includes("fake-pass"), r);
  });

  test("bad settings fail closed: no tools for a remote connection, and a local one not listed is unchanged", () => {
    for (const bad of [
      { ...ON, redactConfig: "{not json" },
      { ...ON, redactConfig: JSON.stringify({ extraPatterns: [{ kind: "x", regex: "(" }] }) },
      { ...ON, redactConfig: JSON.stringify({ unknown: 1 }) },
    ]) {
      assert.deepEqual(names(build({ profile: "read+message" }, result, bad)), [], JSON.stringify(bad));
      assert.deepEqual(names(build({ profile: "read" }, result, bad)), [], JSON.stringify(bad));
      assert.ok(names(build({}, result, bad)).includes("obsidian_write_note"), JSON.stringify(bad));
    }
    // The fail-closed check reads the PARSED list: a comma line or a JSON array that names `full`
    // refuses the local connection too, and a list that cannot be parsed refuses every connection.
    for (const bad of [
      { redactProfiles: ["full, read+message"], redactConfig: "{not json" },
      { redactProfiles: ['["full","bogus"]'], redactConfig: "{not json" },
      { redactProfiles: ['["full","bogus"]'] },
      { redactProfiles: ['["full"'] },
    ]) {
      assert.deepEqual(names(build({}, result, bad)), [], JSON.stringify(bad));
      assert.deepEqual(names(build({ profile: "read+message" }, result, bad)), [], JSON.stringify(bad));
    }
    // An entry that is not a known profile name refuses every connection, with a good config or a bad one.
    for (const entry of ["Full", "full;read+message", "- full", '"full"', "full # local", "read+mesage"]) {
      for (const redactConfig of ["", "{not json"]) {
        const bad = { redactProfiles: [entry], redactConfig };
        assert.deepEqual(names(build({}, result, bad)), [], JSON.stringify(bad));
        assert.deepEqual(names(build({ profile: "read+message" }, result, bad)), [], JSON.stringify(bad));
      }
    }
    // A hand-edited data.json with the wrong types: a logged refusal of every connection, not a throw.
    for (const bad of [{ redactProfiles: "read+message" }, { redactProfiles: [1] }, { redactProfiles: { a: 1 } }, { redactConfig: { extraKeyNames: [] } }, { redactProfiles: ["read+message"], redactConfig: 5 }]) {
      assert.doesNotThrow(() => build({}, result, bad), JSON.stringify(bad));
      assert.deepEqual(names(build({}, result, bad)), [], JSON.stringify(bad));
      assert.deepEqual(names(build({ profile: "read+message" }, result, bad)), [], JSON.stringify(bad));
    }
    // A bad config with no profile listed leaves the scanner off and refuses nothing.
    assert.ok(names(build({ profile: "read+message" }, result, { redactConfig: "{not json" })).length > 0);
  });
});
