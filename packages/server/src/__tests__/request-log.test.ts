/** The request log on /mcp (#521, the Funnel road of 00.02). */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type express from "express";
import { buildFront } from "../front.js";
import type { AuthConfig } from "../auth.js";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProfileMap } from "../profiles.js";
import { createLogWriter, loadRequestLogConfig, rpcSummary } from "../request-log.js";

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

describe("the request log", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vmcp-reqlog-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("the default file is under XDG state; off is off", () => {
    assert.equal(loadRequestLogConfig({ XDG_STATE_HOME: "/st" }).file, "/st/vault-mcp-remote/requests.jsonl");
    assert.equal(loadRequestLogConfig({ VAULT_MCP_REQUEST_LOG: "off" }).file, null);
  });

  test("rpc and tool names only — never arguments", () => {
    assert.deepEqual(rpcSummary({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "obsidian_read_note", arguments: { path: "secret.md" } } }), { rpc: "tools/call", tool: "obsidian_read_note" });
    assert.deepEqual(rpcSummary([{ method: "tools/list" }, { method: "tools/call", params: { name: "x y" } }]), { rpc: ["tools/list", "tools/call"], tool: ["x?y"] });
    assert.deepEqual(rpcSummary(undefined), {});
  });

  test("one line per request: shape, credential id not the token, refusals logged, no arguments", async () => {
    const lines: string[] = [];
    const s = await serve(buildFront({ cfg: cfg(), token: TOKEN, presence: { isLive: () => false }, fs: spy(), live: spy(), logWrite: (l) => lines.push(l), profiles: loadProfileMap({ VAULT_MCP_PROFILES: '{"token":"read"}' }) }));
    await post(`${s.url}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "obsidian_read_note", arguments: { path: "secret.md" } } });
    await post(`${s.url}/mcp`, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { authorization: "Bearer nope" });
    await new Promise((r) => setTimeout(r, 20));
    await s.close();
    assert.equal(lines.length, 2);
    const a = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(a).sort(), ["credential", "http", "ip", "ms", "profile", "rpc", "status", "time", "tool"]);
    assert.equal(a.credential, "token");
    assert.equal(a.profile, "read");
    assert.equal(a.tool, "obsidian_read_note");
    assert.equal(a.status, 200);
    assert.equal(typeof a.ms, "number");
    const b = JSON.parse(lines[1]);
    assert.equal(b.status, 401);
    assert.equal(b.credential, null);
    for (const l of lines) {
      assert.ok(!l.includes(TOKEN), "never the token");
      assert.ok(!l.includes("secret.md"), "never an argument");
    }
  });

  test("the file rotates at the cap and keeps three", () => {
    const file = path.join(dir, "sub", "requests.jsonl");
    const w = createLogWriter({ file, maxBytes: 50 });
    for (let i = 0; i < 6; i++) w(JSON.stringify({ i, pad: "x".repeat(20) }));
    assert.ok(existsSync(file));
    assert.ok(existsSync(`${file}.1`) && existsSync(`${file}.3`));
    assert.ok(!existsSync(`${file}.4`));
    assert.equal(JSON.parse(readFileSync(file, "utf8").trim()).i, 5);
    writeFileSync(file, "");
  });
});
