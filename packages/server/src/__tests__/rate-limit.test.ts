/** The rate limit on /mcp (#521, the Funnel road of 00.02). */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type express from "express";
import { buildFront } from "../front.js";
import type { AuthConfig } from "../auth.js";
import { parseTrustProxy } from "../front.js";
import { createWindowCounter, loadRateLimitConfig } from "../rate-limit.js";

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

describe("the rate limit", () => {
  test("a fixed window per key, with the seconds to its end", () => {
    let t = 1_000_000;
    const c = createWindowCounter(2, () => t);
    assert.equal(c.hit("a"), null);
    assert.equal(c.hit("a"), null);
    assert.equal(c.hit("a"), 60);
    assert.equal(c.hit("b"), null, "another key has its own window");
    t += 30_000;
    assert.equal(c.hit("a"), 30);
    t += 30_000;
    assert.equal(c.hit("a"), null, "a new window");
    assert.equal(createWindowCounter(0).hit("x"), null, "0 is off");
  });

  test("config from env, with defaults; a bad value keeps the default", () => {
    assert.deepEqual(loadRateLimitConfig({}), { ipPerMin: 300, credPerMin: 120 });
    assert.deepEqual(loadRateLimitConfig({ VAULT_MCP_RATE_IP_PER_MIN: "0", VAULT_MCP_RATE_CRED_PER_MIN: "x" }), { ipPerMin: 0, credPerMin: 120 });
  });

  test("on /mcp: 429 with Retry-After, per credential and per IP (the IP limit before auth)", async () => {
    let s = await serve(buildFront({ cfg: cfg(), token: TOKEN, presence: { isLive: () => false }, fs: spy(), live: spy(), rateLimits: { ipPerMin: 0, credPerMin: 2 } }));
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    assert.equal((await post(`${s.url}/mcp`, body)).status, 200);
    assert.equal((await post(`${s.url}/mcp`, body)).status, 200);
    const r = await post(`${s.url}/mcp`, body);
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) >= 1);
    await s.close();
    s = await serve(buildFront({ cfg: cfg(), token: TOKEN, presence: { isLive: () => false }, fs: spy(), live: spy(), rateLimits: { ipPerMin: 1, credPerMin: 0 } }));
    assert.equal((await post(`${s.url}/mcp`, body, { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await post(`${s.url}/mcp`, body)).status, 429, "the bad guess used the IP's budget");
    await s.close();
  });

  test("VAULT_MCP_TRUST_PROXY parses", () => {
    assert.equal(parseTrustProxy("true"), true);
    assert.equal(parseTrustProxy("false"), false);
    assert.equal(parseTrustProxy("1"), 1);
    assert.equal(parseTrustProxy("loopback"), "loopback");
  });
});

