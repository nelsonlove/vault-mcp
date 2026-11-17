import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  VaultMux,
  mergeToolLists,
  mergeInitialize,
  muxInstructions,
  withVaultArg,
} from "../bridge/mux.ts";
import { muxDefault, parseMultiFlag } from "../bridge/bridge.ts";

// --- pure helpers ---

const tool = (name, props = {}, extra = {}) => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object", properties: props, ...extra },
});

test("withVaultArg adds an optional vault enum and keeps strict schemas strict", () => {
  const s = withVaultArg(
    { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    ["agents", "obsidian"],
    "agents"
  );
  assert.deepEqual(s.required, ["path"], "vault is never required");
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.properties.vault.enum, ["agents", "obsidian"]);
  assert.match(s.properties.vault.description, /Default: "agents"/);
});
test("withVaultArg creates properties when the schema has none", () => {
  assert.deepEqual(Object.keys(withVaultArg({ type: "object" }, ["a"], undefined).properties), ["vault"]);
});
test("withVaultArg refuses a tool that already declares vault", () => {
  assert.throws(() => withVaultArg({ type: "object", properties: { vault: {} } }, ["a"], "a"), /already declares/);
});
test("withVaultArg says there is no default when none applies", () => {
  assert.match(withVaultArg({}, ["a", "b"], undefined).properties.vault.description, /No default/);
});

test("mergeToolLists: union by name, enum lists only the vaults offering the tool", () => {
  const r = new Map([
    ["agents", { tools: [tool("read"), tool("only_agents")] }],
    ["obsidian", { tools: [tool("read"), tool("only_obsidian")] }],
  ]);
  const { tools } = mergeToolLists(r, ["agents", "obsidian"], "obsidian");
  const by = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema.properties.vault.enum]));
  assert.deepEqual(by, { read: ["agents", "obsidian"], only_obsidian: ["obsidian"], only_agents: ["agents"] });
});
test("mergeToolLists: the default vault's definition wins", () => {
  const r = new Map([
    ["agents", { tools: [{ ...tool("read"), description: "old" }] }],
    ["obsidian", { tools: [{ ...tool("read"), description: "new" }] }],
  ]);
  assert.equal(mergeToolLists(r, ["agents", "obsidian"], "obsidian").tools[0].description, "new");
  assert.equal(mergeToolLists(r, ["agents", "obsidian"], undefined).tools[0].description, "old");
});
test("mergeToolLists: a paginated list is refused, not truncated", () => {
  const r = new Map([["a", { tools: [], nextCursor: "2" }]]);
  assert.throws(() => mergeToolLists(r, ["a"], "a"), /paginated/);
});

test("muxInstructions names every vault and the default", () => {
  const t = muxInstructions([{ name: "agents", path: "/v/agents" }, { name: "obsidian" }], "agents", "the session runs inside it");
  assert.match(t, /"agents" \(\/v\/agents\), "obsidian"/);
  assert.match(t, /optional "vault" argument/);
  assert.match(t, /act on "agents" \(the session runs inside it\)/);
  assert.match(muxInstructions([{ name: "a" }, { name: "b" }], undefined), /must name one/);
});
test("mergeInitialize: default's result, capabilities unioned, instructions appended", () => {
  const r = new Map([
    ["a", { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "vault-mcp" } }],
    ["b", { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true }, logging: {} }, instructions: "be nice" }],
  ]);
  const m = mergeInitialize(r, ["a", "b"], "b", "NOTE");
  assert.deepEqual(m.capabilities, { tools: { listChanged: true }, logging: {} });
  assert.equal(m.instructions, "be nice\n\nNOTE");
  assert.equal(mergeInitialize(r, ["a", "b"], "a", "NOTE").instructions, "NOTE");
});

test("muxDefault: pin, then directory, then soft default, then the only vault", () => {
  const A = { vault_name: "a", socket_path: "/a", vault_path: "/v/a" };
  const B = { vault_name: "b", socket_path: "/b", vault_path: "/v/b" };
  assert.equal(muxDefault([A, B], "b", "/v/a", undefined).name, "b");
  assert.equal(muxDefault([A, B], undefined, "/v/a/x", "b").name, "a");
  assert.equal(muxDefault([A, B], undefined, "/elsewhere", "b").name, "b");
  assert.equal(muxDefault([A, B], undefined, "/elsewhere", undefined), undefined);
  assert.equal(muxDefault([A], undefined, "/elsewhere", undefined).name, "a");
  assert.equal(muxDefault([A, B], "gone", "/elsewhere", undefined), undefined, "a pin to a vault not open is no default");
});
test("parseMultiFlag: flag or env", () => {
  assert.equal(parseMultiFlag(["node", "b", "--multi-vault"]), true);
  assert.equal(parseMultiFlag(["node", "b"], "1"), true);
  assert.equal(parseMultiFlag(["node", "b"], ""), false);
  assert.equal(parseMultiFlag(["node", "b"]), false);
});

// --- VaultMux against scripted fake vaults ---

// A fake vault: answers initialize, tools/list and tools/call over the
// backend's line streams, and records every line it was sent.
function fakeVault(name, tools, opts = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const seen = [];
  let buf = "";
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const m = JSON.parse(line);
      seen.push(m);
      if (opts.silent?.includes(m.method)) continue;
      const out = (result) => output.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n");
      if (m.method === "initialize") out({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: `vault-${name}` } });
      else if (m.method === "tools/list") out({ tools });
      else if (m.method === "tools/call") out({ content: [{ type: "text", text: `${name}:${m.params.name}:${JSON.stringify(m.params.arguments ?? {})}` }] });
      else if (m.method === "ping") out({ from: name });
    }
  });
  return { backend: { name, input, output, path: `/v/${name}` }, seen, output };
}

function harness(vaults, opts) {
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const got = [];
  let buf = "";
  clientOut.setEncoding("utf8");
  clientOut.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      got.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const mux = new VaultMux({ clientIn, clientOut }, vaults.map((v) => v.backend), opts);
  mux.start();
  const send = (m) => clientIn.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const raw = (line) => clientIn.write(line + "\n");
  const answer = async (id) => {
    for (let n = 0; n < 200; n++) {
      const hit = got.find((g) => g.id === id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no answer for id ${id}`);
  };
  return { mux, send, raw, answer, got };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test("VaultMux: initialize fans out and answers once, naming the vaults", async () => {
  const a = fakeVault("agents", []), o = fakeVault("obsidian", []);
  const h = harness([a, o], { defaultVault: "obsidian", defaultReason: "set by --default-vault" });
  h.send({ id: 1, method: "initialize", params: {} });
  const r = await h.answer(1);
  assert.equal(r.result.serverInfo.name, "vault-obsidian");
  assert.match(r.result.instructions, /2 Obsidian vaults/);
  assert.equal(h.got.filter((g) => g.id === 1).length, 1);
  assert.equal(a.seen[0].method, "initialize");
  assert.equal(o.seen[0].method, "initialize");
});

test("VaultMux: tools/list merges, tools/call routes by vault and strips it", async () => {
  const a = fakeVault("agents", [tool("read"), tool("only_agents")]);
  const o = fakeVault("obsidian", [tool("read")]);
  const h = harness([a, o], { defaultVault: "obsidian" });
  h.send({ id: 2, method: "tools/list" });
  const list = (await h.answer(2)).result.tools;
  assert.deepEqual(list.map((t) => t.name).sort(), ["only_agents", "read"]);

  h.send({ id: 3, method: "tools/call", params: { name: "read", arguments: { path: "x", vault: "agents" } } });
  assert.equal((await h.answer(3)).result.content[0].text, 'agents:read:{"path":"x"}');

  h.send({ id: 4, method: "tools/call", params: { name: "read", arguments: { path: "y" } } });
  assert.equal((await h.answer(4)).result.content[0].text, 'obsidian:read:{"path":"y"}', "no vault: the default");
  assert.equal(a.seen.filter((m) => m.method === "tools/call").length, 1);
});

test("VaultMux: unknown vault and missing default are tool errors naming the choices", async () => {
  const h = harness([fakeVault("a", []), fakeVault("b", [])], {});
  h.send({ id: 5, method: "tools/call", params: { name: "read", arguments: { vault: "zz" } } });
  const r = await h.answer(5);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /no open vault named "zz"; choose one of "a", "b"/);
  h.send({ id: 6, method: "tools/call", params: { name: "read", arguments: {} } });
  assert.match((await h.answer(6)).result.content[0].text, /no default vault/);
});

test("VaultMux: other requests go to the default vault", async () => {
  const a = fakeVault("a", []), b = fakeVault("b", []);
  const h = harness([a, b], { defaultVault: "b" });
  h.send({ id: 7, method: "ping" });
  assert.equal((await h.answer(7)).result.from, "b");
});

test("VaultMux: cancellation reaches only the vault that got the request", async () => {
  const a = fakeVault("a", [], { silent: ["tools/call"] }), b = fakeVault("b", []);
  const h = harness([a, b], { defaultVault: "b" });
  h.send({ id: 8, method: "tools/call", params: { name: "slow", arguments: { vault: "a" } } });
  await settle();
  h.send({ method: "notifications/cancelled", params: { requestId: 8 } });
  await settle();
  assert.equal(a.seen.filter((m) => m.method === "notifications/cancelled").length, 1);
  assert.equal(b.seen.filter((m) => m.method === "notifications/cancelled").length, 0);
});

test("VaultMux: notifications/initialized reaches every vault", async () => {
  const a = fakeVault("a", []), b = fakeVault("b", []);
  const h = harness([a, b], { defaultVault: "a" });
  h.send({ method: "notifications/initialized" });
  await settle();
  assert.equal(a.seen.length, 1);
  assert.equal(b.seen.length, 1);
});

test("VaultMux: server requests with colliding ids are kept apart and answered to their vault", async () => {
  const a = fakeVault("a", []), b = fakeVault("b", []);
  const h = harness([a, b], { defaultVault: "a" });
  a.output.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "roots/list" }) + "\n");
  b.output.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "roots/list" }) + "\n");
  await settle();
  const reqs = h.got.filter((g) => g.method === "roots/list");
  assert.equal(reqs.length, 2);
  assert.notEqual(reqs[0].id, reqs[1].id);
  h.send({ id: reqs[1].id, result: { roots: ["second"] } });
  h.send({ id: reqs[0].id, result: { roots: ["first"] } });
  await settle();
  assert.deepEqual(a.seen.at(-1), { jsonrpc: "2.0", id: 0, result: { roots: ["first"] } });
  assert.deepEqual(b.seen.at(-1), { jsonrpc: "2.0", id: 0, result: { roots: ["second"] } });
});

test("VaultMux: a dead vault is skipped by fan-outs and refused on calls", async () => {
  const a = fakeVault("a", [tool("read")]), b = fakeVault("b", [tool("read")], { silent: ["tools/list"] });
  const h = harness([a, b], { defaultVault: "a" });
  h.send({ id: 9, method: "tools/list" });
  await settle();
  h.mux.markDead("b");
  assert.deepEqual((await h.answer(9)).result.tools[0].inputSchema.properties.vault.enum, ["a"]);
  h.send({ id: 10, method: "tools/call", params: { name: "read", arguments: { vault: "b" } } });
  assert.match((await h.answer(10)).result.content[0].text, /no longer reachable/);
});

test("VaultMux: a slow vault does not hold a fan-out past the timeout", async () => {
  const a = fakeVault("a", [tool("read")]), b = fakeVault("b", [], { silent: ["tools/list"] });
  const h = harness([a, b], { defaultVault: "a", fanoutTimeoutMs: 50 });
  h.send({ id: 11, method: "tools/list" });
  assert.equal((await h.answer(11)).result.tools.length, 1);
});

test("VaultMux: batches are refused", async () => {
  const a = fakeVault("a", []);
  const h = harness([a], { defaultVault: "a" });
  h.raw(JSON.stringify([{ jsonrpc: "2.0", id: 12, method: "ping" }]));
  await settle();
  assert.equal(h.got.length, 1);
  assert.equal(h.got[0].error.code, -32600);
  assert.equal(a.seen.length, 0, "nothing reaches a vault");
});

test("VaultMux: two vaults with one name are refused", () => {
  assert.throws(() => new VaultMux({ clientIn: new PassThrough(), clientOut: new PassThrough() }, [fakeVault("a", []).backend, fakeVault("a", []).backend]), /both named "a"/);
});
