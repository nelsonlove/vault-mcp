/**
 * The remote front's connection profile (#521), and the MCP_RESOURCE_URL-derived paths for the
 * Funnel road (00.02).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type express from "express";
import { buildFront, endpointPaths, prmPaths } from "../front.js";
import { resourceMetadataUrl, loadAuthConfig, type AuthConfig } from "../auth.js";
import { loadProfileMap, profileFor } from "../profiles.js";
import { bridgeEnv, PROFILE_ENV_KEY } from "../bridge-env.js";
import { createLiveProxy } from "../live-proxy.js";

const TOKEN = "test-static-secret-tok";
const cfg = (resourceUrl = ""): AuthConfig => ({ enabled: false, resourceUrl, issuer: "", jwksUri: "", authorizationServers: [], scopesSupported: [] });

/** A handler that answers with the profile the front chose. */
const spy = () => ({
  calls: 0,
  async handle(_req: express.Request, res: express.Response) {
    this.calls++;
    res.status(200).json({ profile: res.locals.vaultMcpProfile ?? null });
  },
});

async function serve(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers }, body: JSON.stringify(body) });

describe("the profile mapping", () => {
  test("unset: every credential gets full; set: a credential with no entry is refused", () => {
    const none = loadProfileMap({});
    assert.equal(none.configured, false);
    assert.equal(profileFor(none, "token"), "full");
    assert.equal(profileFor(none, undefined), "full");
    const m = loadProfileMap({ VAULT_MCP_PROFILES: '{"token":"read","sub:user_1":"read+inbox"}' });
    assert.equal(profileFor(m, "token"), "read");
    assert.equal(profileFor(m, "sub:user_1"), "read+inbox");
    assert.equal(profileFor(m, "sub:user_2"), null);
    assert.equal(profileFor(m, undefined), null);
  });

  test("a value that does not parse, a bad key or an unknown profile throws (the front refuses to start)", () => {
    assert.throws(() => loadProfileMap({ VAULT_MCP_PROFILES: "{" }), /not valid JSON/);
    assert.throws(() => loadProfileMap({ VAULT_MCP_PROFILES: "[]" }), /JSON object/);
    assert.throws(() => loadProfileMap({ VAULT_MCP_PROFILES: '{"email:a@b":"read"}' }), /credential id/);
    assert.throws(() => loadProfileMap({ VAULT_MCP_PROFILES: '{"token":"admin"}' }), /unknown profile/);
  });

  test("the bridge gets the session's profile, never the front's own variable; full sends none", () => {
    assert.equal(bridgeEnv({ VAULT_MCP_PROFILE: "read" })[PROFILE_ENV_KEY], undefined);
    assert.equal(bridgeEnv({}, { profile: "read" })[PROFILE_ENV_KEY], "read");
    assert.equal(bridgeEnv({ VAULT_MCP_PROFILE: "read" }, { profile: "full" })[PROFILE_ENV_KEY], undefined);
  });
});

describe("the front applies the profile", () => {
  test("no mapping: the static token gets full (today's behaviour)", async () => {
    const fs = spy();
    const s = await serve(buildFront({ cfg: cfg(), token: TOKEN, presence: { isLive: () => false }, fs, live: spy() }));
    const r = await post(`${s.url}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { profile: "full" });
    await s.close();
  });

  test("a mapping: the token gets its profile; with no entry for it, 403 and the handler never runs", async () => {
    const fs = spy();
    let s = await serve(buildFront({ cfg: cfg(), token: TOKEN, presence: { isLive: () => false }, fs, live: spy(), profiles: loadProfileMap({ VAULT_MCP_PROFILES: '{"token":"read"}' }) }));
    let r = await post(`${s.url}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.deepEqual(await r.json(), { profile: "read" });
    await s.close();
    fs.calls = 0;
    s = await serve(buildFront({ cfg: cfg(), token: TOKEN, presence: { isLive: () => false }, fs, live: spy(), profiles: loadProfileMap({ VAULT_MCP_PROFILES: '{"sub:someone":"read"}' }) }));
    r = await post(`${s.url}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(r.status, 403);
    assert.equal(fs.calls, 0);
    await s.close();
  });

  test("a live session opened under full is not usable under read (404)", async () => {
    const live = createLiveProxy({ bridgePath: "/nonexistent" });
    const stub = { sessionId: "S1", async send() {}, async close() {}, async start() {}, async handleRequest(_q: unknown, res: express.Response) { res.status(200).json({ ok: true }); } };
    live._registerSessionForTest("S1", stub, { async send() {}, async close() {}, async start() {} }, "full");
    const mk = (map: string) => buildFront({ cfg: cfg(), token: TOKEN, presence: { isLive: () => true }, fs: spy(), live, profiles: loadProfileMap({ VAULT_MCP_PROFILES: map }) });
    let s = await serve(mk('{"token":"read"}'));
    let r = await post(`${s.url}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-session-id": "S1" });
    assert.equal(r.status, 404);
    await s.close();
    s = await serve(mk('{"token":"full"}'));
    r = await post(`${s.url}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-session-id": "S1" });
    assert.equal(r.status, 200);
    await s.close();
    live.stop();
  });
});

describe("paths from MCP_RESOURCE_URL (Funnel at /vault-mcp)", () => {
  const RES = "https://host.example.ts.net/vault-mcp/mcp";

  test("derived, not hard-coded", () => {
    assert.deepEqual(endpointPaths(RES), { resourcePath: "/vault-mcp/mcp", mount: "/vault-mcp", mcp: ["/mcp", "/vault-mcp/mcp"] });
    assert.deepEqual(endpointPaths("https://h.example/mcp").mcp, ["/mcp"]);
    assert.deepEqual(endpointPaths("").mcp, ["/mcp"]);
    const p = prmPaths(RES);
    for (const x of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource/vault-mcp/mcp",
      "/vault-mcp/.well-known/oauth-protected-resource",
      "/vault-mcp/.well-known/oauth-protected-resource/vault-mcp/mcp",
    ]) assert.ok(p.includes(x), x);
  });

  test("the WWW-Authenticate resource_metadata URL is the RFC 9728 form for the resource", () => {
    assert.equal(resourceMetadataUrl(cfg(RES)), "https://host.example.ts.net/.well-known/oauth-protected-resource/vault-mcp/mcp");
    assert.equal(resourceMetadataUrl(cfg("https://h.example/mcp")), "https://h.example/.well-known/oauth-protected-resource/mcp");
  });

  test("the endpoint answers on /mcp and on the resource path; the metadata on the suffixed path", async () => {
    const c: AuthConfig = { ...cfg(RES), enabled: true, issuer: "https://issuer.example", jwksUri: "https://issuer.example/jwks", authorizationServers: ["https://issuer.example"] };
    const s = await serve(buildFront({ cfg: c, token: TOKEN, presence: { isLive: () => false }, fs: spy(), live: spy() }));
    for (const p of ["/mcp", "/vault-mcp/mcp"]) {
      const r = await post(`${s.url}${p}`, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      assert.equal(r.status, 200, p);
    }
    for (const p of ["/.well-known/oauth-protected-resource/vault-mcp/mcp", "/vault-mcp/.well-known/oauth-protected-resource/vault-mcp/mcp"]) {
      const r = await fetch(`${s.url}${p}`);
      assert.equal(r.status, 200, p);
      assert.equal(((await r.json()) as { resource: string }).resource, RES);
    }
    const un = await fetch(`${s.url}/vault-mcp/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(un.status, 401);
    assert.match(un.headers.get("www-authenticate") ?? "", /oauth-protected-resource\/vault-mcp\/mcp/);
    await s.close();
  });
});

describe("VAULT_MCP_PRM_UNDER_RESOURCE: the metadata inside the one published path (Funnel at /mcp)", () => {
  const RES1 = "https://host.example.ts.net/mcp";
  const on = (r: string): AuthConfig => ({ ...cfg(r), enabled: true, issuer: "https://issuer.example", jwksUri: "https://issuer.example/jwks", authorizationServers: ["https://issuer.example"], prmUnderResource: true });

  test("off by default: the root RFC 9728 form, and no path inside /mcp", () => {
    assert.equal(resourceMetadataUrl(cfg(RES1)), "https://host.example.ts.net/.well-known/oauth-protected-resource/mcp");
    assert.equal(prmPaths(RES1).includes("/mcp/.well-known/oauth-protected-resource"), false);
  });

  test("on: resource_metadata names the URL inside the resource path, and it is served there", async () => {
    assert.equal(resourceMetadataUrl(on(RES1)), "https://host.example.ts.net/mcp/.well-known/oauth-protected-resource");
    assert.equal(resourceMetadataUrl(on("https://h.example/vault-mcp/mcp/")), "https://h.example/vault-mcp/mcp/.well-known/oauth-protected-resource");
    assert.ok(prmPaths(RES1, true).includes("/mcp/.well-known/oauth-protected-resource"));
    assert.equal(resourceMetadataUrl(on("https://h.example/mcp?x=1#f")), "https://h.example/mcp/.well-known/oauth-protected-resource");
    const s = await serve(buildFront({ cfg: on(RES1), token: TOKEN, presence: { isLive: () => false }, fs: spy(), live: spy() }));
    const r = await fetch(`${s.url}/mcp/.well-known/oauth-protected-resource`);
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { resource: string }).resource, RES1);
    const un = await fetch(`${s.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(un.status, 401);
    assert.match(un.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/host\.example\.ts\.net\/mcp\/\.well-known\/oauth-protected-resource"/);
    await s.close();
  });

  test("the env switch: read from VAULT_MCP_PRM_UNDER_RESOURCE, and refused without MCP_RESOURCE_URL", () => {
    const keep = { ...process.env };
    try {
      process.env.AUTH_ENABLED = "false";
      process.env.MCP_RESOURCE_URL = RES1;
      process.env.VAULT_MCP_PRM_UNDER_RESOURCE = "true";
      assert.equal(loadAuthConfig().prmUnderResource, true);
      delete process.env.VAULT_MCP_PRM_UNDER_RESOURCE;
      assert.equal(loadAuthConfig().prmUnderResource, false);
      process.env.VAULT_MCP_PRM_UNDER_RESOURCE = "1";
      delete process.env.MCP_RESOURCE_URL;
      assert.throws(() => loadAuthConfig(), /MCP_RESOURCE_URL/);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
      Object.assign(process.env, keep);
    }
  });
});

