// tests/publish-tools.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { publishTools, partial, isPartial, PARTIAL_BRAND, API_VERSION_MIN, API_VERSION_DECLARATIONS, hostApiRefusal, declaresWrites, specsForHost, type CallContext } from "../src/index.js";

// Minimal fake of the Obsidian surface publishTools touches: workspace event
// bus (on/offref/trigger) + plugins map + plugin.manifest.id.
// `hostId` is the plugin id the host is loaded under — 0.12.0+ hosts use
// "governor", pre-0.12.0 hosts "vault-mcp"; the SDK must work with both.
function fakeWorld(vaultMcpApi: unknown, hostId = "vault-mcp") {
  const handlers = new Map<object, { name: string; cb: (...a: unknown[]) => void }>();
  const app = {
    workspace: {
      on: (name: string, cb: (...a: unknown[]) => void) => { const ref = {}; handlers.set(ref, { name, cb }); return ref; },
      offref: (ref: object) => { handlers.delete(ref); },
      trigger: (name: string, ...a: unknown[]) => { for (const h of handlers.values()) if (h.name === name) h.cb(...a); },
    },
    plugins: { plugins: (vaultMcpApi ? { [hostId]: { api: vaultMcpApi } } : {}) as Record<string, unknown> },
  };
  return { app, handlers };
}

function fakeApi(apiVersion = 1) {
  const calls: Array<{ owner: string; tools: Array<Record<string, unknown>> }> = [];
  let unregistered = 0;
  return {
    calls, unregisteredCount: () => unregistered,
    apiVersion,
    registerTools: (owner: string, tools: Array<Record<string, unknown>>) => { calls.push({ owner, tools }); return () => { unregistered += 1; }; },
  };
}

const plugin = (app: unknown) => ({ app, manifest: { id: "jd-survey" } }) as never;

test("registers immediately when vault-mcp is already loaded; zod shape crosses as JSON Schema", () => {
  const api = fakeApi();
  const { app } = fakeWorld(api);
  publishTools(plugin(app), [{
    name: "survey_slot", description: "d",
    inputSchema: { path: z.string().describe("the path") },
    handler: async () => ({}),
  }]);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].owner, "jd-survey");
  const sent = api.calls[0].tools[0] as { inputSchema: { type: string; properties: { path: { type: string; description: string } }; required: string[] }; annotations: { readOnlyHint: boolean } };
  assert.equal(sent.inputSchema.type, "object");                       // JSON Schema, not zod
  assert.equal(sent.inputSchema.properties.path.type, "string");
  assert.equal(sent.inputSchema.properties.path.description, "the path");
  assert.deepEqual(sent.inputSchema.required, ["path"]);
  assert.equal(sent.annotations.readOnlyHint, false);                  // readOnly omitted ⇒ mutating
});

test("plain JSON Schema input passes through untouched; readOnly maps to readOnlyHint", () => {
  const api = fakeApi();
  const { app } = fakeWorld(api);
  const js = { type: "object" as const, properties: { n: { type: "integer" as const } }, required: ["n"] };
  publishTools(plugin(app), [{ name: "t", description: "d", inputSchema: js, readOnly: true, handler: () => ({}) }]);
  const sent = api.calls[0].tools[0] as { inputSchema: unknown; annotations: { readOnlyHint: boolean } };
  assert.deepEqual(sent.inputSchema, js);
  assert.equal(sent.annotations.readOnlyHint, true);
});

test("property-less JSON Schema passes through, does not hit the zod path", () => {
  const api = fakeApi();
  const { app } = fakeWorld(api);
  const js = { type: "object" as const };
  publishTools(plugin(app), [{ name: "t", description: "d", inputSchema: js, handler: () => ({}) }]);
  const sent = api.calls[0].tools[0] as { inputSchema: unknown };
  assert.deepEqual(sent.inputSchema, js);
});

test("waits for vault-mcp:ready when not loaded; re-registers on reload", () => {
  const api = fakeApi();
  const { app } = fakeWorld(null); // vault-mcp not loaded yet
  publishTools(plugin(app), [{ name: "t", description: "d", handler: () => ({}) }]);
  assert.equal(api.calls.length, 0);
  (app.plugins.plugins as Record<string, unknown>)["vault-mcp"] = { api };
  app.workspace.trigger("vault-mcp:ready", api);
  assert.equal(api.calls.length, 1);
  app.workspace.trigger("vault-mcp:ready", api); // vault-mcp reloaded
  assert.equal(api.calls.length, 2);
  assert.equal(api.unregisteredCount(), 0); // stale unregister dropped, never called
});

test("apiVersion is a FLOOR (#402 step A): a host at 2 registers; a host below 1, or with no number, warns and never registers", () => {
  const newer = fakeApi(2);
  publishTools(plugin(fakeWorld(newer).app), [{ name: "t", description: "d", handler: () => ({}) }]);
  assert.equal(newer.calls.length, 1, "a newer host is at least a v1 host");
  const old = fakeApi(0);
  publishTools(plugin(fakeWorld(old).app), [{ name: "t", description: "d", handler: () => ({}) }]);
  assert.equal(old.calls.length, 0);
  const none = fakeApi();
  delete (none as { apiVersion?: number }).apiVersion; // the fake's default parameter would make undefined a v1 host
  publishTools(plugin(fakeWorld(none).app), [{ name: "t", description: "d", handler: () => ({}) }]);
  assert.equal(none.calls.length, 0, "no version is not a version");
  const str = fakeApi("1" as unknown as number);
  publishTools(plugin(fakeWorld(str).app), [{ name: "t", description: "d", handler: () => ({}) }]);
  assert.equal(str.calls.length, 0, "a string is not a version");
});

test("disposer unregisters and unsubscribes", () => {
  const api = fakeApi();
  const { app, handlers } = fakeWorld(api);
  const dispose = publishTools(plugin(app), [{ name: "t", description: "d", handler: () => ({}) }]);
  assert.equal(handlers.size, 2); // one listener per host ready event
  dispose();
  assert.equal(api.unregisteredCount(), 1);
  assert.equal(handlers.size, 0);
  app.workspace.trigger("vault-mcp:ready", api); // must be inert after dispose
  assert.equal(api.calls.length, 1);
});

test("destructive and idempotent flags pass through as annotation hints", () => {
  const api = fakeApi();
  const { app } = fakeWorld(api);
  publishTools(plugin(app), [{ name: "t", description: "d", destructive: true, idempotent: true, handler: () => ({}) }]);
  const sent = api.calls[0].tools[0] as { annotations: Record<string, boolean> };
  assert.deepEqual(sent.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true });
});

// ── 0.12.0 id migration: the SDK is dual-id ──────────────────────────────────
// The host's plugin id moved `vault-mcp` → `governor` in 0.12.0 while this
// package's npm NAME stayed put (a published contract). So one SDK build must
// find the host under either id and wake on either ready event.

test("finds the host under the new 'governor' id", () => {
  const api = fakeApi();
  const { app } = fakeWorld(api, "governor");
  publishTools(plugin(app), [{ name: "t", description: "d", handler: () => ({}) }]);
  assert.equal(api.calls.length, 1);
});

test("still finds a pre-0.12.0 host under the legacy 'vault-mcp' id", () => {
  const api = fakeApi();
  const { app } = fakeWorld(api, "vault-mcp");
  publishTools(plugin(app), [{ name: "t", description: "d", handler: () => ({}) }]);
  assert.equal(api.calls.length, 1);
});

// THE ORDER FLIPPED AT S3c, and the reason is worth carrying: `governor` is
// the id of a plugin that is no longer a host. It is the governance PROVIDER,
// which exposes no `api` at all, so `getApi` skips it — and on a vault that
// carries BOTH a live pre-split host (`governor`) and a live post-split host
// (`vault-mcp`), only this order binds the newer one.
test("the CURRENT host id wins when a stale pre-split install is also present", () => {
  const fresh = fakeApi();
  const stale = fakeApi();
  const { app } = fakeWorld(fresh, "vault-mcp");
  (app.plugins.plugins as Record<string, unknown>)["governor"] = { api: stale };
  publishTools(plugin(app), [{ name: "t", description: "d", handler: () => ({}) }]);
  assert.equal(fresh.calls.length, 1);
  assert.equal(stale.calls.length, 0);
});

test("a `governor` plugin with NO api is skipped, not treated as a broken host", () => {
  // The ordinary post-split vault: the provider is loaded under that id and
  // exposes nothing. Falling through to `vault-mcp` is what must happen — a
  // publisher that gave up here would silently register no tools on every
  // vault that has the provider installed.
  const host = fakeApi();
  const { app } = fakeWorld(host, "vault-mcp");
  (app.plugins.plugins as Record<string, unknown>)["governor"] = {};
  publishTools(plugin(app), [{ name: "t", description: "d", handler: () => ({}) }]);
  assert.equal(host.calls.length, 1);
});

test("wakes on governor:ready as well as the legacy vault-mcp:ready", () => {
  const api = fakeApi();
  const { app } = fakeWorld(null); // host not loaded yet
  publishTools(plugin(app), [{ name: "t", description: "d", handler: () => ({}) }]);
  assert.equal(api.calls.length, 0);
  (app.plugins.plugins as Record<string, unknown>)["governor"] = { api };
  app.workspace.trigger("governor:ready", api);
  assert.equal(api.calls.length, 1);
});

test("both host events firing on one load is harmless (host replaces by tool name)", () => {
  const api = fakeApi();
  const { app } = fakeWorld(null);
  publishTools(plugin(app), [{ name: "t", description: "d", handler: () => ({}) }]);
  (app.plugins.plugins as Record<string, unknown>)["governor"] = { api };
  // A 0.12.0+ host fires BOTH events on load.
  app.workspace.trigger("governor:ready", api);
  app.workspace.trigger("vault-mcp:ready", api);
  assert.equal(api.calls.length, 2);        // the second replaces the first, by the host's contract
  assert.equal(api.unregisteredCount(), 0); // the superseded disposer is never called
});

test("a host BELOW the floor on the current id does not fall through to a legacy entry", () => {
  const bad = fakeApi(0);
  const good = fakeApi();
  const { app } = fakeWorld(bad, "vault-mcp");
  (app.plugins.plugins as Record<string, unknown>)["governor"] = { api: good };
  publishTools(plugin(app), [{ name: "t", description: "d", handler: () => ({}) }]);
  assert.equal(bad.calls.length, 0);
  assert.equal(good.calls.length, 0);
});

// ── #402 step A: the envelope and the caller context ─────────────────────────

test("partial(): a branded plain object with data and message; the brand is a string key so it crosses bundles", () => {
  const r = partial({ done: 2 }, "one note was unreadable");
  assert.deepEqual(r, { [PARTIAL_BRAND]: "partial", data: { done: 2 }, message: "one note was unreadable" });
  assert.equal(PARTIAL_BRAND, "vault-mcp-api/envelope");
  assert.equal(API_VERSION_MIN, 1);
});

test("partial() refuses a non-object data or a blank message — the shape is the contract", () => {
  assert.throws(() => partial(["a"] as unknown as object, "m"), TypeError);
  assert.throws(() => partial(null as unknown as object, "m"), TypeError);
  assert.throws(() => partial({ a: 1 }, "  "), TypeError);
});

test("isPartial: TOP-LEVEL only — a partial nested inside data is data; a look-alike missing a half is not partial", () => {
  const inner = partial({ x: 1 }, "inner");
  assert.equal(isPartial(inner), true);
  assert.equal(isPartial({ data: { nested: inner }, ok: true }), false, "nested is data");
  assert.equal(isPartial({ [PARTIAL_BRAND]: "partial", data: { x: 1 } }), false, "no message");
  assert.equal(isPartial({ [PARTIAL_BRAND]: "partial", message: "m" }), false, "no data");
  assert.equal(isPartial({ [PARTIAL_BRAND]: "full", data: {}, message: "m" }), false, "wrong brand value");
  // As strict as the constructor: a hand-built envelope partial() would refuse is not partial.
  assert.equal(isPartial({ [PARTIAL_BRAND]: "partial", data: ["a", "b"], message: "m" }), false, "array data is refused by partial(), so the recognizer refuses it too");
  assert.equal(isPartial({ [PARTIAL_BRAND]: "partial", data: {}, message: "   " }), false, "a blank message is refused by partial(), so the recognizer refuses it too");
  assert.equal(isPartial("partial"), false);
  assert.equal(isPartial(null), false);
});

test("a handler receives the caller context as its SECOND argument when the host passes one, and nothing when it does not", async () => {
  const api = fakeApi();
  const { app } = fakeWorld(api);
  const seen: unknown[] = [];
  publishTools(plugin(app), [{ name: "t", description: "d", handler: (args, ctx) => { seen.push(ctx); return { args }; } }]);
  const sent = api.calls[0].tools[0] as { handler: (a: Record<string, unknown>, c?: CallContext) => unknown };
  const ctx: CallContext = { visible: (p) => p, isVisible: () => true, readOnly: false };
  await sent.handler({ a: 1 }, ctx);
  await sent.handler({ a: 2 });
  assert.equal(seen[0], ctx, "a v2 host's context reaches the publisher's handler untouched");
  assert.equal(seen[1], undefined, "a v1 host passes nothing: absence means cannot-tell, never everything-visible");
});

test("the refusal names the rule that failed: not-a-number is not reported as 'below the floor'", () => {
  assert.equal(hostApiRefusal({ apiVersion: 1 }), null);
  assert.equal(hostApiRefusal({ apiVersion: 7 }), null);
  assert.match(hostApiRefusal({ apiVersion: 0 }) ?? "", /below the supported floor 1/);
  assert.match(hostApiRefusal({ apiVersion: Infinity }) ?? "", /not a finite number/);
  assert.match(hostApiRefusal({ apiVersion: NaN }) ?? "", /not a finite number/);
  assert.match(hostApiRefusal({ apiVersion: "1" }) ?? "", /not a finite number/);
  assert.match(hostApiRefusal({}) ?? "", /not a finite number/);
  assert.match(hostApiRefusal(null) ?? "", /not a finite number/);
  const warned: string[] = [];
  const orig = console.warn; console.warn = (m: string) => { warned.push(m); };
  try {
    publishTools(plugin(fakeWorld(fakeApi("1" as unknown as number)).app), [{ name: "t", description: "d", handler: () => ({}) }]);
  } finally { console.warn = orig; }
  assert.match(warned.join("\n"), /not a finite number/, "the console line a darkened satellite emits says the true cause");
  assert.doesNotMatch(warned.join("\n"), /below the supported floor/);
});

// ── apiVersion 3: the write declarations (#550) ──────────────────────────────

const declaring = { name: "assign", description: "d", inputSchema: { path: z.string() }, protection: "key" as const, sync: { kind: "structure" as const, strictStatus: true }, paths: ["path"], handler: () => ({}) };
const plain = { name: "plain", description: "d", handler: () => ({}) };

test("the declarations cross to a v3 host as given; a spec without them carries none of the keys", () => {
  const api = fakeApi(API_VERSION_DECLARATIONS);
  publishTools(plugin(fakeWorld(api).app), [declaring, plain]);
  const [a, p] = api.calls[0].tools;
  assert.equal(a.protection, "key");
  assert.deepEqual(a.sync, { kind: "structure", strictStatus: true });
  assert.deepEqual(a.paths, ["path"]);
  assert.equal("protection" in p || "sync" in p || "paths" in p, false);
});

test("fail closed below apiVersion 3: a declaring tool is left out (with one warning), the others register", () => {
  const api = fakeApi(2);
  const warned: unknown[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
  try {
    publishTools(plugin(fakeWorld(api).app), [declaring, plain]);
  } finally {
    console.warn = orig;
  }
  assert.deepEqual(api.calls[0].tools.map((t) => t.name), ["plain"]);
  assert.equal(warned.length, 1);
  assert.match(String(warned[0]), /cannot enforce write declarations \(needs 3\).*assign/);
});

test("declaresWrites and specsForHost", () => {
  assert.equal(declaresWrites({}), false);
  assert.equal(declaresWrites({ paths: [] }), true, "an explicit empty paths list is a declaration");
  assert.equal(declaresWrites({ protection: "exempt" }), true);
  const specs = [{ ...plain, protection: "exempt" as const }, plain];
  assert.equal(specsForHost({ apiVersion: 3 }, specs).length, 2);
  assert.equal(specsForHost({ apiVersion: 7 }, specs).length, 2, "a floor, as for the version itself");
  const orig = console.warn;
  console.warn = () => {};
  try {
    assert.equal(specsForHost({ apiVersion: 2 }, specs).length, 1);
  } finally {
    console.warn = orig;
  }
});
